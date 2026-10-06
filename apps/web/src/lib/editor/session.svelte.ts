import {
	ApiError,
	type CompileJob,
	type Diagnostic,
	type ProjectApi,
	type TreeEntry,
	type UploadResult
} from './api.ts';

/**
 * State of one open project in the editor: the file tree, the open file and
 * its save state, and the compile/preview state. Components render this and
 * call its methods; it owns all talking to the server.
 */

export type SaveState =
	/** Everything typed is stored on the server. */
	| 'saved'
	/** There are edits that have not been sent yet. */
	| 'unsaved'
	| 'saving'
	/** The last save did not reach the server or was rejected. */
	| 'failed'
	/** The file changed on the server since it was opened here. */
	| 'conflict';

export type CompileState =
	| { status: 'idle' }
	| { status: 'compiling' }
	/** The preview shows the result of this compile. */
	| { status: 'done'; durationMs: number | null }
	/** The document has errors; see `diagnostics`. */
	| { status: 'failed' }
	/** The compile could not run at all (worker or server problem). */
	| { status: 'unavailable'; message: string };

export type OpenFile =
	| { kind: 'loading'; path: string }
	| { kind: 'text'; path: string; text: string; hash: string }
	| { kind: 'binary'; path: string; contentType: string; size: number }
	| { kind: 'unavailable'; path: string; message: string };

export interface Render {
	jobId: string;
	pageCount: number;
	/** Project revision these pages were rendered from. */
	revision: number | null;
}

const AUTOSAVE_DELAY_MS = 800;

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : 'Something went wrong.';
}

function isAbort(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

export class EditorSession {
	readonly api: ProjectApi;
	readonly canWrite: boolean;

	entries = $state<TreeEntry[]>([]);
	entryPath = $state('');
	/** Latest project revision this session knows about. */
	revision = $state(0);

	file = $state<OpenFile | null>(null);
	/** Increases whenever file content is loaded from the server; the editor is rebuilt then. */
	loadCount = $state(0);
	saveState = $state<SaveState>('saved');
	saveError = $state<string | null>(null);

	compile = $state<CompileState>({ status: 'idle' });
	render = $state<Render | null>(null);
	diagnostics = $state<Diagnostic[]>([]);
	typstVersion = $state<string | null>(null);

	exporting = $state(false);
	exportError = $state<string | null>(null);

	/** True when the pages on screen do not reflect the latest saved source. */
	readonly previewIsStale = $derived(
		this.render !== null && (this.render.revision !== this.revision || this.saveState !== 'saved')
	);

	readonly errorCount = $derived(
		this.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
	);
	readonly warningCount = $derived(this.diagnostics.length - this.errorCount);

	#readEditorText: (() => string) | null = null;
	#editCount = 0;
	#saveTimer: ReturnType<typeof setTimeout> | undefined;
	#saving: Promise<void> | null = null;
	#compiling = false;
	#compileAgain = false;
	#abort = new AbortController();

	constructor(
		api: ProjectApi,
		initial: {
			canWrite: boolean;
			entries: TreeEntry[];
			entryPath: string;
			revision: number;
			render: Render | null;
		}
	) {
		this.api = api;
		this.canWrite = initial.canWrite;
		this.entries = initial.entries;
		this.entryPath = initial.entryPath;
		this.revision = initial.revision;
		this.render = initial.render;
	}

	/** Call when the editor goes away. Edits still waiting for autosave are sent now. */
	dispose(): void {
		if (this.saveState === 'unsaved') void this.save();
		clearTimeout(this.#saveTimer);
		this.#abort.abort();
	}

	// --- Open file ----------------------------------------------------------

	/** The source editor registers how to read its current text. */
	attachEditor(readText: (() => string) | null): void {
		this.#readEditorText = readText;
	}

	hasEntry(path: string): boolean {
		return this.entries.some((entry) => entry.path === path && entry.type === 'file');
	}

	/**
	 * Opens a file in the editor. Pending edits to the current file are saved
	 * first; if that fails the current file stays open so nothing is lost.
	 */
	async open(path: string): Promise<boolean> {
		if (this.file?.path === path && this.file.kind !== 'unavailable') return true;
		if (!(await this.flush())) return false;

		this.file = { kind: 'loading', path };
		try {
			const loaded = await this.api.readFile(path);
			// Another open() may have started while this one was loading.
			if (this.file?.path !== path) return false;
			this.file = { path, ...loaded };
			this.loadCount++;
		} catch (error) {
			if (this.file?.path !== path) return false;
			this.file = { kind: 'unavailable', path, message: messageOf(error) };
			return false;
		}
		this.saveState = 'saved';
		this.saveError = null;
		return true;
	}

	/** Called by the source editor on every change to the document. */
	noteEdit(): void {
		this.#editCount++;
		if (this.saveState === 'conflict') return;
		this.saveState = 'unsaved';
		this.#scheduleSave();
	}

	#scheduleSave(): void {
		clearTimeout(this.#saveTimer);
		this.#saveTimer = setTimeout(() => void this.save(), AUTOSAVE_DELAY_MS);
	}

	/** Sends the current text to the server, unless a save is already running. */
	async save(): Promise<void> {
		clearTimeout(this.#saveTimer);
		if (this.#saving) return this.#saving;

		const file = this.file;
		if (file?.kind !== 'text' || !this.#readEditorText || !this.canWrite) return;
		if (this.saveState !== 'unsaved' && this.saveState !== 'failed') return;

		this.#saving = this.#saveNow(file, this.#readEditorText()).finally(() => {
			this.#saving = null;
		});
		return this.#saving;
	}

	async #saveNow(file: Extract<OpenFile, { kind: 'text' }>, text: string): Promise<void> {
		const editsAtStart = this.#editCount;
		this.saveState = 'saving';
		this.saveError = null;

		try {
			const { hash, revision } = await this.api.saveFile(file.path, text, file.hash);
			file.hash = hash;
			this.revision = revision;
		} catch (error) {
			if (error instanceof ApiError && error.code === 'conflict') {
				this.saveState = 'conflict';
			} else {
				this.saveState = 'failed';
				this.saveError = messageOf(error);
			}
			return;
		}

		// Typing continued while the request was in flight: save again shortly.
		if (this.#editCount !== editsAtStart) {
			this.saveState = 'unsaved';
			this.#scheduleSave();
		} else {
			this.saveState = 'saved';
		}
		this.requestCompile();
	}

	/** Saves until nothing is pending. Returns false if edits could not be stored. */
	async flush(): Promise<boolean> {
		for (let attempt = 0; attempt < 4; attempt++) {
			if (this.saveState === 'saved') return true;
			if (this.saveState === 'conflict') return false;
			await this.save();
			if (this.saveState === 'failed') return false;
		}
		return this.saveState === 'saved';
	}

	/** Resolves a conflict by discarding local edits and loading the server's version. */
	async reloadFromServer(): Promise<void> {
		const path = this.file?.path;
		if (!path) return;
		this.saveState = 'saved';
		this.file = null;
		await this.open(path);
	}

	/** Resolves a conflict by replacing the server's version with the local text. */
	async overwriteServerVersion(): Promise<void> {
		const file = this.file;
		if (file?.kind !== 'text') return;
		try {
			const current = await this.api.readFile(file.path);
			file.hash = current.kind === 'text' ? current.hash : file.hash;
		} catch (error) {
			// The file was deleted elsewhere: saving recreates it.
			if (error instanceof ApiError && error.status === 404) file.hash = 'none';
			else {
				this.saveError = messageOf(error);
				return;
			}
		}
		this.saveState = 'unsaved';
		await this.save();
	}

	// --- Compile and preview --------------------------------------------------

	/** Compiles the saved project. Requests made while compiling are coalesced. */
	requestCompile(): void {
		if (this.#compiling) {
			this.#compileAgain = true;
			return;
		}
		void this.#compileLoop();
	}

	async #compileLoop(): Promise<void> {
		this.#compiling = true;
		try {
			do {
				this.#compileAgain = false;
				this.compile = { status: 'compiling' };
				const queued = await this.api.compile('svg');
				this.#applyResult(await this.api.waitForJob(queued.id, this.#abort.signal));
			} while (this.#compileAgain);
		} catch (error) {
			if (!isAbort(error)) this.compile = { status: 'unavailable', message: messageOf(error) };
		} finally {
			this.#compiling = false;
		}
	}

	#applyResult(job: CompileJob): void {
		if (job.typstVersion) this.typstVersion = job.typstVersion;

		if (job.status === 'succeeded') {
			this.render = { jobId: job.id, pageCount: job.pageCount ?? 0, revision: job.revision };
			this.diagnostics = job.diagnostics;
			this.compile = { status: 'done', durationMs: job.durationMs };
		} else if (job.status === 'failed') {
			this.diagnostics = job.diagnostics;
			this.compile = { status: 'failed' };
		} else {
			this.compile = {
				status: 'unavailable',
				message: job.error ?? 'The compile did not finish.'
			};
		}

		// The project changed after this job took its snapshot.
		if (job.revision !== null && job.revision < this.revision) this.#compileAgain = true;
	}

	/** Compiles a PDF from the saved project and returns its download URL. */
	async exportPdf(): Promise<string | null> {
		this.exportError = null;
		if (!(await this.flush())) {
			this.exportError = 'Save your changes first; the last save did not succeed.';
			return null;
		}

		this.exporting = true;
		try {
			const queued = await this.api.compile('pdf');
			const job = await this.api.waitForJob(queued.id, this.#abort.signal);
			if (job.status === 'succeeded') return this.api.pdfUrl(job.id);

			if (job.status === 'failed') {
				this.diagnostics = job.diagnostics;
				this.exportError = 'The document has errors. Fix them to export a PDF.';
			} else {
				this.exportError = job.error ?? 'The export did not finish.';
			}
			return null;
		} catch (error) {
			if (!isAbort(error)) this.exportError = messageOf(error);
			return null;
		} finally {
			this.exporting = false;
		}
	}

	// --- File tree ------------------------------------------------------------

	async refreshTree(): Promise<void> {
		const { entries, revision } = await this.api.tree();
		this.entries = entries;
		this.revision = Math.max(this.revision, revision);
	}

	async createFile(path: string): Promise<void> {
		await this.api.createEntry('file', path);
		await this.refreshTree();
		await this.open(path);
		this.requestCompile();
	}

	async createFolder(path: string): Promise<void> {
		await this.api.createEntry('directory', path);
		await this.refreshTree();
	}

	/** Renames or moves an entry. The open file follows if it was moved. */
	async move(from: string, to: string): Promise<void> {
		if (!(await this.flush())) throw new Error('Save your changes before renaming.');

		const { entryPath } = await this.api.move(from, to);
		this.entryPath = entryPath;
		const open = this.file;
		if (open) {
			if (open.path === from) open.path = to;
			else if (open.path.startsWith(`${from}/`)) open.path = to + open.path.slice(from.length);
		}
		await this.refreshTree();
		this.requestCompile();
	}

	async remove(path: string): Promise<void> {
		const open = this.file;
		const closesOpenFile = !!open && (open.path === path || open.path.startsWith(`${path}/`));
		if (closesOpenFile) {
			// The file is going away; its pending edits go with it.
			clearTimeout(this.#saveTimer);
			this.saveState = 'saved';
		}

		await this.api.remove(path);
		await this.refreshTree();
		if (closesOpenFile) {
			this.file = null;
			const next = this.hasEntry(this.entryPath)
				? this.entryPath
				: this.entries.find((entry) => entry.type === 'file')?.path;
			if (next) await this.open(next);
		}
		this.requestCompile();
	}

	async upload(directory: string, files: File[]): Promise<UploadResult[]> {
		const { results } = await this.api.upload(directory, files);
		await this.refreshTree();
		if (results.some((result) => result.stored)) this.requestCompile();
		return results;
	}
}
