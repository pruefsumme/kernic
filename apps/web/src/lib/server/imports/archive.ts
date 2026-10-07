import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import { InvalidPathError, normalizeProjectPath } from '../projects/paths';

/**
 * Safe extraction of an uploaded ZIP archive. The archive is untrusted: entry
 * names, sizes and types are all checked before anything is written, and
 * nothing is ever written outside `destination`.
 */

export interface ArchiveLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

export interface ExtractedFile {
	path: string;
	size: number;
}

export interface SkippedEntry {
	path: string;
	reason: string;
}

export interface ExtractedArchive {
	files: ExtractedFile[];
	/** Entries left out, with the reason. Capped; see `skippedCount` for the total. */
	skipped: SkippedEntry[];
	skippedCount: number;
	/** Single top-level folder that wrapped everything and was removed from the paths. */
	strippedFolder: string | null;
}

/** The archive cannot be imported at all. The message is shown to the user. */
export class ArchiveError extends Error {}

const MAX_LISTED_SKIPS = 50;
const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;

function megabytes(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/** Reason to leave an entry out regardless of where it ends up, or null. */
function skipReason(entry: yauzl.Entry, segments: string[]): string | null {
	const fileType = (entry.externalFileAttributes >>> 16) & UNIX_FILE_TYPE_MASK;
	if (fileType === UNIX_SYMLINK) return 'Symbolic links are not imported.';
	if (segments[0] === '__MACOSX' || SYSTEM_FILES.has(segments.at(-1)!.toLowerCase())) {
		return 'System file.';
	}
	if (segments.some((segment) => segment.toLowerCase() === '.git')) {
		return 'Git metadata is not imported from a ZIP archive.';
	}
	return null;
}

/**
 * The folder that wraps every entry (as in archives downloaded from a Git
 * forge, `project-main/…`), or null if entries are spread over the top level.
 */
function commonTopFolder(paths: string[][]): string | null {
	const first = paths[0]?.[0];
	if (first === undefined) return null;
	return paths.every((segments) => segments.length > 1 && segments[0] === first) ? first : null;
}

export async function extractArchive(
	zipPath: string,
	destination: string,
	limits: ArchiveLimits
): Promise<ExtractedArchive> {
	let zip: yauzl.ZipFile;
	try {
		zip = await yauzl.openPromise(zipPath, { autoClose: false });
	} catch {
		throw new ArchiveError('This file is not a ZIP archive, or it is damaged.');
	}

	try {
		return await extract(zip, destination, limits);
	} finally {
		zip.close();
	}
}

async function extract(
	zip: yauzl.ZipFile,
	destination: string,
	limits: ArchiveLimits
): Promise<ExtractedArchive> {
	// Even skipped entries cost memory while listing, so cap the listing itself.
	const maxEntries = limits.maxFiles * 4 + 1000;
	if (zip.entryCount > maxEntries) {
		throw new ArchiveError(
			`The archive has ${zip.entryCount} entries; this server imports at most ${limits.maxFiles} files.`
		);
	}

	const skipped: SkippedEntry[] = [];
	let skippedCount = 0;
	const skip = (entryPath: string, reason: string) => {
		skippedCount++;
		if (skipped.length < MAX_LISTED_SKIPS) skipped.push({ path: entryPath, reason });
	};

	const candidates: { entry: yauzl.Entry; segments: string[] }[] = [];
	try {
		for await (const entry of zip.eachEntry()) {
			if (entry.fileName.endsWith('/')) continue; // folders are created as needed
			if (entry.isEncrypted()) {
				throw new ArchiveError(
					'The archive is password-protected. Remove the password and try again.'
				);
			}
			const segments = entry.fileName.split('/').filter((segment) => segment !== '');
			if (segments.length === 0) continue;

			const reason = skipReason(entry, segments);
			if (reason) skip(entry.fileName, reason);
			else candidates.push({ entry, segments });
		}
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		// yauzl refuses absolute paths and paths containing "..", among other corruption.
		throw new ArchiveError(
			'The archive is damaged or contains file paths that point outside of it, so it was not imported.'
		);
	}

	const strippedFolder = commonTopFolder(candidates.map((candidate) => candidate.segments));
	const accepted: { entry: yauzl.Entry; path: string }[] = [];
	const seen = new Set<string>();
	let totalBytes = 0;

	for (const { entry, segments } of candidates) {
		const relative = (strippedFolder ? segments.slice(1) : segments).join('/');
		let normalized: string;
		try {
			normalized = normalizeProjectPath(relative);
		} catch (error) {
			if (!(error instanceof InvalidPathError)) throw error;
			skip(entry.fileName, error.message);
			continue;
		}
		if (seen.has(normalized)) {
			skip(entry.fileName, 'The archive contains this path twice; the first copy was kept.');
			continue;
		}
		if (entry.uncompressedSize > limits.maxFileBytes) {
			skip(
				entry.fileName,
				`Larger than the ${megabytes(limits.maxFileBytes)} limit for a single file on this server.`
			);
			continue;
		}

		seen.add(normalized);
		totalBytes += entry.uncompressedSize;
		accepted.push({ entry, path: normalized });
	}

	if (accepted.length > limits.maxFiles) {
		throw new ArchiveError(
			`The archive has ${accepted.length} files; projects on this server can have at most ${limits.maxFiles}.`
		);
	}
	if (totalBytes > limits.maxTotalBytes) {
		throw new ArchiveError(
			`The archive unpacks to ${megabytes(totalBytes)}; projects on this server can be at most ${megabytes(limits.maxTotalBytes)}.`
		);
	}

	const files: ExtractedFile[] = [];
	for (const { entry, path: filePath } of accepted) {
		const target = path.join(destination, ...filePath.split('/'));
		await fs.mkdir(path.dirname(target), { recursive: true });

		// The declared size was checked above; do not trust it while unpacking.
		let written = 0;
		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				written += chunk.length;
				if (written > limits.maxFileBytes) {
					callback(new ArchiveError('An entry is larger than the archive declares.'));
				} else {
					callback(null, chunk);
				}
			}
		});

		try {
			await pipeline(
				await zip.openReadStreamPromise(entry),
				meter,
				createWriteStream(target, { flags: 'wx', mode: 0o640 })
			);
		} catch (error) {
			if (error instanceof ArchiveError) throw error;
			throw new ArchiveError(
				`"${entry.fileName}" could not be unpacked; the archive may be damaged.`
			);
		}
		files.push({ path: filePath, size: written });
	}

	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return { files, skipped, skippedCount, strippedFolder };
}
