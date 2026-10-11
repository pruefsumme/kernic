import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchTree } from './search';

describe('searchTree', () => {
	let root: string;
	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'kernic-search-'));
		await mkdir(path.join(root, 'chapters'));
		await writeFile(
			path.join(root, 'main.typ'),
			'= Thesis\n#include "chapters/intro.typ"\nThe method (see @method) works.\r\nMETHOD and method.\n'
		);
		await writeFile(path.join(root, 'chapters/intro.typ'), 'An introduction.\nNo match here.\n');
		await writeFile(path.join(root, 'refs.bib'), '@book{method, title = {İstanbul method}}\n');
		await writeFile(path.join(root, 'figure.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
		await writeFile(path.join(root, 'long.txt'), `${'x'.repeat(500)} needle ${'y'.repeat(500)}\n`);
		await writeFile(path.join(root, 'many.txt'), 'hit\n'.repeat(500));
	});
	afterAll(() => rm(root, { recursive: true, force: true }));

	const find = async (query: string) => (await searchTree(root, query)).matches;

	it('finds text in every text file, without regard to case, with line and column', async () => {
		const matches = await find('method');
		expect(matches.map((match) => [match.path, match.line, match.column])).toEqual([
			['main.typ', 3, 4],
			['main.typ', 3, 17],
			['main.typ', 4, 0],
			['main.typ', 4, 11],
			['refs.bib', 1, 6],
			['refs.bib', 1, 32]
		]);
		expect(matches[0]).toMatchObject({
			preview: 'The method (see @method) works.',
			start: 4,
			length: 6
		});
	});

	it('takes the query literally', async () => {
		expect(await find('(see @method)')).toHaveLength(1);
		expect(await find('.*')).toEqual([]);
		expect(await find('a+')).toEqual([]);
		expect((await find('"chapters/intro.typ"'))[0]).toMatchObject({ path: 'main.typ', line: 2 });
	});

	it('begins the preview shortly before a match that is far into its line', async () => {
		const match = (await find('works.'))[0]!;
		expect(match.column).toBe(25);
		expect(match.preview).toBe('…he method (see @method) works.');
		expect(match.preview.slice(match.start, match.start + match.length)).toBe('works.');
	});

	it('skips binary files', async () => {
		expect((await find('PNG')).map((match) => match.path)).toEqual([]);
	});

	it('shows the part of a long line around the match', async () => {
		const [match] = await find('needle');
		expect(match!.column).toBe(501);
		expect(match!.preview.length).toBeLessThan(170);
		expect(match!.preview.slice(match!.start, match!.start + match!.length)).toBe('needle');
		expect(match!.preview.startsWith('…') && match!.preview.endsWith('…')).toBe(true);
	});

	it('limits the matches per file and says when there are more', async () => {
		const result = await searchTree(root, 'hit');
		expect(result.matches).toHaveLength(60);
		expect(result.truncated).toBe(true);
		expect((await searchTree(root, 'introduction')).truncated).toBe(false);
	});
});
