import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { InvalidPathError, normalizeProjectPath, parentPath } from './paths';

/**
 * File operations on one project's working tree. `root` is the tree directory;
 * all other paths are project-relative and validated here.
 */

export interface TreeLimits {
	maxFileBytes: number;
	maxProjectBytes: number;
	maxProjectFiles: number;
}

export interface TreeEntry {
	path: string;
	type: 'file' | 'directory';
	/** Size in bytes; 0 for directories. */
	size: number;
}

export type TreeErrorCode =
	| 'invalid-path'
	| 'not-found'
	| 'already-exists'
	| 'not-a-file'
	| 'not-a-directory'
	| 'conflict'
	| 'file-too-large'
	| 'project-too-large'
	| 'too-many-files';

export class TreeError extends Error {
	readonly code: TreeErrorCode;

	constructor(code: TreeErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

export function sha256(content: Uint8Array): string {
	return createHash('sha256').update(content).digest('hex');
}

function isNotFound(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code === 'ENOENT' || code === 'ENOTDIR';
}

function megabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function normalize(input: unknown): string {
	try {
		return normalizeProjectPath(input);
	} catch (error) {
		if (error instanceof InvalidPathError) throw new TreeError('invalid-path', error.message);
		throw error;
	}
}

/**
 * Resolves a project path to an absolute one and verifies that no existing
 * component is a symbolic link. The app never creates symlinks, but imported
 * repositories may contain them, and following one could leave the project.
 */
async function resolveInTree(root: string, relativePath: string): Promise<string> {
	let current = root;
	for (const segment of relativePath.split('/')) {
		current = path.join(current, segment);
		let info;
		try {
			info = await fs.lstat(current);
		} catch (error) {
			if (isNotFound(error)) break;
			throw error;
		}
		if (info.isSymbolicLink()) {
			throw new TreeError('invalid-path', 'Symbolic links are not supported in projects.');
		}
	}
	return path.join(root, ...relativePath.split('/'));
}

/** Lists every file and directory in the tree, parents before children, sorted by path. */
export async function listTree(root: string): Promise<TreeEntry[]> {
	const entries: TreeEntry[] = [];

	async function walk(directory: string, prefix: string): Promise<void> {
		let children;
		try {
			children = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			if (isNotFound(error)) return;
			throw error;
		}
		children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

		for (const child of children) {
			const childPath = prefix ? `${prefix}/${child.name}` : child.name;
			if (child.isDirectory()) {
				entries.push({ path: childPath, type: 'directory', size: 0 });
				await walk(path.join(directory, child.name), childPath);
			} else if (child.isFile()) {
				try {
					const info = await fs.stat(path.join(directory, child.name));
					entries.push({ path: childPath, type: 'file', size: info.size });
				} catch (error) {
					// Deleted or renamed by another request since the directory was read.
					if (!isNotFound(error)) throw error;
				}
			}
			// Symlinks, sockets and other special files are ignored entirely.
		}
	}

	await walk(root, '');
	return entries;
}

export async function readTreeFile(root: string, filePath: string): Promise<Buffer> {
	const absolute = await resolveInTree(root, normalize(filePath));
	try {
		const info = await fs.stat(absolute);
		if (!info.isFile()) throw new TreeError('not-a-file', 'That path is a folder, not a file.');
		return await fs.readFile(absolute);
	} catch (error) {
		if (isNotFound(error)) throw new TreeError('not-found', 'File not found.');
		throw error;
	}
}

export interface WriteOptions {
	limits: TreeLimits;
	/**
	 * Hash of the content the writer last saw, or `null` if the writer believes
	 * the file does not exist yet. When given, the write is refused with a
	 * `conflict` if the file on disk is different, so that one editor never
	 * silently overwrites another's changes. Leave undefined to skip the check.
	 */
	baseHash?: string | null;
}

/** Writes a file atomically, creating parent folders as needed. Returns the new content hash. */
export async function writeTreeFile(
	root: string,
	filePath: string,
	content: Uint8Array,
	options: WriteOptions
): Promise<string> {
	const relativePath = normalize(filePath);
	const { limits, baseHash } = options;

	if (content.byteLength > limits.maxFileBytes) {
		throw new TreeError(
			'file-too-large',
			`Files can be at most ${megabytes(limits.maxFileBytes)} on this server.`
		);
	}

	const absolute = await resolveInTree(root, relativePath);

	let existing: Buffer | null = null;
	try {
		const info = await fs.stat(absolute);
		if (info.isDirectory()) {
			throw new TreeError('not-a-file', 'A folder with that name already exists.');
		}
		existing = await fs.readFile(absolute);
	} catch (error) {
		if (!isNotFound(error)) throw error;
	}

	if (baseHash !== undefined) {
		const currentHash = existing ? sha256(existing) : null;
		if (currentHash !== baseHash) {
			throw new TreeError(
				'conflict',
				existing
					? 'The file was changed elsewhere since you opened it.'
					: 'The file was deleted or moved elsewhere.'
			);
		}
	}

	await assertQuota(root, limits, {
		addedFiles: existing ? 0 : 1,
		addedBytes: content.byteLength - (existing?.byteLength ?? 0)
	});

	await ensureParentDirectories(root, relativePath);
	// The temporary file lives beside the tree, not in it, so that a concurrent
	// listing, snapshot or checkpoint never sees a half-written file. Being on
	// the same file system, the rename into place is still atomic.
	const temporaryDirectory = `${root}.tmp`;
	await fs.mkdir(temporaryDirectory, { recursive: true });
	const temporary = path.join(temporaryDirectory, randomUUID());
	try {
		// Flush the content to disk before the rename and the rename itself after
		// it. A power cut then leaves either the old file or the complete new one,
		// never an empty or half-written file under the real name.
		const handle = await fs.open(temporary, 'wx', 0o640);
		try {
			await handle.writeFile(content);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, absolute);
		await syncDirectory(path.dirname(absolute));
	} catch (error) {
		await fs.rm(temporary, { force: true });
		throw error;
	}

	return sha256(content);
}

export async function createTreeDirectory(
	root: string,
	directoryPath: string,
	limits: TreeLimits
): Promise<void> {
	const relativePath = normalize(directoryPath);
	const absolute = await resolveInTree(root, relativePath);
	if (await exists(absolute)) {
		throw new TreeError('already-exists', 'A file or folder with that name already exists.');
	}
	await assertQuota(root, limits, { addedFiles: 1, addedBytes: 0 });
	await ensureParentDirectories(root, relativePath);
	await fs.mkdir(absolute);
}

/** Moves or renames a file or folder. Never overwrites an existing target. */
export async function moveTreeEntry(root: string, fromPath: string, toPath: string): Promise<void> {
	const from = normalize(fromPath);
	const to = normalize(toPath);
	if (from === to) return;
	if (to.startsWith(`${from}/`)) {
		throw new TreeError('invalid-path', 'A folder cannot be moved into itself.');
	}

	const absoluteFrom = await resolveInTree(root, from);
	const absoluteTo = await resolveInTree(root, to);
	if (!(await exists(absoluteFrom))) throw new TreeError('not-found', 'File or folder not found.');
	if (await exists(absoluteTo)) {
		throw new TreeError('already-exists', 'A file or folder with that name already exists.');
	}

	await ensureParentDirectories(root, to);
	await fs.rename(absoluteFrom, absoluteTo);
}

export async function deleteTreeEntry(root: string, entryPath: string): Promise<void> {
	const absolute = await resolveInTree(root, normalize(entryPath));
	if (!(await exists(absolute))) throw new TreeError('not-found', 'File or folder not found.');
	await fs.rm(absolute, { recursive: true });
}

/** Makes a rename or creation inside `directory` durable. */
async function syncDirectory(directory: string): Promise<void> {
	const handle = await fs.open(directory, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function exists(absolute: string): Promise<boolean> {
	try {
		await fs.lstat(absolute);
		return true;
	} catch (error) {
		if (isNotFound(error)) return false;
		throw error;
	}
}

async function ensureParentDirectories(root: string, relativePath: string): Promise<void> {
	const parent = parentPath(relativePath);
	const absoluteParent = parent ? path.join(root, ...parent.split('/')) : root;
	try {
		await fs.mkdir(absoluteParent, { recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			throw new TreeError('not-a-directory', 'A file is in the way of that folder path.');
		}
		throw error;
	}
	const info = await fs.stat(absoluteParent);
	if (!info.isDirectory()) {
		throw new TreeError('not-a-directory', 'A file is in the way of that folder path.');
	}
}

async function assertQuota(
	root: string,
	limits: TreeLimits,
	change: { addedFiles: number; addedBytes: number }
): Promise<void> {
	if (change.addedFiles <= 0 && change.addedBytes <= 0) return;

	const entries = await listTree(root);
	const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);

	if (entries.length + change.addedFiles > limits.maxProjectFiles) {
		throw new TreeError(
			'too-many-files',
			`Projects can contain at most ${limits.maxProjectFiles} files and folders on this server.`
		);
	}
	if (totalBytes + change.addedBytes > limits.maxProjectBytes) {
		throw new TreeError(
			'project-too-large',
			`Projects can be at most ${megabytes(limits.maxProjectBytes)} on this server.`
		);
	}
}
