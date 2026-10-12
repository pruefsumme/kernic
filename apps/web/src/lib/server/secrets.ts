import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Secrets the server has to be able to read again, such as the access token of
 * a Git repository, are stored encrypted (AES-256-GCM) with a key derived from
 * `KERNIC_SECRET_KEY`. A copy of the database alone does not reveal them.
 *
 * Each secret is bound to what it belongs to (`context`): moved to another row,
 * it does not open.
 */

const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class SecretError extends Error {}

function keyFor(masterKey: string, purpose: string): Buffer {
	if (masterKey.length < 32) {
		throw new SecretError('KERNIC_SECRET_KEY must be at least 32 characters.');
	}
	return Buffer.from(hkdfSync('sha256', masterKey, 'kernic', purpose, 32));
}

/** Encrypts a secret. The result holds everything needed to open it except the key. */
export function sealSecret(
	masterKey: string,
	purpose: string,
	context: string,
	secret: string
): Buffer {
	const nonce = randomBytes(NONCE_BYTES);
	const cipher = createCipheriv('aes-256-gcm', keyFor(masterKey, purpose), nonce);
	cipher.setAAD(Buffer.from(context));
	const sealed = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
	return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), sealed]);
}

/** Opens a secret. Throws if the key, the context or the stored bytes are not the ones it was sealed with. */
export function openSecret(
	masterKey: string,
	purpose: string,
	context: string,
	stored: Uint8Array
): string {
	const bytes = Buffer.from(stored);
	if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== VERSION) {
		throw new SecretError('The stored secret is not in a known form.');
	}
	const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
	const tag = bytes.subarray(1 + NONCE_BYTES, 1 + NONCE_BYTES + TAG_BYTES);
	const decipher = createDecipheriv('aes-256-gcm', keyFor(masterKey, purpose), nonce);
	decipher.setAAD(Buffer.from(context));
	decipher.setAuthTag(tag);
	try {
		return Buffer.concat([
			decipher.update(bytes.subarray(1 + NONCE_BYTES + TAG_BYTES)),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new SecretError(
			'The stored secret could not be opened. Was KERNIC_SECRET_KEY changed since it was saved?'
		);
	}
}
