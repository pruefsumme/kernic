import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NothingToCheckpointError, ProjectHistory, UnknownCheckpointError, parseDiff } from './git';

const author = { name: 'Ada Lovelace', email: 'ada@example.org' };

let projectDirectory: string;
let tree: string;
let history: ProjectHistory;

const write = async (file: string, content: string) => {
	await mkdir(path.dirname(path.join(tree, file)), { recursive: true });
	await writeFile(path.join(tree, file), content);
};
const read = (file: string) => readFile(path.join(tree, file), 'utf8');

beforeEach(async () => {
	projectDirectory = await mkdtemp(path.join(tmpdir(), 'kernic-history-'));
	tree = path.join(projectDirectory, 'tree');
	await mkdir(tree);
	history = new ProjectHistory(projectDirectory);
});

afterEach(async () => {
	await rm(projectDirectory, { recursive: true, force: true });
});

describe('checkpoints', () => {
	it('records the files and lists checkpoints newest first', async () => {
		await write('main.typ', '= Title\n');
		const first = await history.createCheckpoint('First draft', author);
		await write('main.typ', '= Title\nMore.\n');
		await write('chapters/one.typ', 'One\n');
		await history.createCheckpoint('Add chapter one', author);

		const list = await history.list();
		expect(list.map((checkpoint) => checkpoint.message)).toEqual([
			'Add chapter one',
			'First draft'
		]);
		expect(list[1]).toMatchObject({ id: first.id, authorName: 'Ada Lovelace' });
		expect(list[0]!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
	});

	it('refuses an empty checkpoint once history exists', async () => {
		await write('main.typ', 'Text\n');
		await history.createCheckpoint('First', author);
		await expect(history.createCheckpoint('Again', author)).rejects.toThrow(
			NothingToCheckpointError
		);
	});

	it('keeps Git data out of the project files', async () => {
		await write('main.typ', 'Text\n');
		await history.createCheckpoint('First', author);
		expect(await readdir(tree)).toEqual(['main.typ']);
		expect((await readdir(projectDirectory)).sort()).toEqual(['repo.git', 'tree']);
	});

	it('sanitizes author details', async () => {
		await write('main.typ', 'Text\n');
		await history.createCheckpoint('First', { name: 'Eve <root@evil>\nX', email: 'a@b>\n' });
		expect((await history.list())[0]!.authorName).toBe('Eve  root@evil  X');
	});
});

describe('changes since the last checkpoint', () => {
	it('reports added, modified and deleted files', async () => {
		await write('main.typ', 'one\n');
		await write('old.typ', 'old\n');
		await history.createCheckpoint('First', author);
		expect(await history.changes()).toEqual([]);

		await write('main.typ', 'two\n');
		await write('new file.typ', 'new\n');
		await rm(path.join(tree, 'old.typ'));

		expect(await history.changes()).toEqual([
			{ path: 'main.typ', kind: 'modified' },
			{ path: 'new file.typ', kind: 'added' },
			{ path: 'old.typ', kind: 'deleted' }
		]);
	});

	it('shows the working changes and the changes of a checkpoint as diffs', async () => {
		await write('main.typ', 'line one\nline two\n');
		await history.createCheckpoint('First', author);
		await write('main.typ', 'line one\nline 2\n');
		await write('notes.typ', 'fresh\n');

		const working = await history.diff(null);
		const main = working.find((file) => file.path === 'main.typ')!;
		expect(main.kind).toBe('modified');
		expect(main.lines.filter((line) => line.kind !== 'hunk')).toEqual([
			{ kind: 'context', text: 'line one' },
			{ kind: 'removed', text: 'line two' },
			{ kind: 'added', text: 'line 2' }
		]);
		expect(working.find((file) => file.path === 'notes.typ')).toMatchObject({ kind: 'added' });

		const second = await history.createCheckpoint('Second', author);
		const recorded = await history.diff(second.id);
		expect(recorded.map((file) => file.path).sort()).toEqual(['main.typ', 'notes.typ']);
	});

	it('marks binary files instead of printing them', async () => {
		await write('main.typ', 'x\n');
		await history.createCheckpoint('First', author);
		await writeFile(path.join(tree, 'image.png'), Buffer.from([0x89, 0x50, 0, 0, 1, 2, 3, 0]));
		const [file] = await history.diff(null);
		expect(file).toMatchObject({ path: 'image.png', binary: true, lines: [] });
	});
});

describe('restore', () => {
	it('brings back an earlier state, including deleted files, and keeps all history', async () => {
		await write('main.typ', 'version one\n');
		await write('appendix.typ', 'appendix\n');
		const first = await history.createCheckpoint('Version one', author);

		await write('main.typ', 'version two\n');
		await rm(path.join(tree, 'appendix.typ'));
		await write('extra.typ', 'extra\n');
		await history.createCheckpoint('Version two', author);

		// An edit that was never checkpointed must survive the restore too.
		await write('main.typ', 'version three, not checkpointed\n');
		await history.restore(first.id, author);

		expect(await read('main.typ')).toBe('version one\n');
		expect(await read('appendix.typ')).toBe('appendix\n');
		expect((await readdir(tree)).sort()).toEqual(['appendix.typ', 'main.typ']);

		const messages = (await history.list()).map((checkpoint) => checkpoint.message);
		expect(messages).toEqual([
			'Restored “Version one”',
			'Before restoring an earlier checkpoint',
			'Version two',
			'Version one'
		]);

		// The uncheckpointed edit is recoverable from the safety checkpoint.
		const safety = (await history.list())[1]!;
		await history.restore(safety.id, author);
		expect(await read('main.typ')).toBe('version three, not checkpointed\n');
	});

	it('restoring the state the files are already in changes nothing', async () => {
		await write('main.typ', 'same\n');
		const only = await history.createCheckpoint('Only', author);
		const result = await history.restore(only.id, author);
		expect(result.id).toBe(only.id);
		expect((await history.list()).length).toBe(1);
	});

	it('rejects ids that are not checkpoints of this project', async () => {
		await write('main.typ', 'x\n');
		await history.createCheckpoint('First', author);
		await expect(history.restore('0'.repeat(40), author)).rejects.toThrow(UnknownCheckpointError);
		await expect(history.restore('HEAD; rm -rf /', author)).rejects.toThrow(UnknownCheckpointError);
		await expect(history.diff('--output=/tmp/x')).rejects.toThrow(UnknownCheckpointError);
	});
});

describe('untrusted project content', () => {
	it('does not run filters, hooks or options smuggled in through files', async () => {
		const marker = path.join(projectDirectory, 'executed');
		await write('.gitattributes', '*.typ filter=evil diff=evil\n');
		await write('.gitconfig', `[filter "evil"]\n\tclean = touch ${marker}\n`);
		await write('--upload-pack=touch x', 'odd name\n');
		await write('-rf', 'odd name\n');
		await write('main.typ', 'text\n');

		await history.createCheckpoint('Hostile', author);
		await write('main.typ', 'changed\n');
		await history.diff(null);
		await history.createCheckpoint('Second', author);

		expect((await readdir(projectDirectory)).sort()).toEqual(['repo.git', 'tree']);
		expect((await history.list()).length).toBe(2);
	});
});

describe('parseDiff', () => {
	it('recognizes renames', () => {
		const [file] = parseDiff(
			[
				'diff --git a/old name.typ b/new name.typ',
				'similarity index 100%',
				'rename from old name.typ',
				'rename to new name.typ'
			].join('\n')
		);
		expect(file).toMatchObject({
			path: 'new name.typ',
			previousPath: 'old name.typ',
			kind: 'renamed'
		});
	});
});
