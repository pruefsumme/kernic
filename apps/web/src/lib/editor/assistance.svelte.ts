import {
	findReferencesKeymap,
	formatKeymap,
	hoverTooltips,
	jumpToDefinitionKeymap,
	LSPClient,
	LSPPlugin,
	renameKeymap,
	serverCompletion,
	signatureHelp,
	Workspace,
	type Transport,
	type WorkspaceFile
} from '@codemirror/lsp-client';
import type { Extension, Text } from '@codemirror/state';
import { keymap, type EditorView } from '@codemirror/view';
import type { ProjectApi } from './api.ts';
import type { Place } from './jump.ts';

/**
 * Editor assistance from a language server (Tinymist) on the server:
 * completion of functions, labels and citations, documentation on hover,
 * signature help, go to definition, rename and formatting.
 *
 * It is an extra. The editor works without it, and whenever the connection is
 * lost or refused the state says so and a new one is tried later.
 */

const ROOT_URI = 'file:///project';

/** The address of a project file as the language server knows it. */
export const fileUri = (path: string) =>
	`${ROOT_URI}/${path.split('/').map(encodeURIComponent).join('/')}`;

/** The project path behind an address, or null for anything outside the project. */
export function pathOfUri(uri: string): string | null {
	if (!uri.startsWith(`${ROOT_URI}/`)) return null;
	try {
		return uri
			.slice(ROOT_URI.length + 1)
			.split('/')
			.map(decodeURIComponent)
			.join('/');
	} catch {
		return null;
	}
}

const ALLOWED_TAGS = new Set(
	'P BR CODE PRE EM STRONG B I DEL SUB SUP UL OL LI H1 H2 H3 H4 H5 H6 HR BLOCKQUOTE SPAN DIV TABLE THEAD TBODY TR TH TD A'.split(
		' '
	)
);
const DROPPED_TAGS = new Set('SCRIPT STYLE IFRAME OBJECT EMBED TEMPLATE NOSCRIPT'.split(' '));

/**
 * Documentation arrives as Markdown, which may carry HTML written by whoever
 * wrote the document or a package it uses. Only plain formatting survives:
 * a fixed set of elements, `class` for code highlighting, and web links.
 */
export function sanitizeDocumentation(html: string): string {
	const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');

	const clean = (parent: Element) => {
		for (const element of [...parent.children]) {
			if (DROPPED_TAGS.has(element.tagName)) {
				element.remove();
				continue;
			}
			if (!ALLOWED_TAGS.has(element.tagName)) {
				element.replaceWith(parsed.createTextNode(element.textContent ?? ''));
				continue;
			}
			for (const attribute of [...element.attributes]) {
				const keep =
					attribute.name === 'class' ||
					(element.tagName === 'A' &&
						attribute.name === 'href' &&
						/^https?:\/\//i.test(attribute.value));
				if (!keep) element.removeAttribute(attribute.name);
			}
			if (element.tagName === 'A') {
				element.setAttribute('target', '_blank');
				element.setAttribute('rel', 'noreferrer noopener');
			}
			clean(element);
		}
	};
	clean(parsed.body);
	return parsed.body.innerHTML;
}

interface OpenFile extends WorkspaceFile {
	view: EditorView;
}

/** The files open in the editor: one view per file, as the editor shows one file at a time. */
class ProjectWorkspace extends Workspace {
	files: OpenFile[] = [];
	readonly #versions = new Map<string, number>();
	readonly #display: (path: string) => Promise<EditorView | null>;

	constructor(client: LSPClient, display: (path: string) => Promise<EditorView | null>) {
		super(client);
		this.#display = display;
	}

	#nextVersion(uri: string): number {
		const version = (this.#versions.get(uri) ?? -1) + 1;
		this.#versions.set(uri, version);
		return version;
	}

	syncFiles() {
		const updates = [];
		for (const file of this.files) {
			const plugin = LSPPlugin.get(file.view);
			if (!plugin || plugin.unsyncedChanges.empty) continue;
			updates.push({ changes: plugin.unsyncedChanges, file, prevDoc: file.doc });
			file.doc = file.view.state.doc;
			file.version = this.#nextVersion(file.uri);
			plugin.clear();
		}
		return updates;
	}

	openFile(uri: string, languageId: string, view: EditorView) {
		// A file that is loaded again gets a new view before the old one is gone.
		if (this.getFile(uri)) this.#forget(uri);
		const doc: Text = view.state.doc;
		const file: OpenFile = {
			uri,
			languageId,
			version: this.#nextVersion(uri),
			doc,
			view,
			getView: () => view
		};
		this.files.push(file);
		this.client.didOpen(file);
	}

	closeFile(uri: string, view: EditorView) {
		if (this.files.some((file) => file.uri === uri && file.view === view)) this.#forget(uri);
	}

	#forget(uri: string) {
		this.files = this.files.filter((file) => file.uri !== uri);
		this.client.didClose(uri);
	}

	/** Go to definition and find references may lead into another file of the project. */
	async displayFile(uri: string): Promise<EditorView | null> {
		if (typeof uri !== 'string') return null;
		const open = this.getFile(uri);
		if (open) return open.getView();
		const path = pathOfUri(uri);
		return path === null ? null : this.#display(path);
	}
}

/** Carries protocol messages over plain HTTP: posts one way, server-sent events the other. */
class HttpTransport implements Transport {
	readonly connection: string;
	readonly #api: ProjectApi;
	readonly #onLost: () => void;
	readonly #handlers = new Set<(message: string) => void>();
	readonly #events: EventSource;
	#queue: string[] = [];
	#sending = false;
	#closed = false;

	constructor(api: ProjectApi, connection: string, onLost: () => void) {
		this.#api = api;
		this.connection = connection;
		this.#onLost = onLost;
		this.#events = new EventSource(api.languageEventsUrl(connection));
		this.#events.onmessage = (event) => {
			for (const handler of this.#handlers) handler(event.data as string);
		};
		// The browser would reconnect by itself, to a language server that has
		// forgotten everything; a fresh connection is opened instead.
		this.#events.addEventListener('end', () => this.#lose());
		this.#events.onerror = () => this.#lose();
	}

	send(message: string): void {
		// An editor that is being closed still says goodbye for its file; once the
		// connection is gone there is nobody to tell, and nothing to report.
		if (this.#closed) return;
		this.#queue.push(message);
		void this.#flush();
	}

	subscribe(handler: (message: string) => void): void {
		this.#handlers.add(handler);
	}

	unsubscribe(handler: (message: string) => void): void {
		this.#handlers.delete(handler);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#events.close();
		void this.#api.closeLanguage(this.connection).catch(() => {});
	}

	/** Resolves once everything written so far has reached the server. */
	async sent(): Promise<void> {
		while ((this.#sending || this.#queue.length > 0) && !this.#closed) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	/** Messages go out in the order they were written, a batch at a time. */
	async #flush(): Promise<void> {
		if (this.#sending) return;
		this.#sending = true;
		while (this.#queue.length > 0 && !this.#closed) {
			const batch = this.#queue.splice(0);
			try {
				await this.#api.sendLanguage(this.connection, batch);
			} catch {
				this.#lose();
			}
		}
		this.#sending = false;
	}

	#lose(): void {
		if (this.#closed) return;
		this.close();
		this.#onLost();
	}
}

const RETRY_DELAYS_MS = [2_000, 10_000, 30_000, 60_000];

export class Assistance {
	/** `ready` while a language server answers; `unavailable` with a reason when none can be had. */
	status = $state<'idle' | 'connecting' | 'ready' | 'unavailable'>('idle');
	reason = $state<string | null>(null);
	/** Whether the server can tell which place on a page belongs to which place in the source. */
	canJump = $state(false);

	readonly client: LSPClient;
	readonly #api: ProjectApi;
	#transport: HttpTransport | null = null;
	#attempts = 0;
	#retry: ReturnType<typeof setTimeout> | undefined;
	#refresh: ReturnType<typeof setTimeout> | undefined;
	#disposed = false;

	constructor(api: ProjectApi, display: (path: string) => Promise<EditorView | null>) {
		this.#api = api;
		this.client = new LSPClient({
			rootUri: ROOT_URI,
			timeout: 5_000,
			sanitizeHTML: sanitizeDocumentation,
			workspace: (client) => new ProjectWorkspace(client, display),
			extensions: [
				// The language server knows everything the built-in lists offer, and more.
				serverCompletion({ override: true }),
				hoverTooltips(),
				signatureHelp(),
				keymap.of([
					...formatKeymap,
					...renameKeymap,
					...jumpToDefinitionKeymap,
					...findReferencesKeymap
				])
			]
		});
	}

	/** What to add to the editor of a file for it to be assisted, or null. */
	extensionFor(path: string): Extension | null {
		if (this.status !== 'ready' || !/\.typ$/i.test(path)) return null;
		return this.client.plugin(fileUri(path), 'typst');
	}

	async connect(): Promise<void> {
		if (this.#disposed || this.status === 'connecting' || this.status === 'ready') return;
		this.status = 'connecting';
		clearTimeout(this.#retry);

		try {
			const opened = await this.#api.openLanguage();
			if (this.#disposed) {
				if ('id' in opened) void this.#api.closeLanguage(opened.id).catch(() => {});
				return;
			}
			if ('unavailable' in opened) {
				this.#fail(opened.unavailable);
				return;
			}
			const transport = new HttpTransport(this.#api, opened.id, () => this.#lost(transport));
			this.#transport = transport;
			await this.client.connect(transport).initializing;
			if (this.#transport !== transport) return;
			this.#attempts = 0;
			this.reason = null;
			this.canJump = opened.jump;
			this.status = 'ready';
		} catch {
			if (this.client.connected) this.client.disconnect();
			this.#transport?.close();
			this.#transport = null;
			this.#fail('Editor assistance could not be reached.');
		}
	}

	/**
	 * Where on the rendered pages a place in the source ends up: each time the
	 * page (counted from 1) and a point on it in points. If the place prints
	 * nothing itself, the first of `nearby` that does answers. Empty if nowhere, or unknown.
	 */
	async pageOf(
		path: string,
		place: Place,
		nearby: Place[]
	): Promise<{ page: number; x: number; y: number }[]> {
		const connection = await this.#settled();
		if (!connection) return [];
		const answer = await this.#api.jump(connection, { path, ...place, nearby }).catch(() => null);
		return answer?.positions ?? [];
	}

	/** Which place in the source made what is at a point of a page. Null if nothing, or unknown. */
	async sourceOf(
		page: number,
		x: number,
		y: number
	): Promise<{ path: string; line: number; character: number } | null> {
		const connection = await this.#settled();
		if (!connection) return null;
		const answer = await this.#api.jump(connection, { page, x, y }).catch(() => null);
		return answer?.source ?? null;
	}

	/**
	 * The connection to ask over, once the server has what was typed: its answer
	 * is about the text it knows, which has to be the text on screen.
	 */
	async #settled(): Promise<string | null> {
		const transport = this.#transport;
		if (!transport || !this.canJump || this.status !== 'ready') return null;
		this.client.sync();
		await transport.sent();
		return this.#transport === transport ? transport.connection : null;
	}

	/** Tells the language server that files of the project changed on the server. */
	projectChanged(): void {
		clearTimeout(this.#refresh);
		this.#refresh = setTimeout(() => {
			const connection = this.#transport;
			if (!connection || this.status !== 'ready') return;
			void this.#api.refreshLanguage(connection.connection).catch(() => {});
		}, 600);
	}

	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#retry);
		clearTimeout(this.#refresh);
		if (this.client.connected) this.client.disconnect();
		this.#transport?.close();
		this.#transport = null;
		this.canJump = false;
		this.status = 'idle';
	}

	#lost(transport: HttpTransport): void {
		if (this.#transport !== transport || this.#disposed) return;
		this.#transport = null;
		if (this.client.connected) this.client.disconnect();
		this.canJump = false;
		this.status = 'idle';
		this.#schedule();
	}

	#fail(reason: string): void {
		this.reason = reason;
		this.status = 'unavailable';
		this.#schedule();
	}

	/** Tries again later, a few times; after that only when the editor is opened anew. */
	#schedule(): void {
		const delay = RETRY_DELAYS_MS[this.#attempts++];
		if (delay === undefined || this.#disposed) return;
		this.#retry = setTimeout(() => {
			this.status = 'idle';
			void this.connect();
		}, delay);
	}
}
