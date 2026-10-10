import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { collectArtifacts, isOutputName, type OutputCache } from './artifacts.ts';
import type { BlobStore } from './blobs.ts';
import {
	failure,
	materialize,
	MissingBlobsError,
	type CompileRequest,
	type CompileResult,
	type SnapshotFile
} from './compile.ts';
import type { CompileLimits, SandboxMode, WarmLimits } from './config.ts';
import { hasErrors, hideJobPaths, parseDiagnostics } from './diagnostics.ts';
import {
	buildCompileCommand,
	compilerView,
	DEPENDENCIES_FILE,
	type JobPaths,
	type Toolchain
} from './sandbox.ts';

/**
 * Compilers that stay running between the preview compiles of a project.
 *
 * A session is one `typst watch` process on its own copy of the project, under
 * the same sandbox and limits as a single compile. Because the compiler keeps
 * what it computed, a compile after a small edit takes a fraction of the time.
 *
 * The difficulty is knowing which state of the files a finished compile has
 * seen: the compiler decides by itself when to compile, and only prints that
 * it did. The worker therefore controls it strictly:
 *
 * 1. The compiler is stopped (SIGSTOP) while files are replaced, so it can
 *    never read half of an update.
 * 2. Its messages go to a file, which can be read completely while it is
 *    stopped. Each compile announces itself there before it reads any file.
 *    If a compile has started that the worker did not ask for, the session is
 *    not trusted any more.
 * 3. The main file is always rewritten, which makes the compiler compile once
 *    more, and the dependency file it writes at the very end of each compile
 *    marks that compile as finished.
 *
 * Whenever any of this does not go exactly as expected, the session answers
 * "unusable" and the compile runs from scratch instead. A warm compile is an
 * optimisation that must never change a result.
 */

interface Options {
	blobs: BlobStore;
	toolchain: Toolchain;
	sandbox: SandboxMode;
	limits: CompileLimits;
	warm: WarmLimits;
	/** Directory for the sessions' files; emptied at startup. */
	dir: string;
	packageDir: string | null;
}

type Outcome =
	| { kind: 'result'; result: CompileResult; /** Stop the compiler afterwards. */ stop?: boolean }
	| { kind: 'unusable' };

const UNUSABLE: Outcome = { kind: 'unusable' };

const COMPILE_STARTED = /^\[\d\d:\d\d:\d\d\] compiling \.\.\.$/m;
const COMPILE_STARTED_ALL = new RegExp(COMPILE_STARTED, 'gm');
const COMPILE_FINISHED = /^\[\d\d:\d\d:\d\d\] compiled (successfully|with warnings|with errors)/m;

/** After a change, the compiler waits 100 ms for further changes before it starts. */
const START_DEADLINE_MS = 2_000;
const STOP_DEADLINE_MS = 2_000;
const FIND_COMPILER_DEADLINE_MS = 5_000;
/** Most messages one compile may print for the session to stay in use. */
const MAX_SECTION_BYTES = 256 * 1024;
/** The message file of a session is not rotated; the session is replaced instead. */
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** After a session failed right at its start, its project is compiled from scratch for a while. */
const COOLDOWN_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function countStarts(text: string): number {
	return text.match(COMPILE_STARTED_ALL)?.length ?? 0;
}

/** Process ids of the direct children of a process, or none where the kernel does not tell. */
function childrenOf(pid: number): number[] {
	try {
		return readdirSync(`/proc/${pid}/task`).flatMap((task) =>
			readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8')
				.split(' ')
				.filter(Boolean)
				.map(Number)
		);
	} catch {
		return [];
	}
}

function commandName(pid: number): string | null {
	try {
		return readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
	} catch {
		return null;
	}
}

/**
 * Finds the compiler below the spawned command. Wrappers that only set limits
 * turn into the compiler themselves; bubblewrap keeps it as a descendant.
 */
function findCompiler(rootPid: number, names: Set<string>): number | null {
	const queue = [rootPid];
	for (let visited = 0; queue.length > 0 && visited < 64; visited++) {
		const pid = queue.shift()!;
		const name = commandName(pid);
		if (name !== null && names.has(name)) return pid;
		queue.push(...childrenOf(pid));
	}
	return null;
}

/** Whether every thread of the process is stopped; `gone` if it no longer exists. */
function stopState(pid: number): 'stopped' | 'running' | 'gone' {
	try {
		for (const task of readdirSync(`/proc/${pid}/task`)) {
			const fields = readFileSync(`/proc/${pid}/task/${task}/stat`, 'utf8');
			// The state follows the command name, which is in parentheses and may contain any character.
			const state = fields[fields.lastIndexOf(')') + 2];
			if (state !== 'T' && state !== 't') return 'running';
		}
		return 'stopped';
	} catch {
		return 'gone';
	}
}

function residentBytes(pid: number): number {
	try {
		const kilobytes = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
		return kilobytes ? Number(kilobytes[1]) * 1024 : 0;
	} catch {
		return 0;
	}
}

class Session {
	readonly name: string;
	readonly entry: string;
	lastUsed = Date.now();
	busy = false;

	readonly #options: Options;
	readonly #dir: string;
	readonly #paths: JobPaths;
	readonly #logPath: string;
	readonly #dependenciesPath: string;
	#child: ChildProcess | null = null;
	#compilerPid: number | null = null;
	#exited = false;
	/** Set when the session should be replaced before its next compile. */
	#spent = false;
	/** Bytes of the message file that are accounted for. */
	#mark = 0;
	#files = new Map<string, string>();
	#packageFiles = new Map<string, string>();
	readonly #outputs: OutputCache = new Map();

	constructor(name: string, entry: string, options: Options) {
		this.name = name;
		this.entry = entry;
		this.#options = options;
		this.#dir = path.join(options.dir, randomUUID());
		this.#paths = {
			sourceDir: path.join(this.#dir, 'src'),
			outputDir: path.join(this.#dir, 'out'),
			packageCacheDir: path.join(this.#dir, 'package-cache'),
			packageDir: options.packageDir
		};
		this.#logPath = path.join(this.#dir, 'messages.log');
		this.#dependenciesPath = path.join(this.#paths.outputDir, DEPENDENCIES_FILE);
	}

	/** Starts the compiler on the request's files. Its first compile is the result. */
	async start(request: CompileRequest, startedAt: number): Promise<Outcome> {
		const { limits, toolchain, sandbox } = this.#options;
		await mkdir(this.#paths.sourceDir, { recursive: true });
		await mkdir(this.#paths.outputDir);
		await mkdir(this.#paths.packageCacheDir);
		await this.#sync(request);

		const command = buildCompileCommand(
			toolchain,
			sandbox,
			'svg',
			this.entry,
			this.#paths,
			limits,
			'watch'
		);
		// Messages go to a file rather than a pipe: a file can be read to its end
		// while the compiler is stopped, and nothing is ever in transit.
		const log = openSync(this.#logPath, 'w');
		try {
			// Own process group, so the compiler and any helpers can be killed at once.
			this.#child = spawn(command.file, command.args, {
				cwd: command.cwd,
				env: command.env,
				detached: true,
				stdio: ['ignore', 'ignore', log]
			});
		} finally {
			closeSync(log);
		}
		this.#child.on('error', () => (this.#exited = true));
		this.#child.on('exit', () => (this.#exited = true));

		const names = new Set([path.basename(toolchain.typstPath).slice(0, 15), 'typst']);
		const deadline = performance.now() + FIND_COMPILER_DEADLINE_MS;
		while (this.#compilerPid === null) {
			if (this.#exited || this.#child.pid === undefined || performance.now() > deadline) {
				return UNUSABLE;
			}
			this.#compilerPid = findCompiler(this.#child.pid, names);
			if (this.#compilerPid === null) await sleep(2);
		}

		// Fonts are scanned before the first compile, which can take a while.
		return this.#finish(request, startedAt, limits.timeoutMs, false);
	}

	/** Brings the session's files to the request's snapshot and compiles once. */
	async update(request: CompileRequest, startedAt: number): Promise<Outcome> {
		if (this.#exited || this.#spent) return UNUSABLE;
		if (!(await this.#stop())) return UNUSABLE;
		try {
			// Any compile that started by itself may still be reading files.
			const messages = await this.#readMessages();
			if (messages === null || countStarts(messages) !== 0) return UNUSABLE;

			await rm(this.#dependenciesPath, { force: true });
			await this.#sync(request);
			// Rewriting the main file makes the compiler compile once more, whether or
			// not a file it had read before was among the changed ones.
			const entryPath = path.join(this.#paths.sourceDir, this.entry);
			await writeFile(entryPath, await readFile(entryPath));
			this.#accountFor(messages);
		} finally {
			this.#continue();
		}
		return this.#finish(request, startedAt, START_DEADLINE_MS, true);
	}

	async dispose(): Promise<void> {
		const child = this.#child;
		if (child?.pid !== undefined && !this.#exited) {
			const exited = new Promise((resolve) => child.once('exit', resolve));
			for (const pid of [-child.pid, this.#compilerPid]) {
				try {
					if (pid !== null) process.kill(pid, 'SIGKILL');
				} catch {
					// already gone
				}
			}
			await Promise.race([exited, sleep(2_000)]);
		}
		await rm(this.#dir, { recursive: true, force: true });
	}

	/** Waits for the one compile that follows a start or an update, and reads its result. */
	async #finish(
		request: CompileRequest,
		startedAt: number,
		startDeadlineMs: number,
		warm: boolean
	): Promise<Outcome> {
		const { limits, toolchain, warm: warmLimits } = this.#options;
		const waitingSince = performance.now();

		// The compile announces itself before it reads anything.
		for (;;) {
			if (this.#exited) return UNUSABLE;
			const messages = await this.#readMessages();
			if (messages === null) return UNUSABLE;
			if (countStarts(messages) > 0) break;
			if (performance.now() - waitingSince > startDeadlineMs) return UNUSABLE;
			await sleep(2);
		}

		// The dependency file is written after the output and all messages.
		while ((await this.#readDependencies()) === null) {
			if (this.#exited) return UNUSABLE;
			if (performance.now() - startedAt > limits.timeoutMs) {
				const seconds = Math.round(limits.timeoutMs / 1000);
				return {
					kind: 'result',
					stop: true,
					result: {
						ok: false,
						diagnostics: [failure(`Compilation was stopped after ${seconds} seconds.`)],
						artifacts: [],
						durationMs: Math.round(performance.now() - startedAt),
						typstVersion: toolchain.typstVersion,
						timedOut: true,
						warm
					}
				};
			}
			await sleep(performance.now() - waitingSince < 500 ? 2 : 10);
		}

		// Read the result while nothing can change it.
		if (!(await this.#stop())) return UNUSABLE;
		try {
			const messages = await this.#readMessages();
			// Exactly the compile that was asked for, and no other, may have started.
			if (messages === null || countStarts(messages) !== 1) return UNUSABLE;
			const announcement = COMPILE_STARTED.exec(messages)!;
			const section = messages.slice(announcement.index + announcement[0].length);
			if (!COMPILE_FINISHED.test(section)) return UNUSABLE;

			const dependencies = await this.#readDependencies();
			if (dependencies === null) return UNUSABLE;

			const result: CompileResult = {
				ok: false,
				diagnostics: hideJobPaths(
					parseDiagnostics(section),
					compilerView(this.#options.sandbox, this.#paths)
				),
				artifacts: [],
				durationMs: 0,
				typstVersion: toolchain.typstVersion,
				timedOut: false,
				warm
			};

			if (dependencies.outputs === null) {
				// A failed compile must have said why.
				if (!hasErrors(result.diagnostics)) return UNUSABLE;
			} else {
				const names = dependencies.outputs.map((output) => path.basename(output));
				if (!names.every((name) => isOutputName(name, 'svg'))) return UNUSABLE;
				const artifacts = await collectArtifacts(
					this.#paths.outputDir,
					names,
					'svg',
					request.knownPages,
					limits,
					this.#outputs
				);
				if (typeof artifacts === 'string') {
					result.diagnostics.push(failure(artifacts));
				} else {
					result.artifacts = artifacts;
					result.ok = true;
				}
			}

			this.#accountFor(messages);
			if (
				this.#mark > MAX_LOG_BYTES ||
				(this.#compilerPid !== null &&
					residentBytes(this.#compilerPid) > warmLimits.maxResidentBytes)
			) {
				this.#spent = true;
			}
			result.durationMs = Math.round(performance.now() - startedAt);
			return { kind: 'result', result };
		} finally {
			this.#continue();
		}
	}

	async #stop(): Promise<boolean> {
		const pid = this.#compilerPid;
		if (pid === null || this.#exited) return false;
		try {
			process.kill(pid, 'SIGSTOP');
		} catch {
			return false;
		}
		const deadline = performance.now() + STOP_DEADLINE_MS;
		for (;;) {
			const state = stopState(pid);
			if (state === 'stopped') return true;
			if (state === 'gone' || performance.now() > deadline) return false;
			await sleep(1);
		}
	}

	#continue(): void {
		try {
			if (this.#compilerPid !== null) process.kill(this.#compilerPid, 'SIGCONT');
		} catch {
			// already gone
		}
	}

	/** Messages printed since the last accounted compile, or null if there are too many. */
	async #readMessages(): Promise<string | null> {
		const file = await open(this.#logPath, 'r');
		try {
			const { size } = await file.stat();
			const length = size - this.#mark;
			if (length > MAX_SECTION_BYTES) return null;
			const buffer = Buffer.alloc(Math.max(length, 0));
			const { bytesRead } = await file.read(buffer, 0, buffer.length, this.#mark);
			return buffer.subarray(0, bytesRead).toString('utf8');
		} finally {
			await file.close();
		}
	}

	/**
	 * Marks messages as dealt with, up to the last complete line: the start of a
	 * line the compiler was stopped in the middle of must be read again.
	 */
	#accountFor(messages: string): void {
		const complete = messages.slice(0, messages.lastIndexOf('\n') + 1);
		this.#mark += Buffer.byteLength(complete);
	}

	/** The dependency file of the latest compile, once it is completely written. */
	async #readDependencies(): Promise<{ outputs: string[] | null } | null> {
		try {
			const parsed: unknown = JSON.parse(await readFile(this.#dependenciesPath, 'utf8'));
			if (typeof parsed !== 'object' || parsed === null) return null;
			const { outputs } = parsed as { outputs?: unknown };
			if (outputs === null || outputs === undefined) return { outputs: null };
			if (!Array.isArray(outputs) || !outputs.every((output) => typeof output === 'string')) {
				return null;
			}
			return { outputs };
		} catch {
			// Not there yet, or caught half-written.
			return null;
		}
	}

	async #sync(request: CompileRequest): Promise<void> {
		this.#files = await this.#syncTree(this.#paths.sourceDir, this.#files, request.files);
		this.#packageFiles = await this.#syncTree(
			this.#paths.packageCacheDir,
			this.#packageFiles,
			request.packages.flatMap((item) =>
				item.files.map((file) => ({
					path: path.join(item.namespace, item.name, item.version, file.path),
					sha256: file.sha256
				}))
			)
		);
	}

	/** Makes the files below `root` match `wanted`, touching only what differs. */
	async #syncTree(
		root: string,
		current: Map<string, string>,
		wanted: SnapshotFile[]
	): Promise<Map<string, string>> {
		const next = new Map(wanted.map((file) => [file.path, file.sha256]));

		for (const stale of current.keys()) {
			if (next.has(stale)) continue;
			await rm(path.join(root, stale), { force: true });
			// Remove folders this emptied, so that a file can take a folder's name.
			let folder = path.dirname(stale);
			while (folder !== '.') {
				const removed = await rmdir(path.join(root, folder)).then(
					() => true,
					() => false
				);
				if (!removed) break;
				folder = path.dirname(folder);
			}
		}

		const changed = wanted.filter((file) => current.get(file.path) !== file.sha256);
		await materialize(this.#options.blobs, changed, root);
		return next;
	}
}

export class WarmSessions {
	readonly #options: Options;
	readonly #sessions = new Map<string, Session>();
	/** The last compile of each session name, so that compiles for one name run in turn. */
	readonly #turns = new Map<string, Promise<unknown>>();
	readonly #cooldown = new Map<string, number>();
	#sweep: NodeJS.Timeout | null = null;

	constructor(options: Options) {
		this.#options = options;
	}

	get enabled(): boolean {
		return this.#options.warm.maxSessions > 0;
	}

	/** Removes what a previous run left behind and starts stopping idle compilers. */
	async open(): Promise<void> {
		await rm(this.#options.dir, { recursive: true, force: true });
		await mkdir(this.#options.dir, { recursive: true });
		this.#sweep = setInterval(() => void this.#stopIdle(), SWEEP_INTERVAL_MS);
		this.#sweep.unref();
	}

	async close(): Promise<void> {
		if (this.#sweep) clearInterval(this.#sweep);
		await Promise.all([...this.#sessions.values()].map((session) => this.#dispose(session)));
	}

	/**
	 * Compiles with the session's running compiler, starting one if needed.
	 * Returns null when the compile should run from scratch instead.
	 */
	compile(request: CompileRequest, name: string): Promise<CompileResult | null> {
		if (!this.enabled) return Promise.resolve(null);

		const previous = this.#turns.get(name) ?? Promise.resolve();
		const run = previous.then(() => this.#compile(request, name));
		const turn = run.catch(() => undefined);
		this.#turns.set(name, turn);
		void turn.then(() => {
			if (this.#turns.get(name) === turn) this.#turns.delete(name);
		});
		return run;
	}

	async #compile(request: CompileRequest, name: string): Promise<CompileResult | null> {
		const startedAt = performance.now();

		let session = this.#sessions.get(name);
		if (session && session.entry !== request.entry) {
			await this.#dispose(session);
			session = undefined;
		}
		if (session) {
			const active = session;
			const result = await this.#attempt(active, () => active.update(request, startedAt));
			if (result) return result;
			// The session was given up; a fresh one starts with this compile.
		}

		if ((this.#cooldown.get(name) ?? 0) > Date.now()) return null;
		this.#cooldown.delete(name);

		const { blobs, warm } = this.#options;
		// A session keeps its own copy of the project and its packages.
		const files = [...request.files, ...request.packages.flatMap((item) => item.files)];
		const bytes = files.reduce((sum, file) => sum + (blobs.size(file.sha256) ?? 0), 0);
		if (bytes > warm.maxSourceBytes) return null;
		if (!(await this.#makeRoom())) return null;

		const fresh = new Session(name, request.entry, this.#options);
		this.#sessions.set(name, fresh);
		const result = await this.#attempt(fresh, () => fresh.start(request, performance.now()));
		if (!result) this.#cooldown.set(name, Date.now() + COOLDOWN_MS);
		return result;
	}

	/** Runs one compile in a session and stops the session unless it stays trustworthy. */
	async #attempt(session: Session, run: () => Promise<Outcome>): Promise<CompileResult | null> {
		session.busy = true;
		try {
			const outcome = await run();
			if (outcome.kind === 'unusable') {
				await this.#dispose(session);
				return null;
			}
			if (outcome.stop) await this.#dispose(session);
			session.lastUsed = Date.now();
			return outcome.result;
		} catch (error) {
			// Its files may be half updated.
			await this.#dispose(session);
			if (error instanceof MissingBlobsError) throw error;
			console.error('warm compile failed; compiling from scratch', error);
			return null;
		} finally {
			session.busy = false;
		}
	}

	/** Stops the sessions used longest ago until one more fits. False if all are compiling. */
	async #makeRoom(): Promise<boolean> {
		while (this.#sessions.size >= this.#options.warm.maxSessions) {
			const idle = [...this.#sessions.values()]
				.filter((session) => !session.busy)
				.sort((a, b) => a.lastUsed - b.lastUsed)[0];
			if (!idle) return false;
			await this.#dispose(idle);
		}
		return true;
	}

	async #stopIdle(): Promise<void> {
		const cutoff = Date.now() - this.#options.warm.idleMs;
		for (const session of this.#sessions.values()) {
			if (!session.busy && session.lastUsed < cutoff) await this.#dispose(session);
		}
	}

	async #dispose(session: Session): Promise<void> {
		if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
		await session.dispose().catch((error) => console.error('could not stop a compiler', error));
	}
}
