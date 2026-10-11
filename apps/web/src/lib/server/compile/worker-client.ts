import { KERNIC_WORKER_TOKEN, KERNIC_WORKER_URL } from '$app/env/private';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { PdfOptions } from '../../pdf-options';
import type { SnapshotFile } from './snapshot';

export type OutputFormat = 'svg' | 'pdf';

export interface Diagnostic {
	severity: 'error' | 'warning';
	message: string;
	path: string | null;
	line: number | null;
	column: number | null;
}

export interface WorkerArtifact {
	name: string;
	size: number;
	sha256: string;
	/** Base64 content; null for a page listed in the request's `knownPages`. */
	data: string | null;
	/** Page size in points, for SVG pages. */
	width?: number;
	height?: number;
}

export interface WorkerResult {
	ok: boolean;
	diagnostics: Diagnostic[];
	artifacts: WorkerArtifact[];
	durationMs: number;
	typstVersion: string;
	timedOut: boolean;
	/** Whether a compiler already running for the session produced the result. */
	warm?: boolean;
}

/** The worker could not be reached or misbehaved; unrelated to the document. */
export class WorkerUnavailableError extends Error {}

const REQUEST_TIMEOUT_MS = 120_000;
const authorization = { authorization: `Bearer ${KERNIC_WORKER_TOKEN}` };

async function workerFetch(pathname: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(`${KERNIC_WORKER_URL}${pathname}`, {
			...init,
			headers: { ...authorization, ...init.headers },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch (error) {
		throw new WorkerUnavailableError(
			`The compile worker at ${KERNIC_WORKER_URL} could not be reached.`,
			{ cause: error }
		);
	}
}

/**
 * The files changed between taking the snapshot and sending them to the worker.
 * The compile has to start over from a fresh snapshot.
 */
export class SnapshotChangedError extends Error {
	constructor() {
		super('The project files changed while they were being compiled.');
	}
}

async function uploadBlob(sha256: string, absolutePath: string): Promise<void> {
	// Read the file fully and check it still is what the snapshot recorded: a
	// save or a restore may have replaced it in the meantime.
	let content: Buffer;
	try {
		content = await readFile(absolutePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SnapshotChangedError();
		throw error;
	}
	if (createHash('sha256').update(content).digest('hex') !== sha256)
		throw new SnapshotChangedError();

	const response = await workerFetch(`/blobs/${sha256}`, {
		method: 'PUT',
		body: new Uint8Array(content)
	});
	if (!response.ok) {
		throw new WorkerUnavailableError(
			`The compile worker rejected a file (HTTP ${response.status}).`
		);
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Files of one package to make available to the document. */
export interface PackageInput {
	namespace: string;
	name: string;
	version: string;
	directory: string;
	files: { path: string; sha256: string }[];
}

/**
 * Compiles a snapshot. The worker caches files by hash: the request only lists
 * hashes, and the worker answers 409 with the ones it lacks, which are then
 * uploaded before retrying.
 */
export async function compileSnapshot(request: {
	entry: string;
	format: OutputFormat;
	/** Directory the snapshot was taken from. */
	root: string;
	files: SnapshotFile[];
	packages: PackageInput[];
	/** Hashes of rendered pages already stored here, which the worker need not send again. */
	knownPages?: string[];
	/**
	 * Names what is being edited. The worker may keep a compiler running per
	 * name, which makes the compiles that follow much faster.
	 */
	session?: string;
	/** Options of a PDF export. */
	pdf?: PdfOptions | null;
}): Promise<WorkerResult> {
	const body = JSON.stringify({
		entry: request.entry,
		format: request.format,
		files: request.files.map(reference),
		packages: request.packages.map(({ namespace, name, version, files }) => ({
			namespace,
			name,
			version,
			files: files.map(reference)
		})),
		knownPages: request.knownPages ?? [],
		session: request.session,
		pdf: request.pdf ?? undefined
	});

	return postSnapshot<WorkerResult>('/compile', body, request);
}

/** The worker has no room for this right now, or lacks what it needs; the message says which. */
export class WorkerRefusedError extends Error {}

/**
 * Sends a request that refers to files by hash. The worker answers 409 with
 * the hashes it lacks, which are then uploaded before trying again.
 */
async function postSnapshot<Result>(
	pathname: string,
	body: string,
	source: { root: string; files: SnapshotFile[]; packages: PackageInput[] }
): Promise<Result> {
	// Where to read each blob from, should the worker ask for it.
	const locations = new Map<string, string>();
	for (const file of source.files) {
		locations.set(file.sha256, path.join(source.root, ...file.path.split('/')));
	}
	for (const item of source.packages) {
		for (const file of item.files) {
			locations.set(file.sha256, path.join(item.directory, ...file.path.split('/')));
		}
	}

	for (let attempt = 0; attempt < 6; attempt++) {
		const response = await workerFetch(pathname, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body
		});

		if (response.status === 200) return (await response.json()) as Result;

		if (response.status === 409) {
			const { missing } = (await response.json()) as { missing: string[] };
			for (const sha256 of missing) {
				const location = locations.get(sha256);
				if (!location)
					throw new WorkerUnavailableError('The compile worker asked for an unknown file.');
				await uploadBlob(sha256, location);
			}
			continue;
		}

		if (response.status === 429) {
			await sleep(400 * (attempt + 1));
			continue;
		}

		if (response.status === 503) {
			const { error } = (await response.json().catch(() => ({}))) as { error?: string };
			throw new WorkerRefusedError(error ?? 'The compile worker cannot do this right now.');
		}

		const detail = await response.text().catch(() => '');
		throw new WorkerUnavailableError(
			`The compile worker answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}.`
		);
	}

	throw new WorkerUnavailableError('The compile worker is busy. Try again in a moment.');
}

const reference = (file: { path: string; sha256: string }) => ({
	path: file.path,
	sha256: file.sha256
});

/**
 * Starts a language server in the worker under `name`, or brings a running
 * one to these files. Throws `WorkerRefusedError` when the worker offers none.
 */
export async function startLanguageServer(request: {
	name: string;
	entry: string;
	root: string;
	files: SnapshotFile[];
	packages: PackageInput[];
}): Promise<void> {
	const body = JSON.stringify({
		entry: request.entry,
		files: request.files.map(reference),
		packages: request.packages.map(({ namespace, name, version, files }) => ({
			namespace,
			name,
			version,
			files: files.map(reference)
		}))
	});
	await postSnapshot(`/lsp/${request.name}`, body, request);
}

/** Passes protocol messages from an editor to its language server. False if it is gone. */
export async function sendToLanguageServer(name: string, messages: unknown[]): Promise<boolean> {
	const response = await workerFetch(`/lsp/${name}/messages`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ messages })
	});
	await response.body?.cancel();
	if (response.status === 404) return false;
	if (!response.ok) {
		throw new WorkerUnavailableError(`The compile worker answered HTTP ${response.status}.`);
	}
	return true;
}

/**
 * The messages of a language server, one JSON document per line, for as long
 * as it runs or until `signal` aborts. Null if there is no such server.
 */
export async function languageServerStream(
	name: string,
	signal: AbortSignal
): Promise<ReadableStream<Uint8Array> | null> {
	let response: Response;
	try {
		// No overall time limit: this stays open for as long as the editor does.
		response = await fetch(`${KERNIC_WORKER_URL}/lsp/${name}/stream`, {
			headers: authorization,
			signal
		});
	} catch (error) {
		throw new WorkerUnavailableError('The compile worker could not be reached.', { cause: error });
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		return null;
	}
	return response.body;
}

export async function stopLanguageServer(name: string): Promise<void> {
	const response = await workerFetch(`/lsp/${name}`, { method: 'DELETE' }).catch(() => null);
	await response?.body?.cancel();
}

export async function workerHealth(): Promise<{ ok: boolean; typstVersion?: string }> {
	try {
		const response = await fetch(`${KERNIC_WORKER_URL}/healthz`, {
			signal: AbortSignal.timeout(3_000)
		});
		if (!response.ok) return { ok: false };
		const body = (await response.json()) as { typstVersion?: string };
		return { ok: true, typstVersion: body.typstVersion };
	} catch {
		return { ok: false };
	}
}
