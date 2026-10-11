import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('$app/env/private', () => ({ KERNIC_WORKER_URL: '', KERNIC_WORKER_TOKEN: '' }));
vi.mock('../packages/registry', () => ({ resolvePackages: vi.fn() }));

const { explainFontWarnings } = await import('./compile-project');

describe('explainFontWarnings', () => {
	let root: string;
	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'kernic-fonts-'));
		await writeFile(
			path.join(root, 'main.typ'),
			'#set text(font: ("Fancy Grotesk", "Libertinus Serif"))\nBody\n'
		);
	});
	afterAll(() => rm(root, { recursive: true, force: true }));

	const warning = (message: string, line: number | null = 1) => ({
		severity: 'warning' as const,
		message,
		path: line === null ? null : 'main.typ',
		line,
		column: line === null ? null : 16
	});

	it('names the font as it is written and says what to do', async () => {
		const [explained] = await explainFontWarnings(root, [
			warning('unknown font family: fancy grotesk')
		]);
		expect(explained!.message).toContain('The font “Fancy Grotesk” is not installed');
		expect(explained!.message).toContain('upload');
		expect(explained!.severity).toBe('warning');
		expect(explained!.line).toBe(1);
	});

	it('keeps the name Typst gave when the source line does not show it', async () => {
		const [elsewhere] = await explainFontWarnings(root, [
			warning('unknown font family: from a variable', 2)
		]);
		expect(elsewhere!.message).toContain('“from a variable”');
		const [unlocated] = await explainFontWarnings(root, [
			warning('unknown font family: nowhere', null)
		]);
		expect(unlocated!.message).toContain('“nowhere”');
	});

	it('leaves other messages alone', async () => {
		const other = warning('layout did not converge within 5 attempts');
		expect(await explainFontWarnings(root, [other])).toEqual([other]);
	});
});
