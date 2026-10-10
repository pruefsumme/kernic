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

describe('automatic snapshots', () => {
	const at = (iso: string) => new Date(iso);

	it('records the files without touching checkpoints, the branch or the files', async () => {
		await write('main.typ', 'checkpointed\n');
		await history.createCheckpoint('First', author);
		await write('main.typ', 'written later\n');

		const snapshot = await history.takeSnapshot(at('2026-10-11T10:00:00Z'));
		expect(snapshot?.createdAt.toISOString()).toBe('2026-10-11T10:00:00.000Z');
		expect(await history.snapshots()).toEqual([snapshot]);

		// The checkpoint history and the pending changes are exactly as before.
		expect((await history.list()).map((checkpoint) => checkpoint.message)).toEqual(['First']);
		expect(await history.changes()).toEqual([{ path: 'main.typ', kind: 'modified' }]);
		expect(await read('main.typ')).toBe('written later\n');
	});

	it('does not record a state that is already recorded', async () => {
		await write('main.typ', 'one\n');
		await history.createCheckpoint('First', author);
		// Same as the checkpoint.
		expect(await history.takeSnapshot(at('2026-10-11T10:00:00Z'))).toBeNull();

		await write('main.typ', 'two\n');
		expect(await history.takeSnapshot(at('2026-10-11T10:10:00Z'))).not.toBeNull();
		// Same as the newest snapshot.
		expect(await history.takeSnapshot(at('2026-10-11T10:20:00Z'))).toBeNull();
		expect((await history.snapshots()).length).toBe(1);
	});

	it('restores a snapshot, shows what it would undo, and keeps everything else', async () => {
		await write('main.typ', 'good text\n');
		await write('figure.txt', 'data\n');
		await history.createCheckpoint('First', author);
		await write('main.typ', 'good text\nan hour of writing\n');
		const snapshot = (await history.takeSnapshot(at('2026-10-11T10:00:00Z')))!;

		// A bad edit, saved over the good work, and a deleted file.
		await write('main.typ', 'oops\n');
		await rm(path.join(tree, 'figure.txt'));

		const undo = await history.diff(snapshot.id);
		expect(undo.find((file) => file.path === 'main.typ')?.lines).toContainEqual({
			kind: 'removed',
			text: 'an hour of writing'
		});
		expect(undo.find((file) => file.path === 'figure.txt')?.kind).toBe('deleted');

		await history.restore(snapshot.id, author);
		expect(await read('main.typ')).toBe('good text\nan hour of writing\n');
		expect(await read('figure.txt')).toBe('data\n');
		expect((await history.list()).map((checkpoint) => checkpoint.message)).toEqual([
			'Restored “Automatic snapshot of 2026-10-11 10:00 UTC”',
			'Before restoring an automatic snapshot',
			'First'
		]);
	});

	it('keeps a day of snapshots, then one per day for a month', async () => {
		await write('main.typ', 'start\n');
		await history.createCheckpoint('First', author);
		const times = [
			'2026-08-01T09:00:00Z', // older than a month: dropped
			'2026-10-01T09:00:00Z', // an earlier snapshot of its day: dropped
			'2026-10-01T17:00:00Z', // last of its day: kept
			'2026-10-09T08:00:00Z', // the only one of its day: kept
			'2026-10-10T20:00:00Z', // within the last 24 hours: kept
			'2026-10-11T09:00:00Z', // within the last 24 hours: kept
			'2026-10-11T09:10:00Z' // within the last 24 hours: kept
		];
		for (const [index, time] of times.entries()) {
			await write('main.typ', `version ${index}\n`);
			await history.takeSnapshot(at(time));
		}

		expect(await history.thinSnapshots(at('2026-10-11T12:00:00Z'))).toBe(2);
		expect((await history.snapshots()).map((snapshot) => snapshot.createdAt.toISOString())).toEqual(
			[
				'2026-10-11T09:10:00.000Z',
				'2026-10-11T09:00:00.000Z',
				'2026-10-10T20:00:00.000Z',
				'2026-10-09T08:00:00.000Z',
				'2026-10-01T17:00:00.000Z'
			]
		);
		// Checkpoints and the remaining snapshots are intact after the clean-up.
		expect((await history.list()).length).toBe(1);
		const oldest = (await history.snapshots()).at(-1)!;
		await history.restore(oldest.id, author);
		expect(await read('main.typ')).toBe('version 2\n');
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
