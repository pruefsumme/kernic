import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { collectArtifacts, isOutputName, type Artifact, type OutputFormat } from './artifacts.ts';
import type { BlobStore } from './blobs.ts';
import type { CompileLimits, SandboxMode } from './config.ts';
import { hasErrors, hideJobPaths, parseDiagnostics, type Diagnostic } from './diagnostics.ts';
import { isSafeRelativePath, isSha256 } from './paths.ts';
import { buildCompileCommand, compilerView, type JobPaths, type Toolchain } from './sandbox.ts';
import type { WarmSessions } from './sessions.ts';

export type { Artifact, OutputFormat };

export interface SnapshotFile {
	path: string;
	sha256: string;
}

/** A Typst package provided by the app, e.g. `@preview/cetz:0.3.1`. */
export interface PackageFiles {
	namespace: string;
	name: string;
	version: string;
	files: SnapshotFile[];
}

export interface CompileRequest {
	entry: string;
	format: OutputFormat;
	files: SnapshotFile[];
	/** Packages the document may import. The worker never downloads any itself. */
	packages: PackageFiles[];
	/**
	 * Hashes of rendered pages the caller already stores. Their content is not
	 * sent again: after a small edit to a long document, most pages are unchanged.
	 */
	knownPages: Set<string>;
	/**
	 * Names what is being edited, typically a project. Preview compiles that
	 * share a name may be served by one compiler that stays running between
	 * them, which makes each following compile much faster.
	 */
	session: string | null;
}

export interface CompileResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	artifacts: Artifact[];
	durationMs: number;
	typstVersion: string;
	timedOut: boolean;
	/** Whether a compiler that was already running for this session produced the result. */
	warm: boolean;
}

export class InvalidRequestError extends Error {}

export class MissingBlobsError extends Error {
	readonly missing: string[];

	constructor(missing: string[]) {
		super('snapshot references blobs that have not been uploaded');
		this.missing = missing;
	}
}

const MAX_LOG_BYTES = 256 * 1024;
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const PACKAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PACKAGE_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** Validates a list of `{ path, sha256 }` entries; `what` names it in error messages. */
function parseFileList(files: unknown, what: string): SnapshotFile[] {
	if (!Array.isArray(files) || files.length === 0) {
		throw new InvalidRequestError(`${what} must be a non-empty array`);
	}
	const seen = new Set<string>();
	const result: SnapshotFile[] = [];
	for (const file of files as unknown[]) {
		const candidate = (file ?? {}) as Record<string, unknown>;
		if (!isSafeRelativePath(candidate.path)) {
			throw new InvalidRequestError(`${what} contains an invalid file path`);
		}
		if (!isSha256(candidate.sha256)) {
			throw new InvalidRequestError(`file "${candidate.path}" has an invalid sha256`);
		}
		if (seen.has(candidate.path)) {
			throw new InvalidRequestError(`file "${candidate.path}" is listed twice`);
		}
		seen.add(candidate.path);
		result.push({ path: candidate.path, sha256: candidate.sha256 });
	}
	return result;
}

function parsePackages(packages: unknown): PackageFiles[] {
	if (packages === undefined) return [];
	if (!Array.isArray(packages)) throw new InvalidRequestError('packages must be an array');

	const seen = new Set<string>();
	return (packages as unknown[]).map((entry) => {
		const { namespace, name, version, files } = (entry ?? {}) as Record<string, unknown>;
		if (
			typeof namespace !== 'string' ||
			typeof name !== 'string' ||
			typeof version !== 'string' ||
			!PACKAGE_NAME.test(namespace) ||
			!PACKAGE_NAME.test(name) ||
			!PACKAGE_VERSION.test(version)
		) {
			throw new InvalidRequestError('packages contains an invalid package identifier');
		}
		const spec = `@${namespace}/${name}:${version}`;
		if (seen.has(spec)) throw new InvalidRequestError(`package ${spec} is listed twice`);
		seen.add(spec);
		return { namespace, name, version, files: parseFileList(files, `package ${spec}`) };
	});
}

export function parseCompileRequest(body: unknown, limits: CompileLimits): CompileRequest {
	if (typeof body !== 'object' || body === null) {
		throw new InvalidRequestError('request body must be a JSON object');
	}
	const { entry, format, files, packages, knownPages, session } = body as Record<string, unknown>;

	if (format !== 'svg' && format !== 'pdf') {
		throw new InvalidRequestError('format must be "svg" or "pdf"');
	}
	if (!isSafeRelativePath(entry)) throw new InvalidRequestError('entry is not a valid path');
	const snapshot = parseFileList(files, 'files');
	const packageFiles = parsePackages(packages);

	const fileCount =
		snapshot.length + packageFiles.reduce((sum, item) => sum + item.files.length, 0);
	if (fileCount > limits.maxSnapshotFiles) {
		throw new InvalidRequestError(`snapshot has more than ${limits.maxSnapshotFiles} files`);
	}
	if (!snapshot.some((file) => file.path === entry)) {
		throw new InvalidRequestError('entry file is not part of the snapshot');
	}
	if (knownPages !== undefined && !(Array.isArray(knownPages) && knownPages.every(isSha256))) {
		throw new InvalidRequestError('knownPages must be an array of sha256 hashes');
	}
	if (session !== undefined && !(typeof session === 'string' && SESSION_NAME.test(session))) {
		throw new InvalidRequestError('session must be a short name of letters, digits, - and _');
	}
	return {
		entry,
		format,
		files: snapshot,
		packages: packageFiles,
		knownPages: new Set((knownPages as string[] | undefined) ?? []),
		session: (session as string | undefined) ?? null
	};
}

interface RunOutcome {
	exitCode: number | null;
	/** Signal that ended the compiler, whether reported directly or as exit code 128+n. */
	signal: number | null;
	stderr: string;
	timedOut: boolean;
}

const SIGNAL_NUMBERS: Record<string, number> = {
	SIGABRT: 6,
	SIGKILL: 9,
	SIGSEGV: 11,
	SIGXCPU: 24,
	SIGXFSZ: 25
};

function runCommand(
	file: string,
	args: string[],
	options: { cwd: string; env: Record<string, string>; timeoutMs: number }
): Promise<RunOutcome> {
	return new Promise((resolve, reject) => {
		// Own process group, so a timeout can kill the compiler and any helpers at once.
		const child = spawn(file, args, {
			cwd: options.cwd,
			env: options.env,
			detached: true,
			stdio: ['ignore', 'ignore', 'pipe']
		});

		const chunks: Buffer[] = [];
		let logBytes = 0;
		child.stderr.on('data', (chunk: Buffer) => {
			if (logBytes >= MAX_LOG_BYTES) return;
			chunks.push(chunk.subarray(0, MAX_LOG_BYTES - logBytes));
			logBytes += chunk.length;
		});

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (child.pid) process.kill(-child.pid, 'SIGKILL');
			} catch {
				// already exited
			}
		}, options.timeoutMs);

		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('close', (exitCode, signalName) => {
			clearTimeout(timer);
			// Without a sandbox wrapper the signal is reported directly; through
			// bubblewrap it arrives as the conventional exit code 128 + signal.
			const signal = signalName
				? (SIGNAL_NUMBERS[signalName] ?? 0)
				: exitCode !== null && exitCode > 128
					? exitCode - 128
					: null;
			resolve({ exitCode, signal, stderr: Buffer.concat(chunks).toString('utf8'), timedOut });
		});
	});
}

export function failure(message: string): Diagnostic {
	return { severity: 'error', message, path: null, line: null, column: null };
}

/** Copies snapshot files from the blob cache to their paths below `directory`. */
export async function materialize(
	blobs: BlobStore,
	files: SnapshotFile[],
	directory: string
): Promise<void> {
	const missing: string[] = [];
	for (const file of files) {
		const destination = path.join(directory, file.path);
		await mkdir(path.dirname(destination), { recursive: true });
		if (!(await blobs.copyTo(file.sha256, destination))) missing.push(file.sha256);
	}
	if (missing.length > 0) throw new MissingBlobsError(missing);
}

export class Compiler {
	readonly #blobs: BlobStore;
	readonly #toolchain: Toolchain;
	readonly #sandbox: SandboxMode;
	readonly #limits: CompileLimits;
	readonly #jobsDir: string;
	readonly #packageDir: string | null;
	readonly #sessions: WarmSessions | null;

	constructor(options: {
		blobs: BlobStore;
		toolchain: Toolchain;
		sandbox: SandboxMode;
		limits: CompileLimits;
		jobsDir: string;
		packageDir: string | null;
		sessions?: WarmSessions | null;
	}) {
		this.#blobs = options.blobs;
		this.#toolchain = options.toolchain;
		this.#sandbox = options.sandbox;
		this.#limits = options.limits;
		this.#jobsDir = options.jobsDir;
		this.#packageDir = options.packageDir;
		this.#sessions = options.sessions ?? null;
	}

	/** Removes job directories left behind by a crash. */
	async open(): Promise<void> {
		await rm(this.#jobsDir, { recursive: true, force: true });
		await mkdir(this.#jobsDir, { recursive: true });
	}

	async compile(request: CompileRequest): Promise<CompileResult> {
		const packageFiles = request.packages.flatMap((item) => item.files);
		this.#checkSnapshot([...request.files, ...packageFiles]);

		// A preview compile for a named session first tries the compiler that is
		// already running for it. It answers null whenever it cannot vouch for a
		// result, and the compile then runs from scratch as below.
		if (this.#sessions && request.session !== null && request.format === 'svg') {
			const warm = await this.#sessions.compile(request, request.session);
			if (warm) return warm;
		}

		const jobDir = path.join(this.#jobsDir, randomUUID());
		const paths: JobPaths = {
			sourceDir: path.join(jobDir, 'src'),
			outputDir: path.join(jobDir, 'out'),
			packageCacheDir: path.join(jobDir, 'package-cache'),
			packageDir: this.#packageDir
		};

		try {
			await mkdir(paths.sourceDir, { recursive: true });
			await mkdir(paths.outputDir);
			await mkdir(paths.packageCacheDir);
			await materialize(this.#blobs, request.files, paths.sourceDir);
			// Typst looks for packages in `<cache>/<namespace>/<name>/<version>` before it
			// would try to download them; everything a document may import is placed there.
			for (const item of request.packages) {
				const directory = path.join(paths.packageCacheDir, item.namespace, item.name, item.version);
				await materialize(this.#blobs, item.files, directory);
			}
			return await this.#run(request, paths);
		} finally {
			await rm(jobDir, { recursive: true, force: true });
		}
	}

	#checkSnapshot(files: SnapshotFile[]): void {
		const missing = new Set<string>();
		let totalBytes = 0;
		for (const file of files) {
			const size = this.#blobs.size(file.sha256);
			if (size === undefined) missing.add(file.sha256);
			else totalBytes += size;
		}
		if (missing.size > 0) throw new MissingBlobsError([...missing]);
		if (totalBytes > this.#limits.maxSnapshotBytes) {
			throw new InvalidRequestError(`snapshot exceeds ${this.#limits.maxSnapshotBytes} bytes`);
		}
	}

	async #run(request: CompileRequest, paths: JobPaths): Promise<CompileResult> {
		const command = buildCompileCommand(
			this.#toolchain,
			this.#sandbox,
			request.format,
			request.entry,
			paths,
			this.#limits
		);

		const startedAt = performance.now();
		const outcome = await runCommand(command.file, command.args, {
			cwd: command.cwd,
			env: command.env,
			timeoutMs: this.#limits.timeoutMs
		});
		const durationMs = Math.round(performance.now() - startedAt);

		const result: CompileResult = {
			ok: false,
			diagnostics: hideJobPaths(
				parseDiagnostics(outcome.stderr),
				compilerView(this.#sandbox, paths)
			),
			artifacts: [],
			durationMs,
			typstVersion: this.#toolchain.typstVersion,
			timedOut: outcome.timedOut,
			warm: false
		};

		if (outcome.timedOut) {
			const seconds = Math.round(this.#limits.timeoutMs / 1000);
			result.diagnostics.push(failure(`Compilation was stopped after ${seconds} seconds.`));
			return result;
		}

		if (outcome.exitCode !== 0) {
			if (!hasErrors(result.diagnostics)) {
				result.diagnostics.push(failure(this.#describeAbnormalExit(outcome)));
			}
			return result;
		}

		const names = (await readdir(paths.outputDir)).filter((name) =>
			isOutputName(name, request.format)
		);
		const artifacts = await collectArtifacts(
			paths.outputDir,
			names,
			request.format,
			request.knownPages,
			this.#limits
		);
		if (typeof artifacts === 'string') {
			result.diagnostics.push(failure(artifacts));
			return result;
		}

		result.artifacts = artifacts;
		result.ok = true;
		return result;
	}

	/** Explains why the compiler ended without reporting an error of its own. */
	#describeAbnormalExit(outcome: RunOutcome): string {
		const megabytes = (bytes: number) => Math.round(bytes / (1024 * 1024));
		switch (outcome.signal) {
			case SIGNAL_NUMBERS.SIGXFSZ:
				return `The rendered output is larger than ${megabytes(this.#limits.outputBytes)} MB, which is the limit for this server.`;
			case SIGNAL_NUMBERS.SIGXCPU:
				return 'Compilation was stopped because it used too much processor time.';
			case SIGNAL_NUMBERS.SIGABRT:
			case SIGNAL_NUMBERS.SIGKILL:
			case SIGNAL_NUMBERS.SIGSEGV:
				return `The compiler ran out of memory (limit: ${megabytes(this.#limits.memoryBytes)} MB) or crashed. Very large documents or data files can cause this.`;
		}
		const detail = outcome.stderr.trim().split('\n').at(-1);
		return detail
			? `The compiler stopped unexpectedly: ${detail}`
			: 'The compiler stopped unexpectedly.';
	}
}
