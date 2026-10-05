/** Browser-side client for the project API under /api/projects/:id. */

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

export interface CompileJob {
	id: string;
	format: 'svg' | 'pdf';
	status: 'queued' | 'running' | 'succeeded' | 'failed' | 'errored';
	revision: number | null;
	diagnostics: Diagnostic[];
	pageCount: number | null;
	typstVersion: string | null;
	durationMs: number | null;
	error: string | null;
}

export type LoadedFile =
	| { kind: 'text'; text: string; hash: string }
	| { kind: 'binary'; contentType: string; size: number };

export interface UploadResult {
	name: string;
	path?: string;
	stored: boolean;
	message?: string;
}

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
		// The session ended; signing in again returns to this page.
		location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
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
		pageUrl: (jobId: string, page: number) => `${base}/jobs/${jobId}/pages/${page}`,
		pdfUrl: (jobId: string) => `${base}/jobs/${jobId}/pdf`,
		archiveUrl: `${base}/archive`,

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

		async compile(format: 'svg' | 'pdf'): Promise<CompileJob> {
			return (
				(await (await request(`${base}/compile`, json({ format }))).json()) as { job: CompileJob }
			).job;
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
