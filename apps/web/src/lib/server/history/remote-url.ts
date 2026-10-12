/**
 * Addresses of Git repositories a project may be connected to.
 *
 * The server itself opens the connection, so an address is a way to make the
 * server talk to a machine of someone's choosing. It may therefore only name
 * a host the administrator has listed, over HTTP(S), with nothing in it but
 * the path of a repository: no credentials, no query, no other protocol.
 */

export class RemoteUrlError extends Error {}

/** A scheme, host and port the server may talk Git to, as `https://host[:port]`. */
export type AllowedOrigin = string;

/**
 * Reads the administrator's list: hosts separated by commas or spaces. A bare
 * host means HTTPS; `http://` has to be written out, for a forge on a private
 * network. Throws on anything that is not a host.
 */
export function parseAllowedOrigins(value: string | undefined): AllowedOrigin[] {
	const origins = new Set<AllowedOrigin>();
	for (const entry of (value ?? '').split(/[\s,]+/).filter((part) => part !== '')) {
		let url: URL;
		try {
			url = new URL(/^https?:\/\//i.test(entry) ? entry : `https://${entry}`);
		} catch {
			throw new Error(`KERNIC_GIT_HOSTS: "${entry}" is not a host`);
		}
		const bare = url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
		if (!bare || !['http:', 'https:'].includes(url.protocol) || url.hostname === '') {
			throw new Error(
				`KERNIC_GIT_HOSTS: "${entry}" must be a host, optionally with http:// or https:// and a port`
			);
		}
		origins.add(url.origin);
	}
	return [...origins];
}

/** Path of a repository: segments of ordinary characters, as forges use them. */
const REPOSITORY_PATH = /^(\/[A-Za-z0-9][A-Za-z0-9._~-]{0,99}){1,8}$/;

/**
 * Checks an address typed by a person and returns it in one fixed spelling.
 * Throws a `RemoteUrlError` that can be shown to them.
 */
export function parseRemoteUrl(input: unknown, allowed: readonly AllowedOrigin[]): string {
	const text = typeof input === 'string' ? input.trim() : '';
	if (text === '') throw new RemoteUrlError('Enter the address of the repository.');
	if (text.length > 500) throw new RemoteUrlError('That address is too long.');

	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new RemoteUrlError(
			'Enter the full address of the repository, starting with https://, as the forge shows it for cloning.'
		);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new RemoteUrlError(
			'Only addresses that start with https:// can be used. Addresses for SSH (git@…) cannot.'
		);
	}
	if (url.username !== '' || url.password !== '') {
		throw new RemoteUrlError(
			'Leave the user name and token out of the address; they have their own fields.'
		);
	}
	if (url.search !== '' || url.hash !== '') {
		throw new RemoteUrlError('The address must end with the path of the repository.');
	}
	if (!allowed.includes(url.origin)) {
		throw new RemoteUrlError(
			`This server is not set up to connect to ${url.host}. Its administrator decides which hosts may be used.`
		);
	}

	const repositoryPath = url.pathname.replace(/\/+$/, '');
	// `new URL` has already resolved `.` and `..`; what is left must be plain names.
	if (!REPOSITORY_PATH.test(repositoryPath) || repositoryPath.includes('..')) {
		throw new RemoteUrlError(
			'That does not look like the address of a repository, such as https://git.example.org/ada/thesis.git.'
		);
	}
	return `${url.origin}${repositoryPath}`;
}

/** A branch name of ordinary characters; everything Git itself would refuse is refused here too. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export function parseBranch(input: unknown): string {
	const text = typeof input === 'string' ? input.trim() : '';
	if (text === '') return 'main';
	const valid =
		BRANCH.test(text) &&
		!text.includes('..') &&
		!text.includes('//') &&
		!text.endsWith('/') &&
		!text.endsWith('.') &&
		!text.endsWith('.lock') &&
		!text.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'));
	if (!valid) {
		throw new RemoteUrlError(
			'A branch name consists of letters, digits, dots, hyphens, underscores and slashes.'
		);
	}
	return text;
}

/** A user name for the forge: optional, and never anything that could break out of a header. */
export function parseUsername(input: unknown): string {
	const text = typeof input === 'string' ? input.trim() : '';
	if (text === '') return 'kernic';
	if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/.test(text)) {
		throw new RemoteUrlError('That user name contains characters a forge would not accept.');
	}
	return text;
}

/** An access token: printable, without spaces, of a believable length. */
export function parseToken(input: unknown): string {
	const text = typeof input === 'string' ? input.trim() : '';
	if (text === '') throw new RemoteUrlError('Enter an access token of the forge.');
	if (!/^[\x21-\x7e]{8,400}$/.test(text)) {
		throw new RemoteUrlError('That does not look like an access token.');
	}
	return text;
}
