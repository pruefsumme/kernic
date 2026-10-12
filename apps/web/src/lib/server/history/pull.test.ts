import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startForge, type Forge } from '../../../../e2e/fake-forge';
import { ProjectHistory, PullError, RemoteError, type PullResult, type Remote } from './git';

const author = { name: 'Ada Lovelace', email: 'ada@example.org' };
const TOKEN = 'a-token-that-may-write-0123456789';
const MB = 1024 * 1024;
const limits = { maxFileBytes: MB, maxProjectBytes: 4 * MB, maxProjectFiles: 20 };

let forge: Forge;
let projectDirectory: string;
let history: ProjectHistory;
let repositories = 0;

const treePath = (file: string) => path.join(projectDirectory, 'tree', file);
const write = async (file: string, content: string) => {
	await mkdir(path.dirname(treePath(file)), { recursive: true });
	await writeFile(treePath(file), content);
};
const read = (file: string) => readFile(treePath(file), 'utf8');
const exists = (file: string) =>
	stat(treePath(file)).then(
		() => true,
		() => false
	);
const rawGit = async (...args: string[]) =>
	(
		await promisify(execFile)('git', [
			`--git-dir=${path.join(projectDirectory, 'repo.git')}`,
			...args
		])
	).stdout.trim();

const newRepository = async () => {
	const name = `ada/pulled-${++repositories}`;
	const url = await forge.createRepository(name);
	const remote: Remote = { url, branch: 'main', username: 'ada', token: TOKEN };
	return { name, remote };
};

/** Fetches and pulls, as the app does. */
async function pull(
	remote: Remote,
	extra: {
		choices?: Record<string, 'ours' | 'theirs'>;
		expectedOurs?: string;
		theirs?: string;
	} = {}
): Promise<PullResult> {
	const theirs = extra.theirs ?? (await history.fetchBranch(remote, 50 * MB));
	return history.pull({ theirs, author, limits, label: 'the forge', ...extra });
}
const conflictsOf = (result: PullResult) => {
	expect(result.status).toBe('conflicts');
	return result as Extract<PullResult, { status: 'conflicts' }>;
};

beforeAll(async () => {
	forge = await startForge({ tokens: { [TOKEN]: 'write' } });
});
afterAll(() => forge.close());

beforeEach(async () => {
	projectDirectory = await mkdtemp(path.join(tmpdir(), 'kernic-pull-'));
	await mkdir(path.join(projectDirectory, 'tree'));
	history = new ProjectHistory(projectDirectory);
});
afterEach(async () => {
	await rm(projectDirectory, { recursive: true, force: true });
});

describe('pulling what a repository has', () => {
	it('moves the project forward when it has nothing the repository lacks', async () => {
		const { name, remote } = await newRepository();
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);
		await history.push(remote);
		await forge.commitFiles(
			name,
			'main',
			[
				{ path: 'chapters/two.typ', content: 'Two\n' },
				{ path: 'main.typ', content: '= Title\nMore.\n' }
			],
			'Written on the forge'
		);

		const result = await pull(remote);
		expect(result).toMatchObject({ status: 'merged', fastForward: true, changed: 2 });
		expect(await read('main.typ')).toBe('= Title\nMore.\n');
		expect(await read('chapters/two.typ')).toBe('Two\n');
		expect((await history.list())[0]!.message).toBe('Written on the forge');
		// Nothing was recorded on the side, and nothing is left to push.
		expect(await history.checkpointsSince(await history.head())).toBe(0);
		expect(await history.changes()).toEqual([]);
		expect(await history.push(remote)).toBe(await history.head());
	});

	it('says there is nothing new, also straight after a pull', async () => {
		const { name, remote } = await newRepository();
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);
		await history.push(remote);
		expect((await pull(remote)).status).toBe('up-to-date');

		await forge.commitFiles(name, 'main', [{ path: 'new.typ', content: 'New\n' }]);
		expect((await pull(remote)).status).toBe('merged');
		expect((await pull(remote)).status).toBe('up-to-date');
	});

	it('merges a repository that started on its own with the project, without touching what is only on one side', async () => {
		const { name, remote } = await newRepository();
		await forge.commitFiles(
			name,
			'main',
			[{ path: 'README.md', content: 'About.\n' }],
			'Initial commit'
		);
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);
		await expect(history.push(remote)).rejects.toMatchObject({ kind: 'diverged' });

		const result = await pull(remote);
		expect(result).toMatchObject({ status: 'merged', fastForward: false });
		expect(await read('README.md')).toBe('About.\n');
		expect(await read('main.typ')).toBe('= Title\n');
		// A merge commit with both histories as parents; the push after it is accepted.
		expect((await rawGit('rev-list', '--parents', '-n1', 'HEAD')).split(' ')).toHaveLength(3);
		await history.push(remote);
		expect(await forge.files(name, 'main')).toEqual(['README.md', 'main.typ']);
	});

	it('records unsaved-in-history changes first, and merges edits to different parts of one file', async () => {
		const { name, remote } = await newRepository();
		await write('main.typ', 'one\ntwo\nthree\nfour\nfive\n');
		await history.createCheckpoint('First draft', author);
		await history.push(remote);

		await forge.commitFiles(name, 'main', [
			{ path: 'main.typ', content: 'ONE\ntwo\nthree\nfour\nfive\n' }
		]);
		// Not yet a checkpoint: an edit at the other end of the same file.
		await write('main.typ', 'one\ntwo\nthree\nfour\nFIVE\n');

		const result = await pull(remote);
		expect(result.status).toBe('merged');
		expect(await read('main.typ')).toBe('ONE\ntwo\nthree\nfour\nFIVE\n');
		const messages = (await history.list()).map((checkpoint) => checkpoint.message);
		expect(messages).toContain('Before pulling from the forge');
		expect(await history.changes()).toEqual([]);
	});
});

describe('when both sides changed the same thing', () => {
	async function setUp() {
		const { name, remote } = await newRepository();
		await write('main.typ', 'one\ntwo\nthree\n');
		await write('gone.typ', 'to be deleted\n');
		await write('keep.typ', 'kept\n');
		await history.createCheckpoint('First draft', author);
		await history.push(remote);
		return { name, remote };
	}

	it('reports the conflicts and changes nothing, no markers in the files', async () => {
		const { name, remote } = await setUp();
		await forge.commitFiles(name, 'main', [
			{ path: 'main.typ', content: 'one\nTHEIRS\nthree\n' },
			{ path: 'gone.typ', remove: true },
			{ path: 'notes.typ', content: 'their notes\n' }
		]);
		await write('main.typ', 'one\nMINE\nthree\n');
		await write('gone.typ', 'changed here, deleted there\n');
		await write('notes.typ', 'my notes\n');

		const result = conflictsOf(await pull(remote));
		expect(result.conflicts).toEqual([
			{ path: 'gone.typ', kind: 'deleted-there' },
			{ path: 'main.typ', kind: 'both-changed' },
			{ path: 'notes.typ', kind: 'both-added' }
		]);
		expect(result.recorded).toBe(true);
		expect(await read('main.typ')).toBe('one\nMINE\nthree\n');
		expect(await read('notes.typ')).toBe('my notes\n');
		expect(await history.changes()).toEqual([]);
		// Asking again with the same state gives the same answer, and no second checkpoint.
		const again = conflictsOf(await pull(remote));
		expect(again.recorded).toBe(false);
		expect(again.ours).toBe(result.ours);
		expect(await history.list()).toHaveLength(2);
	});

	it('applies the choice made for each file, and only that', async () => {
		const { name, remote } = await setUp();
		await forge.commitFiles(name, 'main', [
			{ path: 'main.typ', content: 'one\nTHEIRS\nthree\n' },
			{ path: 'gone.typ', remove: true },
			{ path: 'notes.typ', content: 'their notes\n' },
			{ path: 'extra.typ', content: 'only there\n' }
		]);
		await write('main.typ', 'one\nMINE\nthree\n');
		await write('gone.typ', 'changed here, deleted there\n');
		await write('notes.typ', 'my notes\n');

		const found = conflictsOf(await pull(remote));
		const result = await pull(remote, {
			theirs: found.theirs,
			expectedOurs: found.ours,
			choices: { 'main.typ': 'theirs', 'gone.typ': 'theirs', 'notes.typ': 'ours' }
		});
		expect(result.status).toBe('merged');
		expect(await read('main.typ')).toBe('one\nTHEIRS\nthree\n');
		expect(await exists('gone.typ')).toBe(false);
		expect(await read('notes.typ')).toBe('my notes\n');
		expect(await read('extra.typ')).toBe('only there\n');
		expect(await read('keep.typ')).toBe('kept\n');
		expect(await history.changes()).toEqual([]);
		for (const file of ['main.typ', 'notes.typ']) expect(await read(file)).not.toMatch(/<<<<|>>>>/);
		// The choices are history too: the next push goes through as a plain fast-forward.
		await history.push(remote);
		expect(await forge.fileText(name, 'main', 'notes.typ')).toBe('my notes\n');
	});

	it("keeps this project's version of a file the repository deleted, if that is chosen", async () => {
		const { name, remote } = await setUp();
		await forge.commitFiles(name, 'main', [{ path: 'gone.typ', remove: true }]);
		await write('gone.typ', 'still needed\n');
		const found = conflictsOf(await pull(remote));
		await pull(remote, {
			theirs: found.theirs,
			expectedOurs: found.ours,
			choices: { 'gone.typ': 'ours' }
		});
		expect(await read('gone.typ')).toBe('still needed\n');
	});

	it('asks again when a file has no choice yet', async () => {
		const { name, remote } = await setUp();
		await forge.commitFiles(name, 'main', [
			{ path: 'main.typ', content: 'one\nTHEIRS\nthree\n' },
			{ path: 'keep.typ', content: 'their keep\n' }
		]);
		await write('main.typ', 'one\nMINE\nthree\n');
		await write('keep.typ', 'my keep\n');
		const found = conflictsOf(await pull(remote));
		const partial = await pull(remote, {
			theirs: found.theirs,
			expectedOurs: found.ours,
			choices: { 'main.typ': 'ours' }
		});
		expect(partial.status).toBe('conflicts');
		expect(await read('keep.typ')).toBe('my keep\n');
	});

	it('refuses a choice made about a state that is not there any more', async () => {
		const { name, remote } = await setUp();
		await forge.commitFiles(name, 'main', [{ path: 'main.typ', content: 'one\nTHEIRS\nthree\n' }]);
		await write('main.typ', 'one\nMINE\nthree\n');
		const found = conflictsOf(await pull(remote));

		// The project is edited while the choice is being made.
		await write('main.typ', 'one\nMINE, edited again\nthree\n');
		await expect(
			pull(remote, {
				theirs: found.theirs,
				expectedOurs: found.ours,
				choices: { 'main.typ': 'theirs' }
			})
		).rejects.toMatchObject({ kind: 'changed' });
		expect(await read('main.typ')).toBe('one\nMINE, edited again\nthree\n');

		// The repository moves on while the choice is being made.
		const fresh = conflictsOf(await pull(remote));
		await forge.commitFiles(name, 'main', [{ path: 'other.typ', content: 'x\n' }]);
		await history.fetchBranch(remote, 50 * MB);
		await expect(
			pull(remote, {
				theirs: fresh.theirs,
				expectedOurs: fresh.ours,
				choices: { 'main.typ': 'theirs' }
			})
		).rejects.toMatchObject({ kind: 'changed' });
	});
});

describe('what a repository may not bring in', () => {
	async function connected() {
		const { name, remote } = await newRepository();
		await write('main.typ', '= Title\n');
		await history.createCheckpoint('First draft', author);
		await history.push(remote);
		return { name, remote };
	}
	const untouched = async () => {
		expect(await read('main.typ')).toBe('= Title\n');
		expect(await readdir(path.join(projectDirectory, 'tree'))).toEqual(['main.typ']);
		expect(await history.list()).toHaveLength(1);
	};

	it('links and submodules, which would point out of the project', async () => {
		const { name, remote } = await connected();
		await forge.commitFiles(name, 'main', [
			{ path: 'passwd.typ', symlinkTo: '/etc/passwd' },
			{ path: 'fine.typ', content: 'fine\n' }
		]);
		await expect(pull(remote)).rejects.toMatchObject({ kind: 'unsafe-content' });
		await expect(pull(remote)).rejects.toThrow(/passwd\.typ.*a link/);
		await untouched();
	});

	it('names that a project cannot have', async () => {
		const { name, remote } = await connected();
		for (const bad of ['back\\slash.typ', 'tab\there.typ', 'a/ b /c.typ']) {
			await forge.commitFiles(name, 'main', [{ path: bad, content: 'x\n' }]);
			await expect(pull(remote), bad).rejects.toMatchObject({ kind: 'unsafe-content' });
			await forge.commitFiles(name, 'main', [{ path: bad, remove: true }]);
		}
		await untouched();
	});

	it('files and projects over the limits', async () => {
		const { name, remote } = await connected();
		await forge.commitFiles(name, 'main', [
			{ path: 'big.bin', content: Buffer.alloc(MB + 1, 'a') }
		]);
		await expect(pull(remote)).rejects.toMatchObject({ kind: 'too-large' });
		await forge.commitFiles(name, 'main', [{ path: 'big.bin', remove: true }]);

		await forge.commitFiles(
			name,
			'main',
			Array.from({ length: 21 }, (_, number) => ({ path: `f${number}.typ`, content: 'x\n' }))
		);
		await expect(pull(remote)).rejects.toMatchObject({ kind: 'too-large' });
		await untouched();
	});

	it('a result that would not fit, found before anything is written', async () => {
		const { name, remote } = await connected();
		await forge.commitFiles(name, 'main', [{ path: 'new.typ', content: 'new\n' }]);
		await expect(
			history.pull({
				theirs: await history.fetchBranch(remote, 50 * MB),
				author,
				limits,
				label: 'the forge',
				beforeApply: async () => {
					throw new Error('No room.');
				}
			})
		).rejects.toThrow('No room.');
		await untouched();
	});

	it('more than the server accepts to receive', async () => {
		const { name, remote } = await connected();
		// Random bytes do not compress: this is as large on the wire as it is on disk.
		const noise = Buffer.from(
			Array.from({ length: 900_000 }, () => Math.floor(Math.random() * 256))
		);
		await forge.commitFiles(name, 'main', [{ path: 'noise.bin', content: noise }]);
		const error = await history.fetchBranch(remote, 200_000).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(RemoteError);
		expect((error as RemoteError).kind).toBe('too-large');
		// Nothing of it stays in the project's repository.
		const packs = path.join(projectDirectory, 'repo.git', 'objects', 'pack');
		let bytes = 0;
		for (const file of await readdir(packs)) bytes += (await stat(path.join(packs, file))).size;
		expect(bytes).toBeLessThan(100_000);
		await untouched();
	});

	it('a branch that does not exist', async () => {
		const { remote } = await connected();
		const error = await history
			.fetchBranch({ ...remote, branch: 'not-there' }, 50 * MB)
			.catch((cause: unknown) => cause);
		expect((error as RemoteError).kind).toBe('no-branch');
	});

	it('a state that was not fetched', async () => {
		const { remote } = await connected();
		await history.fetchBranch(remote, 50 * MB);
		await expect(
			history.pull({ theirs: 'a'.repeat(40), author, limits, label: 'the forge' })
		).rejects.toBeInstanceOf(PullError);
	});
});

describe('making a project from a repository', () => {
	it('takes over the files and the whole history, in step with the repository', async () => {
		const { name, remote } = await newRepository();
		await forge.commitFiles(name, 'main', [{ path: 'main.typ', content: '= One\n' }], 'First');
		await forge.commitFiles(
			name,
			'main',
			[{ path: 'chapters/two.typ', content: 'Two\n' }],
			'Second'
		);

		const theirs = await history.fetchBranch(remote, 50 * MB);
		const adopted = await history.adoptFetched(theirs, limits);
		expect(adopted.commit).toBe(theirs);
		expect(adopted.files.map((file) => file.path).sort()).toEqual(['chapters/two.typ', 'main.typ']);
		expect(await read('chapters/two.typ')).toBe('Two\n');
		expect((await history.list()).map((checkpoint) => checkpoint.message)).toEqual([
			'Second',
			'First'
		]);
		// Files and index agree with the history: there is nothing to record, and nothing to push.
		expect(await history.changes()).toEqual([]);
		expect(await history.head()).toBe(theirs);
		expect(await history.checkpointsSince(theirs)).toBe(0);
		// And the next step is an ordinary one.
		await write('main.typ', '= One, edited\n');
		await history.createCheckpoint('Edited', author);
		await history.push(remote);
		expect(await forge.log(name, 'main')).toEqual(['Edited', 'Second', 'First']);
	});

	it('writes nothing of what a project may not hold', async () => {
		const { name, remote } = await newRepository();
		await forge.commitFiles(name, 'main', [
			{ path: 'main.typ', content: '= One\n' },
			{ path: 'passwd.typ', symlinkTo: '/etc/passwd' }
		]);
		const theirs = await history.fetchBranch(remote, 50 * MB);
		await expect(history.adoptFetched(theirs, limits)).rejects.toMatchObject({
			kind: 'unsafe-content'
		});
		expect(await readdir(path.join(projectDirectory, 'tree'))).toEqual([]);
		expect(await history.head()).toBeNull();
	});

	it('refuses a state that was not just fetched', async () => {
		const { name, remote } = await newRepository();
		await forge.commitFiles(name, 'main', [{ path: 'main.typ', content: '= One\n' }]);
		await history.fetchBranch(remote, 50 * MB);
		await expect(history.adoptFetched('b'.repeat(40), limits)).rejects.toMatchObject({
			kind: 'changed'
		});
	});
});
