import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwords';

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

export function validateEmail(input: unknown): Validated<string> {
	const email = typeof input === 'string' ? input.trim().toLowerCase() : '';
	// Deliberately loose: the address is an identifier here, not a delivery target.
	if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return { ok: false, message: 'Enter a valid email address.' };
	}
	return { ok: true, value: email };
}

export function validateDisplayName(input: unknown): Validated<string> {
	const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
	if (name.length < 1 || name.length > 80) {
		return { ok: false, message: 'Enter a name of up to 80 characters.' };
	}
	return { ok: true, value: name };
}

export function validateNewPassword(input: unknown): Validated<string> {
	const password = typeof input === 'string' ? input : '';
	if (password.length < MIN_PASSWORD_LENGTH) {
		return {
			ok: false,
			message: `Use at least ${MIN_PASSWORD_LENGTH} characters for the password.`
		};
	}
	if (password.length > MAX_PASSWORD_LENGTH) {
		return { ok: false, message: `Passwords can be at most ${MAX_PASSWORD_LENGTH} characters.` };
	}
	return { ok: true, value: password };
}
