import { describe, expect, it } from 'vitest';
import {
	parseAllowedOrigins,
	parseBranch,
	parseRemoteUrl,
	parseToken,
	parseUsername,
	RemoteUrlError
} from './remote-url';

describe("the administrator's list of hosts", () => {
	it('reads hosts, with HTTPS unless HTTP is written out', () => {
		expect(parseAllowedOrigins('git.example.org, codeberg.org:8443  http://forgejo:3000')).toEqual([
			'https://git.example.org',
			'https://codeberg.org:8443',
			'http://forgejo:3000'
		]);
		expect(parseAllowedOrigins(undefined)).toEqual([]);
		expect(parseAllowedOrigins('  ')).toEqual([]);
	});

	it('refuses entries that are more than a host', () => {
		for (const entry of [
			'https://git.example.org/ada',
			'ssh://git.example.org',
			'a b://c',
			'https://user@host'
		]) {
			expect(() => parseAllowedOrigins(entry), entry).toThrow();
		}
	});
});

describe('the address of a repository', () => {
	const allowed = parseAllowedOrigins('git.example.org http://forgejo:3000');
	const parse = (input: unknown) => parseRemoteUrl(input, allowed);

	it('accepts a repository on a listed host, in one spelling', () => {
		expect(parse(' https://git.example.org/ada/thesis.git ')).toBe(
			'https://git.example.org/ada/thesis.git'
		);
		expect(parse('https://GIT.example.org/ada/thesis/')).toBe('https://git.example.org/ada/thesis');
		expect(parse('http://forgejo:3000/group/sub/repo')).toBe('http://forgejo:3000/group/sub/repo');
		// Dots that climb are resolved before anything is done with the address.
		expect(parse('https://git.example.org/ada/%2e%2e/bob/notes')).toBe(
			'https://git.example.org/bob/notes'
		);
	});

	it('refuses hosts that are not listed, also when they only look alike', () => {
		for (const input of [
			'https://evil.example.org/ada/thesis.git',
			'https://git.example.org.evil.test/ada/thesis.git',
			'https://git.example.org:8443/ada/thesis.git',
			'http://git.example.org/ada/thesis.git',
			'https://forgejo:3000/ada/thesis.git',
			'https://git.example.org@evil.test/ada/thesis.git',
			'https://127.0.0.1/ada/thesis.git',
			'https://[::1]/ada/thesis.git'
		]) {
			expect(() => parse(input), input).toThrow(RemoteUrlError);
		}
	});

	it('refuses other protocols, credentials, queries and odd paths', () => {
		for (const input of [
			'',
			42,
			'git@git.example.org:ada/thesis.git',
			'ssh://git@git.example.org/ada/thesis.git',
			'file:///etc/passwd',
			'ext::sh -c id',
			'https://ada:secret@git.example.org/ada/thesis.git',
			'https://git.example.org/ada/thesis.git?x=1',
			'https://git.example.org/ada/thesis.git#main',
			'https://git.example.org/',
			'https://git.example.org/ada/the sis',
			'https://git.example.org/ada/%2fadmin',
			'https://git.example.org/-ada/thesis',
			'https://git.example.org/ada/thesis\n--upload-pack=id'
		]) {
			expect(() => parse(input), String(input)).toThrow(RemoteUrlError);
		}
	});
});

describe('branch, user name and token', () => {
	it('accepts ordinary values and has defaults', () => {
		expect(parseBranch('')).toBe('main');
		expect(parseBranch('drafts/thesis-2')).toBe('drafts/thesis-2');
		expect(parseUsername(undefined)).toBe('kernic');
		expect(parseUsername('ada.lovelace')).toBe('ada.lovelace');
		expect(parseToken(' 0123456789abcdef ')).toBe('0123456789abcdef');
	});

	it('refuses what could be read as an option, a ref trick or a header', () => {
		for (const branch of [
			'-f',
			'--force',
			'a..b',
			'a b',
			'main:other',
			'+main',
			'a/',
			'x.lock',
			'.hidden',
			'a//b',
			'refs/heads/~1'
		]) {
			expect(() => parseBranch(branch), branch).toThrow(RemoteUrlError);
		}
		for (const name of ['ada lovelace', 'ada:x', 'ada\r\nX-Evil: 1', '-ada']) {
			expect(() => parseUsername(name), name).toThrow(RemoteUrlError);
		}
		for (const token of ['', 'short', 'with space inside', 'line\nbreak-123456']) {
			expect(() => parseToken(token), token).toThrow(RemoteUrlError);
		}
	});
});
