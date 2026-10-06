import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';

export class BlobError extends Error {
	readonly code: 'too-large' | 'hash-mismatch';

	constructor(code: BlobError['code'], message: string) {
		super(message);
		this.code = code;
	}
}

interface BlobEntry {
	size: number;
	lastUsed: number;
}

/**
 * Content-addressed cache of project files. The app uploads each file once and
 * later compiles reference it by hash, so unchanged assets are not re-sent on
 * every preview.
 */
export class BlobStore {
	readonly #dir: string;
	readonly #maxBlobBytes: number;
	readonly #cacheBytes: number;
	readonly #entries = new Map<string, BlobEntry>();
	#totalBytes = 0;
	#clock = 0;

	constructor(dir: string, limits: { maxBlobBytes: number; cacheBytes: number }) {
		this.#dir = dir;
		this.#maxBlobBytes = limits.maxBlobBytes;
		this.#cacheBytes = limits.cacheBytes;
	}

	/** Creates the directory and indexes blobs left over from a previous run. */
	async open(): Promise<void> {
		await mkdir(this.#dir, { recursive: true });
		for (const shard of await readdir(this.#dir, { withFileTypes: true })) {
			const shardPath = path.join(this.#dir, shard.name);
			if (!shard.isDirectory()) {
				// Interrupted uploads leave temp files at the top level.
				await rm(shardPath, { force: true });
				continue;
			}
			for (const name of await readdir(shardPath)) {
				const info = await stat(path.join(shardPath, name));
				this.#track(name, info.size);
			}
		}
	}

	has(sha256: string): boolean {
		return this.#entries.has(sha256);
	}

	size(sha256: string): number | undefined {
		return this.#entries.get(sha256)?.size;
	}

	/** Stores a blob after verifying that the body matches the claimed hash. */
	async put(sha256: string, body: Readable): Promise<void> {
		if (this.has(sha256)) {
			body.resume();
			this.#touch(sha256);
			return;
		}

		const tempPath = path.join(this.#dir, `upload-${randomUUID()}`);
		const hash = createHash('sha256');
		const maxBytes = this.#maxBlobBytes;
		let received = 0;

		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				received += chunk.length;
				if (received > maxBytes) {
					callback(new BlobError('too-large', `blob exceeds ${maxBytes} bytes`));
					return;
				}
				hash.update(chunk);
				callback(null, chunk);
			}
		});

		try {
			// Recreate the directory if it was removed while the worker was running.
			await mkdir(this.#dir, { recursive: true });
			await pipeline(body, meter, createWriteStream(tempPath, { mode: 0o600 }));
			if (hash.digest('hex') !== sha256) {
				throw new BlobError('hash-mismatch', 'blob content does not match its sha256');
			}
			const finalPath = this.#pathOf(sha256);
			await mkdir(path.dirname(finalPath), { recursive: true });
			await rename(tempPath, finalPath);
		} catch (error) {
			await rm(tempPath, { force: true });
			throw error;
		}

		this.#track(sha256, received);
		await this.#evict();
	}

	/**
	 * Copies a blob to `destination`. Returns false when the blob is gone (never
	 * uploaded, or evicted since the caller checked), so the caller can report it
	 * as missing.
	 */
	async copyTo(sha256: string, destination: string): Promise<boolean> {
		if (!this.has(sha256)) return false;
		try {
			await copyFile(this.#pathOf(sha256), destination);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.#forget(sha256);
				return false;
			}
			throw error;
		}
		this.#touch(sha256);
		return true;
	}

	#pathOf(sha256: string): string {
		return path.join(this.#dir, sha256.slice(0, 2), sha256);
	}

	#track(sha256: string, size: number): void {
		this.#forget(sha256);
		this.#entries.set(sha256, { size, lastUsed: ++this.#clock });
		this.#totalBytes += size;
	}

	#forget(sha256: string): void {
		const entry = this.#entries.get(sha256);
		if (!entry) return;
		this.#entries.delete(sha256);
		this.#totalBytes -= entry.size;
	}

	#touch(sha256: string): void {
		const entry = this.#entries.get(sha256);
		if (entry) entry.lastUsed = ++this.#clock;
	}

	async #evict(): Promise<void> {
		if (this.#totalBytes <= this.#cacheBytes) return;

		const oldestFirst = [...this.#entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		for (const [sha256] of oldestFirst) {
			if (this.#totalBytes <= this.#cacheBytes) break;
			this.#forget(sha256);
			await rm(this.#pathOf(sha256), { force: true });
		}
	}
}
