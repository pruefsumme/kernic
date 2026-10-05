import { describe, expect, it } from 'vitest';
import { InvalidPathError, baseName, normalizeProjectPath, parentPath } from './paths';

describe('normalizeProjectPath', () => {
	it('accepts ordinary nested paths', () => {
		expect(normalizeProjectPath('main.typ')).toBe('main.typ');
		expect(normalizeProjectPath('chapters/01 intro.typ')).toBe('chapters/01 intro.typ');
		expect(normalizeProjectPath('assets/Übersicht (final).png')).toBe(
			'assets/Übersicht (final).png'
		);
		expect(normalizeProjectPath('.gitignore')).toBe('.gitignore');
	});

	it('strips surrounding slashes and normalizes to NFC', () => {
		expect(normalizeProjectPath('/chapters/intro.typ/')).toBe('chapters/intro.typ');
		expect(normalizeProjectPath('über.typ')).toBe('über.typ');
	});

	it.each([
		['empty', ''],
		['only slashes', '///'],
		['parent traversal', '../secret'],
		['nested traversal', 'a/../../b'],
		['dot segment', 'a/./b'],
		['empty segment', 'a//b'],
		['backslash', 'a\\b.typ'],
		['NUL byte', 'a\u0000.typ'],
		['newline', 'a\nb.typ'],
		['git metadata', '.git/config'],
		['nested git metadata', 'sub/.GIT/hooks/pre-commit'],
		['trailing space', 'chapter /a.typ'],
		['too long', 'a'.repeat(600)],
		['too deep', Array(40).fill('d').join('/')]
	])('rejects %s', (_label, input) => {
		expect(() => normalizeProjectPath(input)).toThrow(InvalidPathError);
	});

	it('rejects values that are not strings', () => {
		expect(() => normalizeProjectPath(undefined)).toThrow(InvalidPathError);
		expect(() => normalizeProjectPath(['a'])).toThrow(InvalidPathError);
	});
});

describe('path helpers', () => {
	it('splits parent and base name', () => {
		expect(parentPath('a/b/c.typ')).toBe('a/b');
		expect(parentPath('c.typ')).toBeNull();
		expect(baseName('a/b/c.typ')).toBe('c.typ');
		expect(baseName('c.typ')).toBe('c.typ');
	});
});
