import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startForge, type Forge } from '../../../../e2e/fake-forge';
import { NothingToPushError, ProjectHistory, RemoteError, type Remote } from './git';

const author = { name: 'Ada Lovelace', email: 'ada@example.org' };
const TOKEN = 'a-token-that-may-write-0123456789';
const READ_ONLY = 'a-token-that-may-only-read-012345';

let forge: Forge;
let projectDirectory: string;
let history: ProjectHistory;
let repositories = 0;

const write = (file: string, content: string) =>
	writeFile(path.join(projectDirectory, 'tree', file), content);
const remoteFor = (url: string, overrides: Partial<Remote> = {}): Remote => ({
	url,
	branch: 'main',
	username: 'ada',
	token: TOKEN,
	...overrides
});
const newRepository = async () => {
	const name = `ada/project-${++repositories}`;
	return { name, url: await forge.createRepository(name) };
};
const failure = async (attempt: Promise<unknown>) => {
	const error = await attempt.then(
		() => null,
		(cause: unknown) => cause
	);
	expect(error).toBeInstanceOf(RemoteError);
	return (error as RemoteError).kind;
};

beforeAll(async () => {
	forge = await startForge({ tokens: { [TOKEN]: 'write', [READ_ONLY]: 'read' } });
});
afterAll(() => forge.close());

beforeEach(async () => {
	projectDirectory = await mkdtemp(path.join(tmpdir(), 'kernic-remote-'));
	await mkdir(path.join(projectDirectory, 'tree'));
	history = new ProjectHistory(projectDirectory);
});
afterEach(async () => {
	await rm(projectDirectory, { recursive: true, force: true });
});

describe('pushing checkpoints to a repository', () => {
	it('sends the checkpoints, and later only the new ones', async () => {
		const { name, url } = await newRepository();
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);
		expect(await history.lookAtRemote(remoteFor(url))).toBeNull();

		const first = await history.push(remoteFor(url));
		expect(first).toBe(await history.head());
		expect(await forge.log(name, 'main')).toEqual(['First draft']);
		expect(await forge.files(name, 'main')).toEqual(['main.typ']);
		expect(await history.lookAtRemote(remoteFor(url))).toBe(first);

		await write('notes.typ', 'Notes\n');
		await history.createCheckpoint('Add notes', author);
		expect(await history.checkpointsSince(first)).toBe(1);
		await history.push(remoteFor(url));
		expect(await forge.log(name, 'main')).toEqual(['Add notes', 'First draft']);

		// Nothing new: the push is simply done.
		expect(await history.push(remoteFor(url))).toBe(await history.head());
	});

	it('sends checkpoints only, not the automatic snapshots between them', async () => {
		const { name, url } = await newRepository();
		await write('main.typ', 'One\n');
		await history.createCheckpoint('One', author);
		await write('main.typ', 'Two, not yet a checkpoint\n');
		await history.takeSnapshot();
		await history.push(remoteFor(url, { branch: 'drafts/thesis' }));

		expect(await forge.log(name, 'drafts/thesis')).toEqual(['One']);
		// One branch arrived, and none of the project's own bookkeeping.
		expect(await forge.refs(name)).toEqual(['refs/heads/drafts/thesis']);
	});

	it('never overwrites what the repository has and this project does not', async () => {
		const { name, url } = await newRepository();
		await forge.commitElsewhere(name, 'main', 'README.md', 'Written on the forge.\n');
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);

		expect(await failure(history.push(remoteFor(url)))).toBe('diverged');
		expect(await forge.log(name, 'main')).toEqual(['Edit README.md elsewhere']);

		// Also when it happened after an earlier push.
		const other = await newRepository();
		await history.push(remoteFor(other.url));
		await forge.commitElsewhere(other.name, 'main', 'README.md', 'Written on the forge.\n');
		await write('main.typ', '= Title\nMore.\n');
		await history.createCheckpoint('More', author);
		expect(await failure(history.push(remoteFor(other.url)))).toBe('diverged');
		expect(await forge.log(other.name, 'main')).toEqual([
			'Edit README.md elsewhere',
			'First draft'
		]);
	});

	it('says what is wrong with a token or an address', async () => {
		const { url } = await newRepository();
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);

		expect(
			await failure(history.push(remoteFor(url, { token: 'not-a-token-of-this-forge' })))
		).toBe('credentials');
		expect(await failure(history.lookAtRemote(remoteFor(url, { token: 'not-a-token' })))).toBe(
			'credentials'
		);
		expect(await failure(history.push(remoteFor(url, { token: READ_ONLY })))).toBe('refused');
		expect(await history.lookAtRemote(remoteFor(url, { token: READ_ONLY }))).toBeNull();
		expect(await failure(history.push(remoteFor(`${forge.origin}/ada/none.git`)))).toBe(
			'not-found'
		);
		// A port nothing listens on.
		expect(await failure(history.push(remoteFor('http://127.0.0.1:9/ada/none.git')))).toBe(
			'unreachable'
		);
	});

	it('does not follow a redirect, and so never takes the token elsewhere', async () => {
		const { name } = await newRepository();
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);
		forge.requests.length = 0;

		const moved = `${forge.origin}/moved/${name}.git`;
		expect(await failure(history.push(remoteFor(moved)))).toBe('redirected');
		expect(await failure(history.lookAtRemote(remoteFor(moved)))).toBe('redirected');
		expect(forge.requests.every((request) => request.path.startsWith('/moved/'))).toBe(true);
		expect(await forge.log(name, 'main')).toEqual([]);
	});

	it('keeps the token out of the repository, the arguments and the log', async () => {
		const { url } = await newRepository();
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		// A stand-in `git` that writes down how it was called, then runs the real one.
		const bin = await mkdtemp(path.join(tmpdir(), 'kernic-git-spy-'));
		const calls = path.join(bin, 'calls.txt');
		const realGit = (await promisify(execFile)('which', ['git'])).stdout.trim();
		await writeFile(
			path.join(bin, 'git'),
			`#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${realGit}' "$@"\n`,
			{ mode: 0o755 }
		);
		const originalPath = process.env.PATH;
		process.env.PATH = `${bin}:${originalPath}`;
		try {
			await history.push(remoteFor(url));
			await failure(history.push(remoteFor(`${forge.origin}/ada/none.git`)));
			await failure(history.push(remoteFor('http://127.0.0.1:9/ada/none.git')));
			expect(JSON.stringify(logged.mock.calls)).not.toContain(TOKEN);

			// What any process on the machine can read of a running command: its arguments.
			const called = await readFile(calls, 'utf8');
			expect(called).toContain('push --porcelain');
			expect(called).not.toContain(TOKEN);
			expect(called).not.toContain(Buffer.from(`ada:${TOKEN}`).toString('base64'));
		} finally {
			process.env.PATH = originalPath;
			logged.mockRestore();
			await rm(bin, { recursive: true, force: true });
		}
		// Nothing about the repository elsewhere is written into the project's own.
		const config = await readFile(path.join(projectDirectory, 'repo.git', 'config'), 'utf8');
		expect(config).not.toContain(TOKEN);
		expect(config).not.toContain('remote');
		expect(config).not.toContain(Buffer.from(`ada:${TOKEN}`).toString('base64'));
	});

	it('has nothing to push before the first checkpoint', async () => {
		const { url } = await newRepository();
		await expect(history.push(remoteFor(url))).rejects.toBeInstanceOf(NothingToPushError);
		expect(await history.checkpointsSince(null)).toBe(0);
	});
});
