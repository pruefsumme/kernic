import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore } from './blobs.ts';
import type { CompileLimits, SandboxMode } from './config.ts';
import { hasErrors, parseDiagnostics, type Diagnostic } from './diagnostics.ts';
import { isSafeRelativePath, isSha256 } from './paths.ts';
import { buildCompileCommand, type JobPaths, type Toolchain } from './sandbox.ts';

export type OutputFormat = 'svg' | 'pdf';

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
}

export interface Artifact {
	name: string;
	size: number;
	/** Base64-encoded file content. */
	data: string;
}

export interface CompileResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	artifacts: Artifact[];
	durationMs: number;
	typstVersion: string;
	timedOut: boolean;
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
	const { entry, format, files, packages } = body as Record<string, unknown>;

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
	return { entry, format, files: snapshot, packages: packageFiles };
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

function failure(message: string): Diagnostic {
	return { severity: 'error', message, path: null, line: null, column: null };
}

export class Compiler {
	readonly #blobs: BlobStore;
	readonly #toolchain: Toolchain;
	readonly #sandbox: SandboxMode;
	readonly #limits: CompileLimits;
	readonly #jobsDir: string;
	readonly #packageDir: string | null;

	constructor(options: {
		blobs: BlobStore;
		toolchain: Toolchain;
		sandbox: SandboxMode;
		limits: CompileLimits;
		jobsDir: string;
		packageDir: string | null;
	}) {
		this.#blobs = options.blobs;
		this.#toolchain = options.toolchain;
		this.#sandbox = options.sandbox;
		this.#limits = options.limits;
		this.#jobsDir = options.jobsDir;
		this.#packageDir = options.packageDir;
	}

	/** Removes job directories left behind by a crash. */
	async open(): Promise<void> {
		await rm(this.#jobsDir, { recursive: true, force: true });
		await mkdir(this.#jobsDir, { recursive: true });
	}

	async compile(request: CompileRequest): Promise<CompileResult> {
		const packageFiles = request.packages.flatMap((item) => item.files);
		this.#checkSnapshot([...request.files, ...packageFiles]);

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
			await this.#materialize(request.files, paths.sourceDir);
			// Typst looks for packages in `<cache>/<namespace>/<name>/<version>` before it
			// would try to download them; everything a document may import is placed there.
			for (const item of request.packages) {
				const directory = path.join(paths.packageCacheDir, item.namespace, item.name, item.version);
				await this.#materialize(item.files, directory);
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

	async #materialize(files: SnapshotFile[], sourceDir: string): Promise<void> {
		const missing: string[] = [];
		for (const file of files) {
			const destination = path.join(sourceDir, file.path);
			await mkdir(path.dirname(destination), { recursive: true });
			if (!(await this.#blobs.copyTo(file.sha256, destination))) missing.push(file.sha256);
		}
		if (missing.length > 0) throw new MissingBlobsError(missing);
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
			diagnostics: parseDiagnostics(outcome.stderr),
			artifacts: [],
			durationMs,
			typstVersion: this.#toolchain.typstVersion,
			timedOut: outcome.timedOut
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

		const artifacts = await this.#collectArtifacts(paths.outputDir, request.format);
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

	/** Reads the output directory. Returns an error message when the output breaks a limit. */
	async #collectArtifacts(outputDir: string, format: OutputFormat): Promise<Artifact[] | string> {
		const expected = format === 'svg' ? /^page-\d+\.svg$/ : /^output\.pdf$/;
		const names = (await readdir(outputDir)).filter((name) => expected.test(name)).sort();

		if (names.length === 0) return 'The compiler finished without producing any output.';
		if (names.length > this.#limits.maxPages) {
			return `The document has more than ${this.#limits.maxPages} pages, which is the limit for this server.`;
		}

		let totalBytes = 0;
		for (const name of names) {
			totalBytes += (await stat(path.join(outputDir, name))).size;
		}
		if (totalBytes > this.#limits.outputBytes) {
			const megabytes = Math.round(this.#limits.outputBytes / (1024 * 1024));
			return `The rendered output is larger than ${megabytes} MB, which is the limit for this server.`;
		}

		const artifacts: Artifact[] = [];
		for (const name of names) {
			const content = await readFile(path.join(outputDir, name));
			artifacts.push({ name, size: content.length, data: content.toString('base64') });
		}
		return artifacts;
	}
}
