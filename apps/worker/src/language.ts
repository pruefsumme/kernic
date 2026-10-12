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
 *
 * The server also knows which place in the source made which place on a page.
 * It tells through its preview, which the worker starts on request and talks
 * to in the editor's stead (see `locate` and `sourceAt`), so that the pages
 * people see stay the compiler's own.
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

/** A place on a rendered page: the page counted from 1, and a point on it in points. */
export interface PagePosition {
	page: number;
	x: number;
	y: number;
}

/** A place in a file, counted from 0. */
export interface SourcePlace {
	line: number;
	character: number;
}

/** A place in the source: a project path and a place in that file. */
export interface SourcePosition extends SourcePlace {
	path: string;
}

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
/** Name of the one preview a language server runs for the worker. */
const PREVIEW_TASK = 'kernic';
const JUMP_TIMEOUT_MS = 1_200;
/**
 * The preview answers a jump within tens of milliseconds, and not at all when
 * the place asked for prints nothing. So the exact place is asked first, and
 * places nearby only once it has had this long to answer.
 */
const JUMP_EXACT_MS = 120;
/** Late answers to a jump are let pass for this long before the next jump is asked. */
const JUMP_SETTLE_MS = 120;
export const MAX_NEARBY_PLACES = 16;
/**
 * Points around a click on a page, nearest first, in points: between two lines,
 * then left of it (the blank end of a line), right of it (the margin), and
 * further up and down.
 */
const AROUND_A_CLICK: [number, number][] = [
	[0, -3],
	[0, 3],
	[-8, 0],
	[-20, 0],
	[-45, 0],
	[-90, 0],
	[-180, 0],
	[-320, 0],
	[-480, 0],
	[20, 0],
	[50, 0],
	[90, 0],
	[0, -8],
	[0, 8],
	[0, -16],
	[0, 16]
];
const PREVIEW_START_TIMEOUT_MS = 5_000;
const PREVIEW_FIRST_DOCUMENT_MS = 2_500;
/** The preview renders on every change of the document, so it only runs while jumps are asked for. */
const PREVIEW_IDLE_MS = 120_000;

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
	// The server answers "where is this defined" with links (`targetUri`); editors
	// that only know plain locations (`uri`, `range`) can read them this way too.
	if (reword && typeof result.targetUri === 'string' && result.uri === undefined) {
		result.uri = result.targetUri;
		result.range = result.targetSelectionRange ?? result.targetRange;
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
	#onExit: () => void;
	/** Requests the worker itself made to the server, by id. */
	#asked = new Map<string, (message: Message) => void>();
	#askedCount = 0;
	/** The connection to the server's preview, while there is one. */
	#preview: { socket: WebSocket; lastUsed: number } | null = null;
	#previewStarting: Promise<WebSocket> | null = null;
	/** Whoever is waiting for the answer to a jump. Answers carry no name, so jumps take turns. */
	#awaitingPage: ((positions: PagePosition[]) => void) | null = null;
	#awaitingSource: ((position: SourcePosition | null) => void) | null = null;
	#jumpTurn: Promise<unknown> = Promise.resolve();

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

	/**
	 * Whether jumps between page and source can be offered. The preview listens
	 * on a local port, which the worker cannot reach where the server runs in a
	 * network of its own (bubblewrap).
	 */
	get canJump(): boolean {
		return this.#options.sandbox !== 'bwrap';
	}

	/**
	 * Where on the rendered pages the given place in the source ends up; empty if
	 * nowhere. A place that prints nothing itself (the start of a line, a label, a
	 * function call) has no place on a page; then the first of `nearby` that has
	 * one answers instead.
	 */
	async locate(position: SourcePosition, nearby: SourcePlace[] = []): Promise<PagePosition[]> {
		this.lastHeard = Date.now();
		await this.#openPreview();
		return this.#inTurn(async () => {
			const answer = new Promise<PagePosition[]>((resolve) => {
				this.#awaitingPage = resolve;
				setTimeout(() => {
					if (this.#awaitingPage !== resolve) return;
					this.#awaitingPage = null;
					resolve([]);
				}, JUMP_TIMEOUT_MS).unref();
			});
			this.#scrollPreviewTo(position.path, position);
			if (nearby.length > 0 && !(await answeredWithin(answer, JUMP_EXACT_MS))) {
				// The preview answers in the order asked, so the nearest place that prints wins.
				for (const place of nearby) this.#scrollPreviewTo(position.path, place);
			}
			return answer;
		});
	}

	#scrollPreviewTo(file: string, place: SourcePlace): void {
		const view = languageView(this.#options.sandbox, this.#paths);
		void this.#ask('workspace/executeCommand', {
			command: 'tinymist.scrollPreview',
			arguments: [
				PREVIEW_TASK,
				{
					event: 'panelScrollTo',
					filepath: path.join(view.sourceDir, file),
					line: place.line,
					character: place.character
				}
			]
		});
	}

	/**
	 * Which place in the source made what is at a point of a page. A click beside
	 * the text (after the end of a line, between two lines, in the margin) is
	 * answered by what is nearest; null if nothing is near.
	 */
	async sourceAt(position: PagePosition): Promise<SourcePosition | null> {
		this.lastHeard = Date.now();
		const socket = await this.#openPreview();
		return this.#inTurn(async () => {
			const answer = new Promise<SourcePosition | null>((resolve) => {
				this.#awaitingSource = resolve;
				setTimeout(() => {
					if (this.#awaitingSource !== resolve) return;
					this.#awaitingSource = null;
					resolve(null);
				}, JUMP_TIMEOUT_MS).unref();
			});
			const ask = (x: number, y: number) => {
				if (socket.readyState !== WebSocket.OPEN) return;
				socket.send(`src-point ${JSON.stringify({ page_no: position.page, x, y })}`);
			};
			ask(position.x, position.y);
			if (!(await answeredWithin(answer, JUMP_EXACT_MS))) {
				for (const [dx, dy] of AROUND_A_CLICK) {
					ask(Math.max(0, position.x + dx), Math.max(0, position.y + dy));
				}
			}
			return answer;
		});
	}

	/**
	 * Runs one jump after the other. The preview's answers do not say which
	 * question they belong to, so a jump waits until the answers to the one
	 * before it have passed.
	 */
	#inTurn<T>(jump: () => Promise<T>): Promise<T> {
		const result = this.#jumpTurn.then(jump);
		this.#jumpTurn = result
			.catch(() => undefined)
			.then(() => new Promise((resolve) => setTimeout(resolve, JUMP_SETTLE_MS).unref()));
		return result;
	}

	/** Stops the preview once no jump has been asked for in a while. */
	closeIdlePreview(now: number): void {
		if (this.#preview && now - this.#preview.lastUsed > PREVIEW_IDLE_MS) this.#closePreview();
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
		this.#preview?.socket.close();
		this.#preview = null;
		this.#listener?.(null);
		this.#listener = null;
		await rm(this.#dir, { recursive: true, force: true });
	}

	/** Asks the server something on the worker's own behalf. Resolves with its answer. */
	#ask(method: string, params: unknown): Promise<Message> {
		const id = `kernic-${++this.#askedCount}`;
		const answer = new Promise<Message>((resolve) => {
			this.#asked.set(id, resolve);
			setTimeout(() => {
				if (this.#asked.delete(id)) resolve({ error: { message: 'no answer' } });
			}, PREVIEW_START_TIMEOUT_MS).unref();
		});
		this.#write({ jsonrpc: '2.0', id, method, params });
		return answer;
	}

	/** Starts the server's preview if it is not running, and connects to it. */
	#openPreview(): Promise<WebSocket> {
		if (!this.canJump || this.#exited) {
			return Promise.reject(new LanguageUnavailableError('Jumps are not available here.'));
		}
		if (this.#preview) {
			this.#preview.lastUsed = Date.now();
			return Promise.resolve(this.#preview.socket);
		}
		this.#previewStarting ??= this.#startPreview().finally(() => (this.#previewStarting = null));
		return this.#previewStarting;
	}

	async #startPreview(): Promise<WebSocket> {
		const view = languageView(this.#options.sandbox, this.#paths);
		const started = await this.#ask('workspace/executeCommand', {
			command: 'tinymist.doStartPreview',
			arguments: [
				[
					'--task-id',
					PREVIEW_TASK,
					// Any free port, on this machine only.
					'--data-plane-host',
					'127.0.0.1:0',
					'--no-open',
					'--partial-rendering',
					'true',
					path.join(view.sourceDir, this.#entry)
				]
			]
		});
		const port = (started.result as { dataPlanePort?: unknown } | undefined)?.dataPlanePort;
		if (typeof port !== 'number') {
			throw new LanguageUnavailableError('The preview for jumps could not be started.');
		}

		const address = `127.0.0.1:${port}`;
		// The preview expects the Origin a page it served itself would send.
		const socket = new WebSocket(`ws://${address}/`, {
			headers: { origin: `http://${address}` }
		} as never);
		socket.binaryType = 'arraybuffer';
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new LanguageUnavailableError('The preview for jumps did not answer.')),
				PREVIEW_START_TIMEOUT_MS
			);
			socket.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			socket.onerror = () => {
				clearTimeout(timer);
				reject(new LanguageUnavailableError('The preview for jumps could not be reached.'));
			};
		});
		socket.onerror = null;
		socket.onclose = () => {
			if (this.#preview?.socket === socket) this.#preview = null;
		};
		// Its first message is the document it compiled; before that it can answer nothing.
		// A document with errors never comes, so this is not waited for at any length.
		await new Promise<void>((resolve) => {
			socket.onmessage = () => resolve();
			setTimeout(resolve, PREVIEW_FIRST_DOCUMENT_MS).unref();
		});
		socket.onmessage = (event) => this.#fromPreview(event.data);
		this.#preview = { socket, lastUsed: Date.now() };
		return socket;
	}

	#closePreview(): void {
		this.#preview?.socket.close();
		this.#preview = null;
		void this.#ask('workspace/executeCommand', {
			command: 'tinymist.doKillPreview',
			arguments: [PREVIEW_TASK]
		});
	}

	/**
	 * A message of the preview. Most are renderings for a page view the worker
	 * does not have; the one of interest says where a place in the source is.
	 */
	#fromPreview(data: unknown): void {
		const head =
			typeof data === 'string'
				? data.slice(0, 512)
				: Buffer.from(
						data as ArrayBuffer,
						0,
						Math.min((data as ArrayBuffer).byteLength, 512)
					).toString('latin1');
		if (!head.startsWith('jump,')) return;
		const positions = head
			.slice('jump,'.length)
			.split(',')
			.map((part) => part.trim().split(' ').map(Number))
			.filter((numbers) => numbers.length === 3 && numbers.every(Number.isFinite))
			.map(([page, x, y]) => ({ page: page!, x: x!, y: y! }));
		this.#awaitingPage?.(positions);
		this.#awaitingPage = null;
	}

	/**
	 * The server asks to show a place in the source: its answer to "what is at
	 * this point of the page". Answered here; it is not the editor's to handle.
	 */
	#showDocument(message: Message): void {
		this.#write({ jsonrpc: '2.0', id: message.id, result: { success: true } });
		const params = message.params as
			| { uri?: unknown; selection?: { start?: { line?: unknown; character?: unknown } } }
			| undefined;
		const uri = typeof params?.uri === 'string' ? this.#outward(params.uri) : '';
		const start = params?.selection?.start;
		let found: SourcePosition | null = null;
		if (
			uri.startsWith(`${PROJECT_URI}/`) &&
			typeof start?.line === 'number' &&
			typeof start.character === 'number'
		) {
			try {
				found = {
					path: decodeURIComponent(uri.slice(PROJECT_URI.length + 1)),
					line: start.line,
					character: start.character
				};
			} catch {
				// not an address of a project file
			}
		}
		this.#awaitingSource?.(found);
		this.#awaitingSource = null;
	}

	#pinMain(): void {
		const view = languageView(this.#options.sandbox, this.#paths);
		void this.#ask('workspace/executeCommand', {
			command: 'tinymist.pinMain',
			arguments: [path.join(view.sourceDir, this.#entry)]
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
			if (typeof message.id === 'string' && message.method === undefined) {
				const asked = this.#asked.get(message.id);
				if (asked) {
					this.#asked.delete(message.id);
					asked(message);
					continue;
				}
			}
			// Nor is what the server says about its preview, which the editor never sees.
			if (message.method === 'window/showDocument') {
				this.#showDocument(message);
				continue;
			}
			if (
				typeof message.method === 'string' &&
				/^tinymist\/(preview\/|documentOutline$)/.test(message.method)
			) {
				continue;
			}
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

	/** Whether jumps between page and source can be offered on this worker. */
	get canJump(): boolean {
		return this.available && this.#options.sandbox !== 'bwrap';
	}

	/** Where on the pages a place in the source is. Null if there is no such language server. */
	async locate(
		name: string,
		position: SourcePosition,
		nearby: SourcePlace[] = []
	): Promise<PagePosition[] | null> {
		const session = this.#sessions.get(name);
		if (!session || session.exited) return null;
		return session.locate(position, nearby);
	}

	/** Which place in the source is at a point of a page. `undefined` if there is no such server. */
	async sourceAt(name: string, position: PagePosition): Promise<SourcePosition | null | undefined> {
		const session = this.#sessions.get(name);
		if (!session || session.exited) return undefined;
		return session.sourceAt(position);
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
			session.closeIdlePreview(now);
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

/** Whether a promise settled within the given time. */
function answeredWithin(answer: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([
		answer.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())
	]);
}

export { MAX_MESSAGE_BYTES };
