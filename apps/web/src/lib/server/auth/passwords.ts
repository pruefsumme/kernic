import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt with N=2^15, r=8, p=3 (about 32 MiB per hash), one of the parameter
// sets OWASP recommends. Parameters are stored with each hash so they can be
// raised later without invalidating existing passwords.
const PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const KEY_LENGTH = 32;
const MAX_MEMORY = 128 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;

function derive(password: string, salt: Buffer, params: typeof PARAMS): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(
			password.normalize('NFKC'),
			salt,
			KEY_LENGTH,
			{ ...params, maxmem: MAX_MEMORY },
			(error, key) => (error ? reject(error) : resolve(key))
		);
	});
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await derive(password, salt, PARAMS);
	return [
		'scrypt',
		PARAMS.N,
		PARAMS.r,
		PARAMS.p,
		salt.toString('base64'),
		key.toString('base64')
	].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [scheme, N, r, p, salt, key] = stored.split('$');
	if (scheme !== 'scrypt' || !N || !r || !p || !salt || !key) return false;

	const params = { N: Number(N), r: Number(r), p: Number(p) };
	// Refuse absurd parameters instead of letting a corrupted row exhaust memory.
	if (!(params.N <= 2 ** 20 && params.r <= 16 && params.p <= 16)) return false;

	const expected = Buffer.from(key, 'base64');
	if (expected.length !== KEY_LENGTH) return false;
	const actual = await derive(password, Buffer.from(salt, 'base64'), params);
	return timingSafeEqual(actual, expected);
}
