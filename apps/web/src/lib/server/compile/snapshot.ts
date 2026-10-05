import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { listTree } from '../projects/tree';

export interface SnapshotFile {
	path: string;
	sha256: string;
	size: number;
}

export interface Snapshot {
	files: SnapshotFile[];
	/** Identifies the exact set of paths and contents that was compiled. */
	sourceHash: string;
}

// Hashing every asset on every keystroke-triggered preview would be wasteful, so
// hashes are remembered per file until its size or modification time changes.
const hashCache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();
const MAX_CACHE_ENTRIES = 20_000;

async function hashFile(absolute: string): Promise<{ sha256: string; size: number }> {
	const info = await fs.stat(absolute);
	const cached = hashCache.get(absolute);
	if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
		return { sha256: cached.sha256, size: info.size };
	}

	const content = await fs.readFile(absolute);
	const sha256 = createHash('sha256').update(content).digest('hex');
	if (hashCache.size >= MAX_CACHE_ENTRIES) hashCache.clear();
	// Record the size that was actually hashed, in case the file changed after stat.
	hashCache.set(absolute, { mtimeMs: info.mtimeMs, size: content.byteLength, sha256 });
	return { sha256, size: content.byteLength };
}

/** Describes the current content of a project tree by content hash. */
export async function snapshotTree(root: string): Promise<Snapshot> {
	const files: SnapshotFile[] = [];
	for (const entry of await listTree(root)) {
		if (entry.type !== 'file') continue;
		const { sha256, size } = await hashFile(path.join(root, ...entry.path.split('/')));
		files.push({ path: entry.path, sha256, size });
	}

	const digest = createHash('sha256');
	for (const file of files) digest.update(`${file.path}\0${file.sha256}\n`);
	return { files, sourceHash: digest.digest('hex') };
}
