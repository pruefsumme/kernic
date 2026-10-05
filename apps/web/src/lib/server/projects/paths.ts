/**
 * Validation for project-relative paths. Every path that reaches the file
 * system goes through `normalizeProjectPath` first.
 */

export const MAX_PATH_LENGTH = 512;
export const MAX_PATH_DEPTH = 24;
const MAX_SEGMENT_LENGTH = 255;

export class InvalidPathError extends Error {}

/**
 * Returns the canonical form of a project-relative path (forward slashes, NFC,
 * no leading slash) or throws `InvalidPathError`.
 *
 * Rejected on purpose:
 * - `.` and `..` segments and empty segments, which could escape the project;
 * - backslashes and control characters, which are path separators or invisible
 *   on some systems and would not survive a ZIP export or a Git checkout;
 * - a `.git` segment, which is reserved for the project's repository metadata.
 */
export function normalizeProjectPath(input: unknown): string {
	if (typeof input !== 'string') throw new InvalidPathError('Path must be text.');

	const path = input.normalize('NFC').replace(/^\/+/, '').replace(/\/+$/, '');
	if (path === '') throw new InvalidPathError('Path is empty.');
	if (path.length > MAX_PATH_LENGTH) throw new InvalidPathError('Path is too long.');
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(path)) {
		throw new InvalidPathError('Path contains control characters.');
	}
	if (path.includes('\\')) throw new InvalidPathError('Use "/" to separate folders.');

	const segments = path.split('/');
	if (segments.length > MAX_PATH_DEPTH) throw new InvalidPathError('Path is nested too deeply.');

	for (const segment of segments) {
		if (segment === '') throw new InvalidPathError('Path contains an empty folder name.');
		if (segment === '.' || segment === '..') {
			throw new InvalidPathError('Path may not contain "." or ".." segments.');
		}
		if (segment.toLowerCase() === '.git') throw new InvalidPathError('".git" is a reserved name.');
		if (segment !== segment.trim()) {
			throw new InvalidPathError('Names may not start or end with a space.');
		}
		if (Buffer.byteLength(segment) > MAX_SEGMENT_LENGTH) {
			throw new InvalidPathError('A file or folder name is too long.');
		}
	}

	return segments.join('/');
}

export function isValidProjectPath(input: unknown): boolean {
	try {
		normalizeProjectPath(input);
		return true;
	} catch {
		return false;
	}
}

export function parentPath(path: string): string | null {
	const index = path.lastIndexOf('/');
	return index === -1 ? null : path.slice(0, index);
}

export function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}
