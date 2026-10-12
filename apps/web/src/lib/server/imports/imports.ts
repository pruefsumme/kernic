import { error } from '@sveltejs/kit';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { QueueFullError, requestCompile } from '../compile/jobs';
import { compileProject } from '../compile/compile-project';
import { WorkerUnavailableError, type Diagnostic } from '../compile/worker-client';
import { importDir, projectDir, projectTreeDir, treeLimits } from '../config';
import { sql } from '../db/client';
import { looksLikeText } from '../projects/content-types';
import {
	assertWorkspaceRoom,
	insertProject,
	isUuid,
	measureProject,
	validateProjectName,
	WorkspaceLimitError,
	type Project
} from '../projects/projects';
import { ArchiveError, extractArchive, type SkippedEntry } from './archive';
import { analyzeSources, guessEntryFile, type MissingReference, type PackageUse } from './scan';

/**
 * Importing an existing project from a ZIP archive, in two steps.
 *
 * 1. Dry run: the archive is unpacked into a staging directory, scanned for
 *    packages and missing files, and compiled once. Nothing is created yet.
 * 2. The user reads the report and confirms; only then does the staged tree
 *    become a project. Cancelling removes the staged files.
 *
 * The uploaded archive itself is never modified, and no existing project is
 * touched by an import.
 */

export interface ImportReport {
	fileCount: number;
	totalBytes: number;
	strippedFolder: string | null;
	typstFiles: string[];
	suggestedEntry: string;
	suggestedName: string;
	skipped: SkippedEntry[];
	skippedCount: number;
	packages: (PackageUse & {
		/** Whether this server can provide the package; `unknown` if the dry run could not run. */
		status: 'available' | 'unavailable' | 'unknown';
		reason: string | null;
	})[];
	missing: MissingReference[];
	/** Font files that come with the project and will be available to it. */
	fontFiles: string[];
	compile:
		| { status: 'ok'; pageCount: number; diagnostics: Diagnostic[] }
		| { status: 'failed'; diagnostics: Diagnostic[] }
		| { status: 'unavailable'; message: string };
}

export interface ProjectImport {
	id: string;
	workspaceId: string;
	sourceName: string;
	status: 'analyzing' | 'ready' | 'rejected' | 'imported';
	report: ImportReport | null;
	error: string | null;
	projectId: string | null;
}

interface ImportRow {
	id: string;
	workspace_id: string;
	source_name: string;
	status: ProjectImport['status'];
	report: ImportReport | null;
	error: string | null;
	project_id: string | null;
}

const toImport = (row: ImportRow): ProjectImport => ({
	id: row.id,
	workspaceId: row.workspace_id,
	sourceName: row.source_name,
	status: row.status,
	report: row.report,
	error: row.error,
	projectId: row.project_id
});

const STAGED_LIFETIME_HOURS = 24;
const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

const stagedTree = (importId: string) => path.join(importDir(importId), 'tree');
export const previewPath = (importId: string) => path.join(importDir(importId), 'preview.svg');

/** Largest archive accepted for upload; unpacked size is checked separately. */
export const maxArchiveBytes = treeLimits.maxProjectBytes;

/**
 * Stores an uploaded archive and starts analysing it in the background.
 * Returns as soon as the upload is on disk.
 */
export async function startImport(input: {
	userId: string;
	workspaceId: string;
	sourceName: string;
	body: ReadableStream<Uint8Array>;
}): Promise<string> {
	// The name is only displayed; drop control characters and cap its length.
	const printable = [...input.sourceName].filter((character) => character >= ' ').join('');
	const sourceName = printable.slice(0, 200) || 'archive.zip';
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO project_imports (user_id, workspace_id, source_name, status)
		VALUES (${input.userId}, ${input.workspaceId}, ${sourceName}, 'analyzing')
		RETURNING id
	`;
	const importId = row!.id;
	const zipPath = path.join(importDir(importId), 'upload.zip');

	let received = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			received += chunk.length;
			callback(received > maxArchiveBytes ? new Error('too-large') : null, chunk);
		}
	});

	try {
		await fs.mkdir(importDir(importId), { recursive: true });
		await pipeline(Readable.fromWeb(input.body as never), meter, createWriteStream(zipPath));
	} catch (cause) {
		await discard(importId);
		if (cause instanceof Error && cause.message === 'too-large') {
			error(413, 'The archive is larger than this server accepts.', { code: 'file-too-large' });
		}
		throw cause;
	}

	void analyze(importId, zipPath, sourceName);
	return importId;
}

async function analyze(importId: string, zipPath: string, sourceName: string): Promise<void> {
	try {
		const report = await buildReport(importId, zipPath, sourceName);
		await sql`
			UPDATE project_imports SET status = 'ready', report = ${sql.json(report as never)}
			WHERE id = ${importId}
		`;
	} catch (cause) {
		const message =
			cause instanceof ArchiveError
				? cause.message
				: 'The archive could not be read. Check that it is a valid ZIP file and try again.';
		if (!(cause instanceof ArchiveError)) console.error('import analysis failed', cause);
		// Nothing of a rejected archive is kept.
		await fs.rm(importDir(importId), { recursive: true, force: true });
		await sql`
			UPDATE project_imports SET status = 'rejected', error = ${message} WHERE id = ${importId}
		`;
	} finally {
		await fs.rm(zipPath, { force: true });
	}
}

async function buildReport(
	importId: string,
	zipPath: string,
	sourceName: string
): Promise<ImportReport> {
	const tree = stagedTree(importId);
	const archive = await extractArchive(zipPath, tree, {
		maxFiles: treeLimits.maxProjectFiles,
		maxFileBytes: treeLimits.maxFileBytes,
		maxTotalBytes: treeLimits.maxProjectBytes
	});

	const typstFiles = archive.files
		.filter((file) => file.path.toLowerCase().endsWith('.typ'))
		.map((file) => file.path);
	if (typstFiles.length === 0) {
		throw new ArchiveError(
			archive.files.length === 0
				? 'The archive contains no files that can be imported.'
				: 'The archive contains no .typ files, so there is no Typst document to import.'
		);
	}

	const sources = new Map<string, string>();
	for (const file of archive.files) {
		if (!file.path.toLowerCase().endsWith('.typ') || file.size > MAX_SOURCE_BYTES) continue;
		const content = await fs.readFile(path.join(tree, ...file.path.split('/')));
		if (looksLikeText(content)) sources.set(file.path, content.toString('utf8'));
	}

	const allPaths = new Set(archive.files.map((file) => file.path));
	const { packages, missing, referenced } = analyzeSources(sources, allPaths);
	const suggestedEntry = guessEntryFile(typstFiles, referenced)!;

	// The dry run also installs the packages the sources need, which tells us which are available.
	const { unavailable, ...compile } = await dryRunCompile(importId, suggestedEntry);

	return {
		fileCount: archive.files.length,
		totalBytes: archive.files.reduce((sum, file) => sum + file.size, 0),
		strippedFolder: archive.strippedFolder,
		typstFiles,
		suggestedEntry,
		suggestedName: (archive.strippedFolder ?? sourceName.replace(/\.zip$/i, '')).slice(0, 120),
		skipped: archive.skipped,
		skippedCount: archive.skippedCount,
		packages: packages.map((use) => ({
			...use,
			status:
				unavailable === null ? 'unknown' : unavailable.has(use.spec) ? 'unavailable' : 'available',
			reason: unavailable?.get(use.spec) ?? null
		})),
		missing,
		fontFiles: archive.files.filter((file) => FONT_FILE.test(file.path)).map((file) => file.path),
		compile
	};
}

/** Compiles the staged files once, exactly as the editor will, without creating a project. */
async function dryRunCompile(
	importId: string,
	entry: string
): Promise<ImportReport['compile'] & { unavailable: Map<string, string> | null }> {
	const tree = stagedTree(importId);
	try {
		const { result, packageFailures } = await compileProject(tree, entry, 'svg');
		const unavailable = new Map(packageFailures.map((failure) => [failure.spec, failure.reason]));
		if (!result.ok) return { status: 'failed', diagnostics: result.diagnostics, unavailable };

		const firstPage = result.artifacts[0];
		if (firstPage?.data) {
			await fs.writeFile(previewPath(importId), Buffer.from(firstPage.data, 'base64'));
		}
		return {
			status: 'ok',
			pageCount: result.artifacts.length,
			diagnostics: result.diagnostics,
			unavailable
		};
	} catch (cause) {
		if (cause instanceof WorkerUnavailableError) {
			return { status: 'unavailable', message: cause.message, unavailable: null };
		}
		throw cause;
	}
}

/** Returns the import if it belongs to the user; imports are private to who uploaded them. */
export async function getImport(userId: string, importId: string): Promise<ProjectImport | null> {
	if (!isUuid(importId)) return null;
	const [row] = await sql<ImportRow[]>`
		SELECT id, workspace_id, source_name, status, report, error, project_id
		FROM project_imports
		WHERE id = ${importId} AND user_id = ${userId}
	`;
	return row ? toImport(row) : null;
}

/** Turns a staged import into a project. Can only happen once per import. */
export async function confirmImport(input: {
	userId: string;
	importId: string;
	name: unknown;
	entryPath: unknown;
}): Promise<Project> {
	const name = validateProjectName(input.name);
	const pending = await getImport(input.userId, input.importId);
	if (!pending || pending.status !== 'ready' || !pending.report) {
		error(409, 'This import is no longer waiting for confirmation.');
	}
	if (typeof input.entryPath !== 'string' || !pending.report.typstFiles.includes(input.entryPath)) {
		error(400, 'Choose one of the Typst files in the archive as the main file.');
	}

	await assertWorkspaceRoom(pending.workspaceId, {
		projects: 1,
		bytes: pending.report.totalBytes
	}).catch((cause) => {
		if (cause instanceof WorkspaceLimitError) error(413, cause.message);
		throw cause;
	});

	// Claim the import first, so two confirmations cannot both create a project.
	const [claimed] = await sql`
		UPDATE project_imports SET status = 'imported'
		WHERE id = ${input.importId} AND status = 'ready'
		RETURNING id
	`;
	if (!claimed) error(409, 'This import was already confirmed.');

	const project = await insertProject({
		workspaceId: pending.workspaceId,
		userId: input.userId,
		name,
		entryPath: input.entryPath
	});
	await fs.mkdir(projectDir(project.id), { recursive: true });
	await fs.rename(stagedTree(input.importId), projectTreeDir(project.id));
	await fs.rm(importDir(input.importId), { recursive: true, force: true });
	await sql`UPDATE project_imports SET project_id = ${project.id} WHERE id = ${input.importId}`;

	await measureProject(project.id);
	// Best effort: the editor asks again when it opens, should the queue be full now.
	await requestCompile({ projectId: project.id, userId: input.userId, format: 'svg' }).catch(
		(cause) => {
			if (!(cause instanceof QueueFullError)) throw cause;
		}
	);
	return project;
}

export async function cancelImport(userId: string, importId: string): Promise<void> {
	const pending = await getImport(userId, importId);
	if (!pending || pending.status === 'imported') return;
	await discard(importId);
}

async function discard(importId: string): Promise<void> {
	await fs.rm(importDir(importId), { recursive: true, force: true });
	await sql`DELETE FROM project_imports WHERE id = ${importId}`;
}

/**
 * Housekeeping at startup and then hourly: analyses cut off by a restart are
 * closed, and uploads nobody confirmed are removed after a day.
 */
export async function startImportCleanup(): Promise<void> {
	const interrupted = await sql<{ id: string }[]>`
		UPDATE project_imports
		SET status = 'rejected', error = 'The server restarted during the check. Upload the archive again.'
		WHERE status = 'analyzing'
		RETURNING id
	`;
	for (const { id } of interrupted) await fs.rm(importDir(id), { recursive: true, force: true });

	const purge = async () => {
		const expired = await sql<{ id: string }[]>`
			DELETE FROM project_imports
			WHERE created_at < now() - make_interval(hours => ${STAGED_LIFETIME_HOURS})
			RETURNING id
		`;
		for (const { id } of expired) await fs.rm(importDir(id), { recursive: true, force: true });
	};
	await purge();
	setInterval(
		() => void purge().catch((cause) => console.error('import cleanup failed', cause)),
		3_600_000
	).unref();
}
