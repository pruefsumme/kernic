const MAX_PATH_LENGTH = 512;
const MAX_DEPTH = 24;

/**
 * Checks that a snapshot path is a plain relative POSIX path that stays inside
 * the job directory. The worker validates this itself instead of trusting the
 * caller, because a bad path here would write outside the sandbox.
 */
export function isSafeRelativePath(candidate: unknown): candidate is string {
	if (typeof candidate !== 'string') return false;
	if (candidate.length === 0 || candidate.length > MAX_PATH_LENGTH) return false;
	// Control characters, NUL and backslashes never appear in paths we create.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return false;
	if (candidate.startsWith('/')) return false;

	const segments = candidate.split('/');
	if (segments.length > MAX_DEPTH) return false;
	return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export function isSha256(candidate: unknown): candidate is string {
	return typeof candidate === 'string' && /^[0-9a-f]{64}$/.test(candidate);
}
