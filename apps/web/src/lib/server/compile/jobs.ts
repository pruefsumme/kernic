import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { projectArtifactsDir, projectTreeDir } from '../config';
import { sql } from '../db/client';
import { isUuid } from '../projects/projects';
import { compileProject } from './compile-project';
import {
	SnapshotChangedError,
	WorkerUnavailableError,
	type Diagnostic,
	type OutputFormat,
	type WorkerArtifact
} from './worker-client';

/**
 * Compile jobs. A request inserts a durable `queued` row and returns at once;
 * an in-process dispatcher takes a snapshot of the project, sends it to the
 * isolated worker and stores the result. Job state lives in PostgreSQL, so a
 * broker such as BullMQ can replace the dispatcher without changing callers.
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'errored';

export interface CompileJob {
	id: string;
	projectId: string;
	format: OutputFormat;
	status: JobStatus;
	/** Project revision the snapshot was taken at. */
	revision: number | null;
	sourceHash: string | null;
	diagnostics: Diagnostic[];
	pageCount: number | null;
	/** Rendered pages of a successful preview job, in order. */
	pages: RenderedPage[] | null;
	typstVersion: string | null;
	durationMs: number | null;
	/** Infrastructure problem, shown when status is `errored`. */
	error: string | null;
	createdAt: Date;
	finishedAt: Date | null;
}

export interface RenderedPage {
	/** SHA-256 of the page's SVG; also its address in the page store. */
	hash: string;
	/** Page size in points, so the preview can lay pages out before they load. */
	width: number;
	height: number;
}

interface JobRow {
	id: string;
	project_id: string;
	format: OutputFormat;
	status: JobStatus;
	revision: number | null;
	source_hash: string | null;
	diagnostics: Diagnostic[];
	page_count: number | null;
	pages: RenderedPage[] | null;
	typst_version: string | null;
	duration_ms: number | null;
	error: string | null;
	created_at: Date;
	finished_at: Date | null;
}

function toJob(row: JobRow): CompileJob {
	return {
		id: row.id,
		projectId: row.project_id,
		format: row.format,
		status: row.status,
		revision: row.revision,
		sourceHash: row.source_hash,
		diagnostics: row.diagnostics,
		pageCount: row.page_count,
		pages: row.pages,
		typstVersion: row.typst_version,
		durationMs: row.duration_ms,
		error: row.error,
		createdAt: row.created_at,
		finishedAt: row.finished_at
	};
}

export function isFinished(job: CompileJob): boolean {
	return job.status === 'succeeded' || job.status === 'failed' || job.status === 'errored';
}

const MAX_CONCURRENT_JOBS = 2;
/** Finished jobs kept per project and format; older ones and their files are removed. */
const KEEP_FINISHED_JOBS = 3;
const POLL_INTERVAL_MS = 5_000;
const PAGE_GRACE_MS = 5 * 60_000;

const finished = new EventEmitter();
finished.setMaxListeners(0);

let running = 0;
let started = false;

/**
 * Queues a compile of the project's current files. Preview requests coalesce:
 * a job that has not started yet will pick up the latest files anyway, so it is
 * returned instead of queueing another.
 */
export async function requestCompile(input: {
	projectId: string;
	userId: string;
	format: OutputFormat;
}): Promise<CompileJob> {
	const [pending] = await sql<JobRow[]>`
		SELECT * FROM compile_jobs
		WHERE project_id = ${input.projectId} AND format = ${input.format} AND status = 'queued'
		ORDER BY created_at
		LIMIT 1
	`;
	if (pending) {
		dispatch();
		return toJob(pending);
	}

	const [row] = await sql<JobRow[]>`
		INSERT INTO compile_jobs (project_id, requested_by, format, status)
		VALUES (${input.projectId}, ${input.userId}, ${input.format}, 'queued')
		RETURNING *
	`;
	dispatch();
	return toJob(row!);
}

export async function getJob(projectId: string, jobId: string): Promise<CompileJob | null> {
	if (!isUuid(jobId)) return null;
	const [row] = await sql<JobRow[]>`
		SELECT * FROM compile_jobs WHERE id = ${jobId} AND project_id = ${projectId}
	`;
	return row ? toJob(row) : null;
}

/** Resolves when the job finishes, or with its current state after `timeoutMs`. */
export async function waitForJob(
	projectId: string,
	jobId: string,
	timeoutMs: number
): Promise<CompileJob | null> {
	let wake: () => void = () => {};
	const signalled = new Promise<void>((resolve) => (wake = resolve));
	// Subscribe before reading, so a job finishing in between is not missed.
	finished.once(jobId, wake);
	const timer = setTimeout(wake, timeoutMs);

	try {
		const job = await getJob(projectId, jobId);
		if (!job || isFinished(job)) return job;
		await signalled;
		return await getJob(projectId, jobId);
	} finally {
		clearTimeout(timer);
		finished.off(jobId, wake);
	}
}

/** Most recent successful job of a format, if its output is still stored. */
export async function latestSuccessfulJob(
	projectId: string,
	format: OutputFormat
): Promise<CompileJob | null> {
	const [row] = await sql<JobRow[]>`
		SELECT * FROM compile_jobs
		WHERE project_id = ${projectId} AND format = ${format} AND status = 'succeeded'
		ORDER BY finished_at DESC
		LIMIT 1
	`;
	return row ? toJob(row) : null;
}

export function jobArtifactsDir(projectId: string, jobId: string): string {
	return path.join(projectArtifactsDir(projectId), jobId);
}

const pageStoreDir = (projectId: string) => path.join(projectArtifactsDir(projectId), 'pages');

const PAGE_HASH = /^[0-9a-f]{64}$/;

/** Absolute path of a rendered page in the project's page store, or null for an invalid hash. */
export function pagePath(projectId: string, hash: string): string | null {
	return PAGE_HASH.test(hash) ? path.join(pageStoreDir(projectId), `${hash}.svg`) : null;
}

export function pdfArtifactPath(job: CompileJob): string | null {
	if (job.format !== 'pdf' || job.status !== 'succeeded') return null;
	return path.join(jobArtifactsDir(job.projectId, job.id), 'output.pdf');
}

/**
 * Starts the dispatcher. Jobs that were running when the previous process
 * stopped can never complete, so they are closed; queued jobs are picked up.
 */
export async function startJobDispatcher(): Promise<void> {
	if (started) return;
	started = true;

	await sql`
		UPDATE compile_jobs
		SET status = 'errored', error = 'The server restarted while this was compiling.', finished_at = now()
		WHERE status = 'running'
	`;

	// Safety net in case a wake-up is missed; the common path is the direct call in requestCompile.
	setInterval(dispatch, POLL_INTERVAL_MS).unref();
	dispatch();
}

function dispatch(): void {
	if (running >= MAX_CONCURRENT_JOBS) return;
	running++;
	void runNext()
		.catch((error) => {
			console.error('compile dispatcher failed', error);
			return false;
		})
		.then((ranJob) => {
			running--;
			// Keep draining while there is work; otherwise wait for the next request.
			if (ranJob) dispatch();
		});
}

/** Claims and runs one queued job. Returns false when the queue is empty. */
async function runNext(): Promise<boolean> {
	const [claimed] = await sql<JobRow[]>`
		UPDATE compile_jobs
		SET status = 'running', started_at = now()
		WHERE id = (
			SELECT id FROM compile_jobs
			WHERE status = 'queued'
			ORDER BY created_at
			LIMIT 1
			FOR UPDATE SKIP LOCKED
		)
		RETURNING *
	`;
	if (!claimed) return false;

	// Let a second slot start on the remaining queue while this job compiles.
	dispatch();

	const job = toJob(claimed);
	try {
		await runJob(job);
	} catch (error) {
		const expected =
			error instanceof WorkerUnavailableError || error instanceof SnapshotChangedError;
		const message = expected ? error.message : 'An unexpected error occurred while compiling.';
		if (!expected) console.error('compile job failed', error);
		await sql`
			UPDATE compile_jobs
			SET status = 'errored', error = ${message}, finished_at = now()
			WHERE id = ${job.id}
		`;
	}
	finished.emit(job.id);
	return true;
}

async function runJob(job: CompileJob): Promise<void> {
	// Read the revision before the snapshot: if files change in between, the job
	// is attributed to the older revision and the client simply compiles again.
	const [project] = await sql<{ entry_path: string; revision: number }[]>`
		SELECT entry_path, revision FROM projects WHERE id = ${job.projectId}
	`;
	if (!project) return;

	const root = projectTreeDir(job.projectId);
	try {
		await fs.access(path.join(root, ...project.entry_path.split('/')));
	} catch {
		await finishJob(job, {
			status: 'failed',
			diagnostics: [
				{
					severity: 'error',
					message: `The main file "${project.entry_path}" does not exist. Choose another main file in the project settings.`,
					path: null,
					line: null,
					column: null
				}
			]
		});
		return;
	}

	// After a small edit most pages of a long document are unchanged. Telling the
	// worker which pages are stored already saves sending them back.
	const knownPages = job.format === 'svg' ? await storedPageHashes(job.projectId) : [];
	// Previews of one project share a compiler that stays running in the worker.
	const session = job.format === 'svg' ? job.projectId : undefined;
	let compiled = await compileProject(root, project.entry_path, job.format, {
		knownPages,
		session
	});

	let pages: RenderedPage[] | null = null;
	if (compiled.result.ok && job.format === 'svg') {
		try {
			pages = await storePages(job.projectId, compiled.result.artifacts, new Set(knownPages));
		} catch (error) {
			if (!(error instanceof PageMissingError)) throw error;
			// A page counted as stored was cleaned up meanwhile: ask for every page.
			compiled = await compileProject(root, project.entry_path, job.format, { session });
			pages = compiled.result.ok
				? await storePages(job.projectId, compiled.result.artifacts, new Set())
				: null;
		}
	} else if (compiled.result.ok) {
		const pdf = compiled.result.artifacts[0]?.data;
		if (!pdf) throw new WorkerUnavailableError('The compile worker returned no PDF.');
		const directory = jobArtifactsDir(job.projectId, job.id);
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(path.join(directory, 'output.pdf'), Buffer.from(pdf, 'base64'));
	}

	const { snapshot, result } = compiled;
	await sql`
		UPDATE compile_jobs
		SET revision = ${project.revision}, source_hash = ${snapshot.sourceHash},
			entry_path = ${project.entry_path}
		WHERE id = ${job.id}
	`;

	await finishJob(job, {
		status: result.ok ? 'succeeded' : 'failed',
		diagnostics: result.diagnostics,
		pages,
		typstVersion: result.typstVersion,
		durationMs: result.durationMs
	});
	await pruneJobs(job.projectId, job.format);
}

const SVG_SIZE = /<svg[^>]*\swidth="([\d.]+)pt"\s+height="([\d.]+)pt"/;
/** A4 in points, should a future Typst change the header the size is read from. */
const FALLBACK_PAGE = { width: 595.28, height: 841.89 };
/** More stored pages than this are not worth listing to the worker. */
const MAX_KNOWN_PAGES = 5000;

/** A page the worker was told is stored here no longer is. */
class PageMissingError extends Error {}

async function storedPageHashes(projectId: string): Promise<string[]> {
	const names = await fs.readdir(pageStoreDir(projectId)).catch(() => []);
	return names
		.filter((name) => name.endsWith('.svg') && PAGE_HASH.test(name.slice(0, -4)))
		.map((name) => name.slice(0, -4))
		.slice(0, MAX_KNOWN_PAGES);
}

const pageDimension = (value: unknown, fallback: number) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100_000
		? value
		: fallback;

/**
 * Stores pages by content hash. A page that is identical to one already stored
 * (most pages, between two compiles of a long document) costs nothing, and the
 * worker does not even send it: such a page arrives as a hash without content.
 */
async function storePages(
	projectId: string,
	artifacts: WorkerArtifact[],
	knownPages: Set<string>
): Promise<RenderedPage[]> {
	const directory = pageStoreDir(projectId);
	await fs.mkdir(directory, { recursive: true });

	const pages: RenderedPage[] = [];
	for (const artifact of artifacts) {
		const now = new Date();

		if (artifact.data === null) {
			// Only hashes this server listed are accepted without content.
			if (!knownPages.has(artifact.sha256)) {
				throw new WorkerUnavailableError('The compile worker left out a page it had to send.');
			}
			try {
				// Mark a reused page as fresh, which keeps it out of a concurrent clean-up.
				await fs.utimes(path.join(directory, `${artifact.sha256}.svg`), now, now);
			} catch {
				throw new PageMissingError();
			}
			pages.push({
				hash: artifact.sha256,
				width: pageDimension(artifact.width, FALLBACK_PAGE.width),
				height: pageDimension(artifact.height, FALLBACK_PAGE.height)
			});
			continue;
		}

		// The address is computed here, not taken from the worker, so a stored
		// page always is what its name says.
		const svg = Buffer.from(artifact.data, 'base64');
		const hash = createHash('sha256').update(svg).digest('hex');
		const target = path.join(directory, `${hash}.svg`);
		try {
			await fs.utimes(target, now, now);
		} catch {
			// Write beside the final name and rename, so a reader never sees half a page.
			const temporary = `${target}.${randomUUID()}.tmp`;
			await fs.writeFile(temporary, svg);
			await fs.rename(temporary, target);
		}

		const size = SVG_SIZE.exec(svg.subarray(0, 512).toString('latin1'));
		pages.push({
			hash,
			width: Number(size?.[1] ?? FALLBACK_PAGE.width),
			height: Number(size?.[2] ?? FALLBACK_PAGE.height)
		});
	}
	return pages;
}

async function finishJob(
	job: CompileJob,
	outcome: {
		status: 'succeeded' | 'failed';
		diagnostics: Diagnostic[];
		pages?: RenderedPage[] | null;
		typstVersion?: string;
		durationMs?: number;
	}
): Promise<void> {
	await sql`
		UPDATE compile_jobs
		SET status = ${outcome.status},
			diagnostics = ${sql.json(outcome.diagnostics as never)},
			page_count = ${outcome.pages?.length ?? null},
			pages = ${outcome.pages ? sql.json(outcome.pages as never) : null},
			typst_version = ${outcome.typstVersion ?? null},
			duration_ms = ${outcome.durationMs ?? null},
			finished_at = now()
		WHERE id = ${job.id}
	`;
}

async function pruneJobs(projectId: string, format: OutputFormat): Promise<void> {
	// The newest successful render is always kept, however many failed attempts
	// follow it, so the preview can keep showing the last good pages.
	const stale = await sql<{ id: string }[]>`
		DELETE FROM compile_jobs
		WHERE id IN (
			SELECT id FROM compile_jobs
			WHERE project_id = ${projectId} AND format = ${format}
				AND status IN ('succeeded', 'failed', 'errored')
			ORDER BY created_at DESC
			OFFSET ${KEEP_FINISHED_JOBS}
		)
		AND id IS DISTINCT FROM (
			SELECT id FROM compile_jobs
			WHERE project_id = ${projectId} AND format = ${format} AND status = 'succeeded'
			ORDER BY finished_at DESC
			LIMIT 1
		)
		RETURNING id
	`;
	for (const { id } of stale) {
		await fs.rm(jobArtifactsDir(projectId, id), { recursive: true, force: true });
	}
	if (format === 'svg') await prunePages(projectId);
}

/** Removes stored pages that no remaining job refers to. */
async function prunePages(projectId: string): Promise<void> {
	const rows = await sql<{ hash: string }[]>`
		SELECT DISTINCT page->>'hash' AS hash
		FROM compile_jobs, jsonb_array_elements(pages) AS page
		WHERE project_id = ${projectId} AND pages IS NOT NULL
	`;
	const referenced = new Set(rows.map((row) => `${row.hash}.svg`));

	// Pages written or reused in the last minutes may belong to a compile that
	// has stored them but not yet recorded its result.
	const cutoff = Date.now() - PAGE_GRACE_MS;
	const directory = pageStoreDir(projectId);
	for (const name of await fs.readdir(directory).catch(() => [])) {
		if (!name.endsWith('.svg') || referenced.has(name)) continue;
		const file = path.join(directory, name);
		const info = await fs.stat(file).catch(() => null);
		if (info && info.mtimeMs < cutoff) await fs.rm(file, { force: true });
	}
}
