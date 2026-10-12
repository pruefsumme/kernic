/** Browser-side client for the project API under /api/projects/:id. */

import type { PdfOptions } from '#lib/pdf-options.ts';
import type { Place } from './jump.ts';

export interface TreeEntry {
	path: string;
	type: 'file' | 'directory';
	size: number;
}

export interface Diagnostic {
	severity: 'error' | 'warning';
	message: string;
	path: string | null;
	line: number | null;
	column: number | null;
}

export interface RenderedPage {
	/** Hash of the page's content; the page's address. */
	hash: string;
	/** Size in points. */
	width: number;
	height: number;
}

export interface CompileJob {
	id: string;
	format: 'svg' | 'pdf';
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'errored';
	revision: number | null;
	diagnostics: Diagnostic[];
	pageCount: number | null;
	pages: RenderedPage[] | null;
	typstVersion: string | null;
	durationMs: number | null;
	error: string | null;
}

export interface Checkpoint {
	id: string;
	message: string;
	authorName: string;
	createdAt: Date;
}

export interface Snapshot {
	id: string;
	createdAt: Date;
}

export interface Change {
	path: string;
	kind: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface FileDiff {
	path: string;
	previousPath: string | null;
	kind: Change['kind'];
	binary: boolean;
	lines: { kind: 'context' | 'added' | 'removed' | 'hunk'; text: string }[];
	truncated: boolean;
}

export type LoadedFile =
	| { kind: 'text'; text: string; hash: string }
	| { kind: 'binary'; contentType: string; size: number };

/** A place where searched text occurs; see the server's `SearchMatch`. */
export interface SearchMatch {
	path: string;
	line: number;
	column: number;
	preview: string;
	start: number;
	length: number;
}

export interface UploadResult {
	name: string;
	path?: string;
	stored: boolean;
	message?: string;
}

/** The Git repository a project's checkpoints are pushed to. */
export interface RemoteStatus {
	url: string;
	branch: string;
	lastPushedAt: Date | null;
	/** Checkpoints the repository does not have yet. */
	unpushed: number;
}

interface RemoteStatusBody {
	remote: { url: string; branch: string; lastPushedAt: string | null };
	unpushed: number;
}

const toRemoteStatus = (body: RemoteStatusBody | null): RemoteStatus | null =>
	body && {
		url: body.remote.url,
		branch: body.remote.branch,
		lastPushedAt: body.remote.lastPushedAt ? new Date(body.remote.lastPushedAt) : null,
		unpushed: body.unpushed
	};

/** A file that both the project and its repository changed. */
export interface PullConflict {
	path: string;
	kind: 'both-changed' | 'both-added' | 'deleted-here' | 'deleted-there';
}

export type PullOutcome = { remote: RemoteStatus | null } & (
	| { status: 'up-to-date' }
	| { status: 'merged'; fastForward: boolean; changed: number; revision: number }
	| {
			status: 'conflicts';
			conflicts: PullConflict[];
			/** The two versions the conflicts are about, to be sent back with the choices. */
			ours: string;
			theirs: string;
			recorded: boolean;
	  }
);

export class ApiError extends Error {
	readonly status: number;
	/** Machine-readable reason from the server, e.g. `conflict`. */
	readonly code: string | undefined;

	constructor(status: number, message: string, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

/** The request never reached the server (offline, server down). */
export class NetworkError extends Error {
	constructor() {
		super('The server could not be reached. Check your connection.');
	}
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

async function request(url: string, init?: RequestInit): Promise<Response> {
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		if (error instanceof DOMException && error.name === 'AbortError') throw error;
		throw new NetworkError();
	}
	if (response.ok) return response;

	if (response.status === 401) {
		// Do not navigate to the sign-in page from here: that would discard edits
		// that are still only in this tab.
		throw new ApiError(
			401,
			'You have been signed out. Sign in again in another tab, then try again here.',
			'signed-out'
		);
	}
	const body = (await response.json().catch(() => null)) as {
		message?: string;
		code?: string;
	} | null;
	throw new ApiError(
		response.status,
		body?.message ?? `The server answered with an error (${response.status}).`,
		body?.code
	);
}

const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});

/** Text files above this size are not opened in the editor. */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

export function createProjectApi(projectId: string) {
	const base = `/api/projects/${projectId}`;

	return {
		fileUrl: (path: string) => `${base}/files/${encodePath(path)}`,
		pageUrl: (hash: string) => `${base}/pages/${hash}`,
		pdfUrl: (jobId: string) => `${base}/jobs/${jobId}/pdf`,
		archiveUrl: `${base}/archive`,

		/** Finds text in the saved files of the project. */
		async search(
			query: string,
			signal: AbortSignal
		): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
			return (await request(`${base}/search?q=${encodeURIComponent(query)}`, { signal })).json();
		},

		async tree(): Promise<{ entries: TreeEntry[]; revision: number }> {
			return (await request(`${base}/tree`)).json();
		},

		async readFile(path: string): Promise<LoadedFile> {
			const response = await request(`${base}/files/${encodePath(path)}`);
			const size = Number(response.headers.get('content-length') ?? '0');
			if (response.headers.get('x-kernic-text') !== '1' || size > MAX_EDITABLE_BYTES) {
				await response.body?.cancel();
				return {
					kind: 'binary',
					contentType: response.headers.get('content-type') ?? 'application/octet-stream',
					size
				};
			}
			return {
				kind: 'text',
				text: await response.text(),
				hash: response.headers.get('x-kernic-hash') ?? ''
			};
		},

		/** `baseHash` is the hash of the content this edit started from. */
		async saveFile(
			path: string,
			text: string,
			baseHash: string
		): Promise<{ hash: string; revision: number }> {
			const response = await request(`${base}/files/${encodePath(path)}`, {
				method: 'PUT',
				headers: {
					'content-type': 'text/plain; charset=utf-8',
					'x-kernic-base-hash': baseHash,
					'x-kernic-source': 'editor'
				},
				body: text
			});
			return response.json();
		},

		async createEntry(type: 'file' | 'directory', path: string): Promise<{ revision: number }> {
			return (await request(`${base}/entries`, json({ type, path }))).json();
		},

		async move(from: string, to: string): Promise<{ revision: number; entryPath: string }> {
			return (await request(`${base}/move`, json({ from, to }))).json();
		},

		async remove(path: string): Promise<{ revision: number }> {
			return (await request(`${base}/files/${encodePath(path)}`, { method: 'DELETE' })).json();
		},

		async upload(
			directory: string,
			files: File[]
		): Promise<{ results: UploadResult[]; revision: number }> {
			const form = new FormData();
			form.set('directory', directory);
			for (const file of files) form.append('files', file);
			return (await request(`${base}/upload`, { method: 'POST', body: form })).json();
		},

		/** Opens a connection to a language server, or says why there is none. */
		async openLanguage(): Promise<{ id: string; jump: boolean } | { unavailable: string }> {
			const response = await fetch(`${base}/lsp`, { method: 'POST' });
			if (response.status === 503) return response.json();
			if (!response.ok) throw new ApiError(response.status, 'Editor assistance could not start.');
			return response.json();
		},

		languageEventsUrl: (connection: string) => `${base}/lsp/${connection}`,

		/** Sends protocol messages (as JSON texts) to the language server, in order. */
		async sendLanguage(connection: string, messages: string[]): Promise<void> {
			await request(`${base}/lsp/${connection}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: `{"messages":[${messages.join(',')}]}`
			});
		},

		/** Asks where a place in the source is on the pages, or what is at a point of a page. */
		async jump(
			connection: string,
			place:
				| { path: string; line: number; character: number; nearby?: Place[] }
				| { page: number; x: number; y: number }
		): Promise<{
			positions?: { page: number; x: number; y: number }[];
			source?: { path: string; line: number; character: number } | null;
		}> {
			return (await request(`${base}/lsp/${connection}/jump`, json(place))).json();
		},

		async refreshLanguage(connection: string): Promise<void> {
			await request(`${base}/lsp/${connection}`, { method: 'PUT' });
		},

		async closeLanguage(connection: string): Promise<void> {
			await fetch(`${base}/lsp/${connection}`, { method: 'DELETE', keepalive: true });
		},

		/** Font families installed on the server; empty if they cannot be listed right now. */
		async fonts(): Promise<string[]> {
			const body = (await (await request('/api/fonts')).json()) as { families: string[] };
			return body.families;
		},

		async compile(format: 'svg' | 'pdf', options?: PdfOptions): Promise<CompileJob> {
			return (
				(await (await request(`${base}/compile`, json({ format, options }))).json()) as {
					job: CompileJob;
				}
			).job;
		},

		checkpointArchiveUrl: (checkpointId: string) => `${base}/history/${checkpointId}/archive`,

		async history(): Promise<{
			checkpoints: Checkpoint[];
			snapshots: Snapshot[];
			changes: Change[];
			remote: RemoteStatus | null;
		}> {
			const body = (await (await request(`${base}/history`)).json()) as {
				checkpoints: (Omit<Checkpoint, 'createdAt'> & { createdAt: string })[];
				snapshots: { id: string; createdAt: string }[];
				changes: Change[];
				remote: RemoteStatusBody | null;
			};
			const withDate = <T extends { createdAt: string }>(item: T) => ({
				...item,
				createdAt: new Date(item.createdAt)
			});
			return {
				changes: body.changes,
				remote: toRemoteStatus(body.remote),
				checkpoints: body.checkpoints.map(withDate),
				snapshots: body.snapshots.map(withDate)
			};
		},

		async createCheckpoint(message: string): Promise<void> {
			await request(`${base}/history`, json({ message }));
		},

		/**
		 * Takes over what the project's repository has. If both sides changed the
		 * same files nothing is applied and they are listed; send the versions
		 * back with a choice for each file to settle them.
		 */
		async pull(settle?: {
			choices: Record<string, 'ours' | 'theirs'>;
			ours: string;
			theirs: string;
		}): Promise<PullOutcome> {
			const body = (await (await request(`${base}/history/pull`, json(settle ?? {}))).json()) as {
				remote: RemoteStatusBody | null;
			} & Record<string, unknown>;
			return { ...body, remote: toRemoteStatus(body.remote) } as PullOutcome;
		},

		/** Pushes the checkpoints to the project's repository and returns where that stands now. */
		async push(): Promise<RemoteStatus | null> {
			const body = (await (await request(`${base}/history/push`, json({}))).json()) as {
				remote: RemoteStatusBody | null;
			};
			return toRemoteStatus(body.remote);
		},

		/** Changes of a checkpoint, since a snapshot, or of the current files with `working`. */
		async diff(checkpointId: string | 'working'): Promise<FileDiff[]> {
			return (
				(await (await request(`${base}/history/${checkpointId}/diff`)).json()) as {
					files: FileDiff[];
				}
			).files;
		},

		async restoreCheckpoint(checkpointId: string): Promise<{ revision: number }> {
			return (await request(`${base}/history/${checkpointId}/restore`, json({}))).json();
		},

		/** Long-polls until the job has finished. */
		async waitForJob(jobId: string, signal: AbortSignal): Promise<CompileJob> {
			for (;;) {
				const response = await request(`${base}/jobs/${jobId}?wait=1`, { signal });
				const { job } = (await response.json()) as { job: CompileJob };
				if (job.status !== 'queued' && job.status !== 'running') return job;
			}
		}
	};
}

export type ProjectApi = ReturnType<typeof createProjectApi>;
