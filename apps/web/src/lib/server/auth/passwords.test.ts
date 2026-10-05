import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';
import { validateDisplayName, validateEmail, validateNewPassword } from './validation';

describe('passwords', () => {
	it('verifies the original password and rejects others', async () => {
		const hash = await hashPassword('correct horse battery');
		expect(hash.startsWith('scrypt$')).toBe(true);
		expect(await verifyPassword('correct horse battery', hash)).toBe(true);
		expect(await verifyPassword('correct horse batterx', hash)).toBe(false);
	});

	it('salts each hash', async () => {
		expect(await hashPassword('same password')).not.toBe(await hashPassword('same password'));
	});

	it('rejects malformed stored hashes', async () => {
		expect(await verifyPassword('anything', '')).toBe(false);
		expect(await verifyPassword('anything', 'bcrypt$whatever')).toBe(false);
		expect(await verifyPassword('anything', 'scrypt$999999999999$8$3$AAAA$AAAA')).toBe(false);
	});
});

describe('account input validation', () => {
	it('normalizes email addresses', () => {
		expect(validateEmail('  Ada@Example.ORG ')).toEqual({ ok: true, value: 'ada@example.org' });
		expect(validateEmail('not-an-email').ok).toBe(false);
		expect(validateEmail(undefined).ok).toBe(false);
	});

	it('collapses whitespace in display names', () => {
		expect(validateDisplayName('  Ada   Lovelace ')).toEqual({ ok: true, value: 'Ada Lovelace' });
		expect(validateDisplayName('   ').ok).toBe(false);
	});

	it('enforces password length', () => {
		expect(validateNewPassword('short').ok).toBe(false);
		expect(validateNewPassword('long enough password').ok).toBe(true);
	});
});
