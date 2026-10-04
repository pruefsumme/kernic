import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { BlobError, BlobStore } from './blobs.ts';
import {
	Compiler,
	InvalidRequestError,
	MissingBlobsError,
	parseCompileRequest
} from './compile.ts';
import type { WorkerConfig } from './config.ts';
import { isSha256 } from './paths.ts';
import { detectToolchain, type Toolchain } from './sandbox.ts';

const MAX_REQUEST_JSON_BYTES = 2 * 1024 * 1024;

/** Runs at most `maxConcurrent` tasks and rejects new ones once `maxQueued` are waiting. */
class Limiter {
	readonly #maxConcurrent: number;
	readonly #maxQueued: number;
	readonly #waiting: Array<() => void> = [];
	#running = 0;

	constructor(maxConcurrent: number, maxQueued: number) {
		this.#maxConcurrent = maxConcurrent;
		this.#maxQueued = maxQueued;
	}

	/** Returns null when the queue is full. */
	async run<T>(task: () => Promise<T>): Promise<{ value: T } | null> {
		if (this.#running >= this.#maxConcurrent) {
			if (this.#waiting.length >= this.#maxQueued) return null;
			await new Promise<void>((resolve) => this.#waiting.push(resolve));
		}
		this.#running++;
		try {
			return { value: await task() };
		} finally {
			this.#running--;
			this.#waiting.shift()?.();
		}
	}
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	response.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(payload)
	});
	response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let received = 0;
	for await (const chunk of request as AsyncIterable<Buffer>) {
		received += chunk.length;
		if (received > MAX_REQUEST_JSON_BYTES)
			throw new InvalidRequestError('request body is too large');
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new InvalidRequestError('request body is not valid JSON');
	}
}

export interface Worker {
	server: Server;
	toolchain: Toolchain;
}

export async function createWorker(config: WorkerConfig): Promise<Worker> {
	const toolchain = await detectToolchain(config.typstBin, config.sandbox);

	const blobs = new BlobStore(path.join(config.workDir, 'blobs'), {
		maxBlobBytes: config.limits.maxBlobBytes,
		cacheBytes: config.limits.blobCacheBytes
	});
	await blobs.open();

	const compiler = new Compiler({
		blobs,
		toolchain,
		sandbox: config.sandbox,
		limits: config.limits,
		jobsDir: path.join(config.workDir, 'jobs'),
		packageDir: config.packageDir
	});
	await compiler.open();

	const limiter = new Limiter(config.limits.maxConcurrent, config.limits.maxQueued);
	const expectedToken = createHash('sha256').update(config.token).digest();

	function isAuthorized(request: IncomingMessage): boolean {
		const header = request.headers.authorization ?? '';
		const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
		// Compare digests so the comparison is constant-time regardless of token length.
		return timingSafeEqual(createHash('sha256').update(presented).digest(), expectedToken);
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', 'http://worker');

		if (request.method === 'GET' && url.pathname === '/healthz') {
			sendJson(response, 200, {
				ok: true,
				typstVersion: toolchain.typstVersion,
				sandbox: config.sandbox
			});
			return;
		}

		if (!isAuthorized(request)) {
			request.resume();
			sendJson(response, 401, { error: 'unauthorized' });
			return;
		}

		const blobMatch = /^\/blobs\/([^/]+)$/.exec(url.pathname);
		if (request.method === 'PUT' && blobMatch) {
			const sha256 = blobMatch[1];
			if (!isSha256(sha256)) {
				request.resume();
				sendJson(response, 400, { error: 'invalid sha256' });
				return;
			}
			await blobs.put(sha256, request);
			sendJson(response, 200, { ok: true });
			return;
		}

		if (request.method === 'POST' && url.pathname === '/compile') {
			const compileRequest = parseCompileRequest(await readJson(request), config.limits);
			const outcome = await limiter.run(() => compiler.compile(compileRequest));
			if (outcome === null) {
				sendJson(response, 429, { error: 'worker is busy, retry shortly' });
				return;
			}
			sendJson(response, 200, outcome.value);
			return;
		}

		request.resume();
		sendJson(response, 404, { error: 'not found' });
	}

	const server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			if (response.headersSent) {
				response.destroy();
				return;
			}
			if (error instanceof MissingBlobsError) {
				sendJson(response, 409, { error: error.message, missing: error.missing });
			} else if (error instanceof InvalidRequestError) {
				sendJson(response, 400, { error: error.message });
			} else if (error instanceof BlobError) {
				sendJson(response, error.code === 'too-large' ? 413 : 400, { error: error.message });
			} else {
				console.error('worker request failed', error);
				sendJson(response, 500, { error: 'internal worker error' });
			}
		});
	});

	return { server, toolchain };
}
