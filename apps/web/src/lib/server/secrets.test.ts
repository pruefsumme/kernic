import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret, SecretError } from './secrets';

const key = 'a-key-of-at-least-thirty-two-characters';

describe('stored secrets', () => {
	it('open again with the same key, purpose and context', () => {
		const sealed = sealSecret(key, 'git', 'project-1', 'tøken-123');
		expect(openSecret(key, 'git', 'project-1', sealed)).toBe('tøken-123');
	});

	it('do not contain the secret and differ each time', () => {
		const first = sealSecret(key, 'git', 'project-1', 'token-123');
		const second = sealSecret(key, 'git', 'project-1', 'token-123');
		expect(first.includes(Buffer.from('token-123'))).toBe(false);
		expect(first.equals(second)).toBe(false);
	});

	it('do not open for another context, purpose or key, or when changed', () => {
		const sealed = sealSecret(key, 'git', 'project-1', 'token-123');
		expect(() => openSecret(key, 'git', 'project-2', sealed)).toThrow(SecretError);
		expect(() => openSecret(key, 'other', 'project-1', sealed)).toThrow(SecretError);
		expect(() => openSecret(`${key}!`, 'git', 'project-1', sealed)).toThrow(SecretError);
		const changed = Buffer.from(sealed);
		changed[changed.length - 1]! ^= 1;
		expect(() => openSecret(key, 'git', 'project-1', changed)).toThrow(SecretError);
		expect(() => openSecret(key, 'git', 'project-1', sealed.subarray(0, 10))).toThrow(SecretError);
	});

	it('refuse a key that is too short', () => {
		expect(() => sealSecret('short', 'git', 'project-1', 'token')).toThrow(SecretError);
	});
});
