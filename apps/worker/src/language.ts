import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BlobStore } from './blobs.ts';
import {
	InvalidRequestError,
	MissingBlobsError,
	parseFileList,
	parsePackages,
	type PackageFiles,
	type SnapshotFile
} from './compile.ts';
import { isSafeRelativePath } from './paths.ts';
import type { CompileLimits, LanguageLimits, SandboxMode } from './config.ts';
import {
	buildLanguageServerCommand,
	languageView,
	type LanguagePaths,
	type Toolchain
} from './sandbox.ts';
import { packagePaths, syncTree } from './sync-tree.ts';

/**
 * Language servers (Tinymist) that assist people while they write: completion,
 * hover documentation, go to definition, rename, formatting.
 *
 * One server runs per open editor, on its own copy of the project, confined
 * like a compiler. The editor talks to it in the language-server protocol; the
 * worker stands in between and
 *
 * - lets only a fixed list of requests through, so the server's commands that
 *   export files or start previews cannot be reached;
 * - decides the server's settings and project root itself;
 * - translates file addresses: the editor only ever sees `file:///project/…`,
 *   never where the copy lies on this machine, and cannot name a file outside.
 */

/** What a language server works on. */
export interface LanguageRequest {
	/** The main file, which the server compiles from whatever file is being edited. */
	entry: string;
	files: SnapshotFile[];
	packages: PackageFiles[];
}

interface Options {
	blobs: BlobStore;
	toolchain: Toolchain;
	sandbox: SandboxMode;
	limits: CompileLimits;
	language: LanguageLimits;
	/** Largest project, with its packages, that a server is given a copy of. */
	maxSourceBytes: number;
	/** Directory for the servers' copies of projects; emptied at startup. */
	dir: string;
}

export function parseLanguageRequest(body: unknown, limits: CompileLimits): LanguageRequest {
	if (typeof body !== 'object' || body === null) {
		throw new InvalidRequestError('request body must be a JSON object');
	}
	const { entry, files, packages } = body as Record<string, unknown>;
	if (!isSafeRelativePath(entry)) throw new InvalidRequestError('entry is not a valid path');
	const snapshot = parseFileList(files, 'files');
	const packageFiles = parsePackages(packages);
	const count = snapshot.length + packageFiles.reduce((sum, item) => sum + item.files.length, 0);
	if (count > limits.maxSnapshotFiles) {
		throw new InvalidRequestError(`snapshot has more than ${limits.maxSnapshotFiles} files`);
	}
	return { entry, files: snapshot, packages: packageFiles };
}

/** The server cannot take another editor right now, or is not installed. */
export class LanguageUnavailableError extends Error {}

/** Addresses the editor uses for the project and for packages. */
export const PROJECT_URI = 'file:///project';
const PACKAGES_URI = 'file:///packages';
/** Stands in for any place the editor has no business knowing. */
const ELSEWHERE_URI = 'file:///elsewhere';

const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_BACKLOG_MESSAGES = 512;
/** A server is only stopped to make room when its editor has been quiet for this long. */
const EVICT_AFTER_QUIET_MS = 120_000;
/** A server whose editor stopped listening is given this long for it to come back. */
const UNHEARD_GRACE_MS = 20_000;
const SWEEP_INTERVAL_MS = 15_000;

/** What an editor may ask for. Everything else is refused without reaching the server. */
const ALLOWED_REQUESTS = new Set([
	'initialize',
	'shutdown',
	'textDocument/completion',
	'completionItem/resolve',
	'textDocument/hover',
	'textDocument/signatureHelp',
	'textDocument/definition',
	'textDocument/declaration',
	'textDocument/typeDefinition',
	'textDocument/implementation',
	'textDocument/references',
	'textDocument/documentHighlight',
	'textDocument/documentSymbol',
	'textDocument/formatting',
	'textDocument/rangeFormatting',
	'textDocument/prepareRename',
	'textDocument/rename',
	'textDocument/foldingRange',
	'textDocument/selectionRange',
	'workspace/symbol'
]);
const ALLOWED_NOTIFICATIONS = new Set([
	'initialized',
	'exit',
	'$/cancelRequest',
	'textDocument/didOpen',
	'textDocument/didChange',
	'textDocument/didClose',
	'textDocument/didSave'
]);

/** Settings of the server, the same for everyone. */
const serverSettings = (root: string) => ({
	rootPath: root,
	formatterMode: 'typstyle',
	exportPdf: 'never',
	semanticTokens: 'disable',
	systemFonts: true
});

const URI_FIELDS = new Set(['uri', 'targetUri', 'rootUri', 'oldUri', 'newUri', 'scopeUri']);

class UnknownAddressError extends Error {}

/**
 * Returns a copy of a protocol message with every file address translated.
 * Addresses only occur in the named fields and as the keys of `changes`;
 * document text is never touched.
 */
function translateUris(
	value: unknown,
	translate: (uri: string) => string,
	/** Applied to error and diagnostic texts, which may quote paths. */
	reword?: (message: string) => string
): unknown {
	if (Array.isArray(value)) return value.map((item) => translateUris(item, translate, reword));
	if (typeof value !== 'object' || value === null) return value;

	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (URI_FIELDS.has(key) && typeof item === 'string') {
			result[key] = translate(item);
		} else if (key === 'message' && typeof item === 'string' && reword) {
			result[key] = reword(item);
		} else if (key === 'changes' && typeof item === 'object' && item !== null) {
			result[key] = Object.fromEntries(
				Object.entries(item).map(([uri, edits]) => [
					translate(uri),
					translateUris(edits, translate, reword)
				])
			);
		} else {
			result[key] = translateUris(item, translate, reword);
		}
	}
	return result;
}

type Message = { id?: unknown; method?: unknown; params?: unknown; [key: string]: unknown };

class LanguageSession {
	readonly name: string;
	lastHeard = Date.now();
	/** When the editor stopped listening; null while it listens. */
	unheardSince: number | null = Date.now();

	readonly #options: Options;
	readonly #dir: string;
	readonly #paths: LanguagePaths;
	readonly #rootUri: string;
	readonly #packagesUri: string;
	#entry = '';
	#child: ChildProcess | null = null;
	#exited = false;
	#files = new Map<string, string>();
	#packageFiles = new Map<string, string>();
	#listener: ((message: string | null) => void) | null = null;
	#backlog: string[] = [];
	#pending: Buffer = Buffer.alloc(0);
	#pinRequests = 0;
	#onExit: () => void;

	constructor(name: string, options: Options, onExit: () => void) {
		this.name = name;
		this.#options = options;
		this.#onExit = onExit;
		this.#dir = path.join(options.dir, randomUUID());
		this.#paths = {
			sourceDir: path.join(this.#dir, 'src'),
			cacheDir: path.join(this.#dir, 'cache'),
			scratchDir: path.join(this.#dir, 'scratch')
		};
		const view = languageView(options.sandbox, this.#paths);
		this.#rootUri = pathToFileURL(view.sourceDir).href;
		this.#packagesUri = pathToFileURL(path.join(view.cacheDir, 'typst', 'packages')).href;
	}

	get exited(): boolean {
		return this.#exited;
	}

	async start(request: LanguageRequest): Promise<void> {
		const { toolchain, sandbox, limits } = this.#options;
		await mkdir(this.#paths.sourceDir, { recursive: true });
		await mkdir(path.join(this.#paths.cacheDir, 'typst', 'packages'), { recursive: true });
		await mkdir(this.#paths.scratchDir);
		await this.sync(request);

		const command = buildLanguageServerCommand(toolchain, sandbox, this.#paths, limits);
		// Own process group, so the server and any helpers can be killed at once.
		const child = spawn(command.file, command.args, {
			cwd: command.cwd,
			env: command.env,
			detached: true,
			stdio: ['pipe', 'pipe', 'ignore']
		});
		this.#child = child;
		const ended = () => {
			if (this.#exited) return;
			this.#exited = true;
			this.#listener?.(null);
			this.#onExit();
		};
		child.on('error', ended);
		child.on('exit', ended);
		child.stdin!.on('error', () => {});
		child.stdout!.on('data', (chunk: Buffer) => this.#receive(chunk));
	}

	/** Brings the server's copy of the project to a newer snapshot. */
	async sync(request: LanguageRequest): Promise<void> {
		const { blobs } = this.#options;
		// The server reads these files whenever it likes, so each one changes in one step.
		this.#files = await syncTree(blobs, this.#paths.sourceDir, this.#files, request.files, {
			atomic: true
		});
		this.#packageFiles = await syncTree(
			blobs,
			path.join(this.#paths.cacheDir, 'typst', 'packages'),
			this.#packageFiles,
			packagePaths(request.packages),
			{ atomic: true }
		);
		const entryChanged = this.#entry !== '' && this.#entry !== request.entry;
		this.#entry = request.entry;
		if (entryChanged) this.#pinMain();
	}

	/** Passes messages from the editor on, in order. Refused requests are answered here. */
	send(messages: unknown[]): void {
		this.lastHeard = Date.now();
		for (const raw of messages) {
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
			const message = raw as Message;
			const method = typeof message.method === 'string' ? message.method : null;
			const isRequest = method !== null && message.id !== undefined;

			if (method !== null) {
				const allowed = isRequest
					? ALLOWED_REQUESTS.has(method)
					: ALLOWED_NOTIFICATIONS.has(method);
				if (!allowed) {
					if (isRequest) this.#refuse(message.id, `"${method}" is not available here.`);
					continue;
				}
			}

			// Where the editor believes the project to be is of no interest; see below.
			const offered =
				method === 'initialize' && typeof message.params === 'object' && message.params !== null
					? {
							...message,
							params: { ...message.params, rootUri: undefined, workspaceFolders: undefined }
						}
					: message;

			let translated: Message;
			try {
				translated = translateUris(offered, (uri) => this.#inward(uri)) as Message;
			} catch (error) {
				if (!(error instanceof UnknownAddressError)) throw error;
				if (isRequest) this.#refuse(message.id, 'That file is not part of the project.');
				continue;
			}

			if (method === 'initialize') {
				// The editor does not choose the root or the server's settings.
				const params = (typeof translated.params === 'object' && translated.params) || {};
				translated.params = {
					...params,
					processId: null,
					rootPath: undefined,
					rootUri: this.#rootUri,
					workspaceFolders: [{ uri: this.#rootUri, name: 'project' }],
					initializationOptions: serverSettings(
						languageView(this.#options.sandbox, this.#paths).sourceDir
					)
				};
			}
			this.#write(translated);
			// Everything is compiled from the project's main file, so that labels and
			// definitions from other files are known in the one being edited.
			if (method === 'initialized') this.#pinMain();
		}
	}

	/**
	 * Delivers the server's messages to the editor, starting with any that came
	 * while nobody listened. `null` means the server has ended. Returns a
	 * function to stop listening.
	 */
	listen(listener: (message: string | null) => void): () => void {
		// A new listener replaces the old one: an editor reconnecting after a network break.
		this.#listener?.(null);
		this.#listener = listener;
		this.unheardSince = null;
		for (const message of this.#backlog.splice(0)) listener(message);
		if (this.#exited) listener(null);
		return () => {
			if (this.#listener !== listener) return;
			this.#listener = null;
			this.unheardSince = Date.now();
		};
	}

	async dispose(): Promise<void> {
		const child = this.#child;
		if (child?.pid !== undefined && !this.#exited) {
			const exited = new Promise((resolve) => child.once('exit', resolve));
			try {
				process.kill(-child.pid, 'SIGKILL');
			} catch {
				// already gone
			}
			await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
		}
		this.#exited = true;
		this.#listener?.(null);
		this.#listener = null;
		await rm(this.#dir, { recursive: true, force: true });
	}

	#pinMain(): void {
		const view = languageView(this.#options.sandbox, this.#paths);
		this.#write({
			jsonrpc: '2.0',
			id: `kernic-pin-${++this.#pinRequests}`,
			method: 'workspace/executeCommand',
			params: { command: 'tinymist.pinMain', arguments: [path.join(view.sourceDir, this.#entry)] }
		});
	}

	#write(message: unknown): void {
		const stdin = this.#child?.stdin;
		if (!stdin || this.#exited || stdin.destroyed) return;
		const body = Buffer.from(JSON.stringify(message));
		stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
		stdin.write(body);
	}

	#refuse(id: unknown, reason: string): void {
		this.#deliver(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: reason } }));
	}

	#deliver(message: string): void {
		if (this.#listener) this.#listener(message);
		else if (this.#backlog.length < MAX_BACKLOG_MESSAGES) this.#backlog.push(message);
	}

	/** Splits the server's output into messages (`Content-Length` framing). */
	#receive(chunk: Buffer): void {
		this.#pending = this.#pending.length > 0 ? Buffer.concat([this.#pending, chunk]) : chunk;
		for (;;) {
			const headerEnd = this.#pending.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				if (this.#pending.length > 8192) this.#giveUp();
				return;
			}
			const length = Number(
				/^content-length: *(\d+)$/im.exec(
					this.#pending.subarray(0, headerEnd).toString('latin1')
				)?.[1]
			);
			if (!Number.isSafeInteger(length) || length > MAX_OUTPUT_MESSAGE_BYTES) {
				this.#giveUp();
				return;
			}
			const end = headerEnd + 4 + length;
			if (this.#pending.length < end) return;
			const body = this.#pending.subarray(headerEnd + 4, end).toString('utf8');
			this.#pending = this.#pending.subarray(end);

			let message: Message;
			try {
				message = JSON.parse(body) as Message;
			} catch {
				continue;
			}
			// Answers to what the worker asked itself are not for the editor.
			if (typeof message.id === 'string' && message.id.startsWith('kernic-pin-')) continue;
			this.#deliver(
				JSON.stringify(
					translateUris(
						message,
						(uri) => this.#outward(uri),
						(text) => this.#withoutPaths(text)
					)
				)
			);
		}
	}

	/** The server sent something that is not the protocol; it cannot be trusted further. */
	#giveUp(): void {
		this.#pending = Buffer.alloc(0);
		void this.dispose();
	}

	/** An address from the editor, as the server knows the file. */
	#inward(uri: string): string {
		if (uri === PROJECT_URI || uri.startsWith(`${PROJECT_URI}/`)) {
			const rest = uri.slice(PROJECT_URI.length);
			// No way out of the project by spelling the path differently.
			if (/(^|\/)(\.\.?|%2e%2e?|%2e\.|\.%2e)(\/|$)/i.test(rest) || /%2f|%5c|\\/i.test(rest)) {
				throw new UnknownAddressError();
			}
			return this.#rootUri + rest;
		}
		throw new UnknownAddressError();
	}

	/** A message of the server with the paths in it as the author knows them. */
	#withoutPaths(text: string): string {
		const view = languageView(this.#options.sandbox, this.#paths);
		return text
			.replaceAll(`${view.sourceDir}/`, '')
			.replaceAll(`${path.join(view.cacheDir, 'typst', 'packages')}/`, '@')
			.replaceAll(view.sourceDir, 'the project')
			.replaceAll(view.cacheDir, 'the packages');
	}

	/** An address from the server, as the editor may see it. */
	#outward(uri: string): string {
		if (uri === this.#rootUri || uri.startsWith(`${this.#rootUri}/`)) {
			return PROJECT_URI + uri.slice(this.#rootUri.length);
		}
		if (uri.startsWith(`${this.#packagesUri}/`)) {
			return PACKAGES_URI + uri.slice(this.#packagesUri.length);
		}
		return uri.startsWith('file:') ? ELSEWHERE_URI : uri;
	}
}

export class LanguageSessions {
	readonly #options: Options;
	readonly #sessions = new Map<string, LanguageSession>();
	#sweep: NodeJS.Timeout | null = null;

	constructor(options: Options) {
		this.#options = options;
	}

	/** Whether editor assistance is offered at all on this worker. */
	get available(): boolean {
		return this.#options.language.maxSessions > 0 && this.#options.toolchain.tinymistPath !== null;
	}

	async open(): Promise<void> {
		await rm(this.#options.dir, { recursive: true, force: true });
		await mkdir(this.#options.dir, { recursive: true });
		this.#sweep = setInterval(() => void this.#stopUnused(), SWEEP_INTERVAL_MS);
		this.#sweep.unref();
	}

	async close(): Promise<void> {
		if (this.#sweep) clearInterval(this.#sweep);
		await Promise.all([...this.#sessions.values()].map((session) => this.#dispose(session)));
	}

	/** Starts a language server under a new name, or brings a running one to a newer snapshot. */
	async start(name: string, request: LanguageRequest): Promise<void> {
		if (!this.available) {
			throw new LanguageUnavailableError('Editor assistance is not installed on this server.');
		}
		// Ask for everything that is missing at once, before anything is copied.
		const { blobs, maxSourceBytes } = this.#options;
		const wanted = [...request.files, ...request.packages.flatMap((item) => item.files)];
		const missing = [
			...new Set(wanted.filter((file) => !blobs.has(file.sha256)).map((file) => file.sha256))
		];
		if (missing.length > 0) throw new MissingBlobsError(missing);
		const bytes = wanted.reduce((sum, file) => sum + (blobs.size(file.sha256) ?? 0), 0);
		if (bytes > maxSourceBytes) {
			throw new LanguageUnavailableError('This project is too large for editor assistance.');
		}

		const existing = this.#sessions.get(name);
		if (existing && !existing.exited) {
			await existing.sync(request);
			return;
		}

		if (!(await this.#makeRoom())) {
			throw new LanguageUnavailableError(
				'Editor assistance is in use by as many editors as this server allows.'
			);
		}
		const session = new LanguageSession(name, this.#options, () => {
			void this.#dispose(session);
		});
		this.#sessions.set(name, session);
		try {
			await session.start(request);
		} catch (error) {
			await this.#dispose(session);
			throw error;
		}
	}

	send(name: string, messages: unknown): boolean {
		const session = this.#sessions.get(name);
		if (!session || session.exited) return false;
		if (!Array.isArray(messages) || messages.length > 256) {
			throw new InvalidRequestError('messages must be a list of at most 256 messages');
		}
		session.send(messages);
		return true;
	}

	listen(name: string, listener: (message: string | null) => void): (() => void) | null {
		const session = this.#sessions.get(name);
		if (!session || session.exited) return null;
		return session.listen(listener);
	}

	async stop(name: string): Promise<void> {
		const session = this.#sessions.get(name);
		if (session) await this.#dispose(session);
	}

	/** Stops the quietest server if all places are taken. False if none has been quiet for long. */
	async #makeRoom(): Promise<boolean> {
		while (this.#sessions.size >= this.#options.language.maxSessions) {
			const quietest = [...this.#sessions.values()].sort((a, b) => a.lastHeard - b.lastHeard)[0]!;
			if (Date.now() - quietest.lastHeard < EVICT_AFTER_QUIET_MS) return false;
			await this.#dispose(quietest);
		}
		return true;
	}

	async #stopUnused(): Promise<void> {
		const now = Date.now();
		for (const session of this.#sessions.values()) {
			const idle = now - session.lastHeard > this.#options.language.idleMs;
			const unheard =
				session.unheardSince !== null && now - session.unheardSince > UNHEARD_GRACE_MS;
			if (idle || unheard) await this.#dispose(session);
		}
	}

	async #dispose(session: LanguageSession): Promise<void> {
		if (this.#sessions.get(session.name) === session) this.#sessions.delete(session.name);
		await session
			.dispose()
			.catch((error) => console.error('could not stop a language server', error));
	}
}

export { MAX_MESSAGE_BYTES };
