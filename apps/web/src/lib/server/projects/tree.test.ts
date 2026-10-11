import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	TreeError,
	createTreeDirectory,
	deleteTreeEntry,
	listTree,
	moveTreeEntry,
	readTreeFile,
	removeInterruptedWrites,
	sha256,
	writeTreeFile,
	type TreeLimits
} from './tree';

const limits: TreeLimits = { maxFileBytes: 1024, maxProjectBytes: 4096, maxProjectFiles: 8 };
const text = (value: string) => Buffer.from(value);

let root: string;
let outside: string;

beforeEach(async () => {
	const base = await mkdtemp(path.join(tmpdir(), 'kernic-tree-'));
	root = path.join(base, 'tree');
	outside = path.join(base, 'outside');
	await mkdir(root);
	await mkdir(outside);
});

afterEach(async () => {
	await rm(path.dirname(root), { recursive: true, force: true });
});

async function expectTreeError(promise: Promise<unknown>, code: TreeError['code']) {
	await expect(promise).rejects.toMatchObject({ name: 'Error', code });
}

describe('reading and writing', () => {
	it('writes nested files and lists parents before children', async () => {
		await writeTreeFile(root, 'main.typ', text('= Title'), { limits });
		await writeTreeFile(root, 'chapters/intro.typ', text('Intro'), { limits });

		expect(await listTree(root)).toEqual([
			{ path: 'chapters', type: 'directory', size: 0 },
			{ path: 'chapters/intro.typ', type: 'file', size: 5 },
			{ path: 'main.typ', type: 'file', size: 7 }
		]);
		expect((await readTreeFile(root, 'chapters/intro.typ')).toString()).toBe('Intro');
	});

	it('leaves no temporary files behind', async () => {
		await writeTreeFile(root, 'main.typ', text('one'), { limits });
		await writeTreeFile(root, 'main.typ', text('two'), { limits });
		expect(await readdir(root)).toEqual(['main.typ']);
	});

	it('reports missing files and folders read as files', async () => {
		await createTreeDirectory(root, 'assets', limits);
		await expectTreeError(readTreeFile(root, 'nope.typ'), 'not-found');
		await expectTreeError(readTreeFile(root, 'assets'), 'not-a-file');
	});

	it('rejects paths that leave the project', async () => {
		await writeFile(path.join(outside, 'secret.txt'), 'secret');
		await expectTreeError(readTreeFile(root, '../outside/secret.txt'), 'invalid-path');
		await expectTreeError(
			writeTreeFile(root, '../outside/new.txt', text('x'), { limits }),
			'invalid-path'
		);
		await expectTreeError(deleteTreeEntry(root, '..'), 'invalid-path');
	});

	it('does not follow symbolic links out of the project', async () => {
		await writeFile(path.join(outside, 'secret.txt'), 'secret');
		await symlink(outside, path.join(root, 'link'));
		await symlink(path.join(outside, 'secret.txt'), path.join(root, 'file-link.txt'));

		await expectTreeError(readTreeFile(root, 'link/secret.txt'), 'invalid-path');
		await expectTreeError(readTreeFile(root, 'file-link.txt'), 'invalid-path');
		await expectTreeError(
			writeTreeFile(root, 'link/planted.txt', text('x'), { limits }),
			'invalid-path'
		);
		expect(await readdir(outside)).toEqual(['secret.txt']);
		expect(await listTree(root)).toEqual([]);
	});
});

describe('saves that were interrupted', () => {
	it('leaves nothing behind after a normal save, and clears what a killed one left', async () => {
		// Laid out like the data directory: <projects>/<project id>/tree.
		const projects = path.dirname(path.dirname(root));
		const project = path.join(projects, 'project-1');
		const tree = path.join(project, 'tree');
		await mkdir(tree, { recursive: true });

		await writeTreeFile(tree, 'main.typ', text('saved'), { limits });
		expect(await readdir(`${tree}.tmp`)).toEqual([]);

		await writeFile(path.join(`${tree}.tmp`, 'half-written'), 'cut off');
		expect(await removeInterruptedWrites(projects)).toBe(1);
		expect(await readdir(`${tree}.tmp`)).toEqual([]);
		// The files themselves are not touched.
		expect((await readTreeFile(tree, 'main.typ')).toString()).toBe('saved');
		expect(await removeInterruptedWrites(path.join(projects, 'missing'))).toBe(0);

		await rm(project, { recursive: true, force: true });
	});
});

describe('conflict detection', () => {
	it('accepts a write based on the current content', async () => {
		const first = await writeTreeFile(root, 'main.typ', text('v1'), { limits, baseHash: null });
		expect(first).toBe(sha256(text('v1')));
		const second = await writeTreeFile(root, 'main.typ', text('v2'), { limits, baseHash: first });
		expect(second).toBe(sha256(text('v2')));
	});

	it('refuses to overwrite content the writer has not seen', async () => {
		const original = await writeTreeFile(root, 'main.typ', text('v1'), { limits });
		await writeTreeFile(root, 'main.typ', text('changed elsewhere'), { limits });

		await expectTreeError(
			writeTreeFile(root, 'main.typ', text('mine'), { limits, baseHash: original }),
			'conflict'
		);
		expect((await readTreeFile(root, 'main.typ')).toString()).toBe('changed elsewhere');
	});

	it('refuses to create a file that already exists, or to revive a deleted one', async () => {
		const hash = await writeTreeFile(root, 'main.typ', text('v1'), { limits });
		await expectTreeError(
			writeTreeFile(root, 'main.typ', text('new'), { limits, baseHash: null }),
			'conflict'
		);

		await deleteTreeEntry(root, 'main.typ');
		await expectTreeError(
			writeTreeFile(root, 'main.typ', text('v2'), { limits, baseHash: hash }),
			'conflict'
		);
	});
});

describe('limits', () => {
	it('rejects a file above the file size limit', async () => {
		await expectTreeError(
			writeTreeFile(root, 'big.bin', Buffer.alloc(1025), { limits }),
			'file-too-large'
		);
	});

	it('rejects writes that push the project over its size limit', async () => {
		for (const name of ['a', 'b', 'c', 'd']) {
			await writeTreeFile(root, `${name}.bin`, Buffer.alloc(1000), { limits });
		}
		await expectTreeError(
			writeTreeFile(root, 'e.bin', Buffer.alloc(1000), { limits }),
			'project-too-large'
		);
		// Shrinking an existing file is always allowed.
		await writeTreeFile(root, 'a.bin', Buffer.alloc(10), { limits });
	});

	it('rejects more entries than the file count limit', async () => {
		for (let index = 0; index < 8; index++) {
			await writeTreeFile(root, `file-${index}.typ`, text('x'), { limits });
		}
		await expectTreeError(
			writeTreeFile(root, 'one-more.typ', text('x'), { limits }),
			'too-many-files'
		);
		await expectTreeError(createTreeDirectory(root, 'folder', limits), 'too-many-files');
	});
});

describe('moving and deleting', () => {
	it('renames files and moves folders with their contents', async () => {
		await writeTreeFile(root, 'draft/intro.typ', text('Intro'), { limits });
		await moveTreeEntry(root, 'draft', 'chapters/final');
		expect((await readTreeFile(root, 'chapters/final/intro.typ')).toString()).toBe('Intro');
		await expectTreeError(readTreeFile(root, 'draft/intro.typ'), 'not-found');
	});

	it('never overwrites the target of a move', async () => {
		await writeTreeFile(root, 'a.typ', text('A'), { limits });
		await writeTreeFile(root, 'b.typ', text('B'), { limits });
		await expectTreeError(moveTreeEntry(root, 'a.typ', 'b.typ'), 'already-exists');
		expect((await readTreeFile(root, 'b.typ')).toString()).toBe('B');
	});

	it('refuses to move a folder into itself or a missing entry', async () => {
		await createTreeDirectory(root, 'a', limits);
		await expectTreeError(moveTreeEntry(root, 'a', 'a/b'), 'invalid-path');
		await expectTreeError(moveTreeEntry(root, 'missing.typ', 'x.typ'), 'not-found');
	});

	it('deletes folders recursively', async () => {
		await writeTreeFile(root, 'assets/img/logo.svg', text('<svg/>'), { limits });
		await deleteTreeEntry(root, 'assets');
		expect(await listTree(root)).toEqual([]);
		await expectTreeError(deleteTreeEntry(root, 'assets'), 'not-found');
	});

	it('refuses to create a folder where something already exists', async () => {
		await writeTreeFile(root, 'notes', text('a file named notes'), { limits });
		await expectTreeError(createTreeDirectory(root, 'notes', limits), 'already-exists');
		await expectTreeError(
			writeTreeFile(root, 'notes/inner.typ', text('x'), { limits }),
			'not-a-directory'
		);
	});
});
