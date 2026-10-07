import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import yazl from 'yazl';
import { ArchiveError, extractArchive, type ArchiveLimits } from './archive';

const limits: ArchiveLimits = { maxFiles: 10, maxFileBytes: 1000, maxTotalBytes: 3000 };

let directory: string;
let destination: string;

beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), 'kernic-archive-'));
	destination = path.join(directory, 'tree');
});

afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

type EntrySpec = string | { content: string; mode?: number };

/** Writes a ZIP with the given entries and returns its path. */
async function zipOf(entries: Record<string, EntrySpec>): Promise<string> {
	const zip = new yazl.ZipFile();
	for (const [name, spec] of Object.entries(entries)) {
		const { content, mode } = typeof spec === 'string' ? { content: spec, mode: undefined } : spec;
		zip.addBuffer(Buffer.from(content), name, mode === undefined ? {} : { mode });
	}
	zip.end();
	const zipPath = path.join(directory, 'upload.zip');
	await pipeline(zip.outputStream, createWriteStream(zipPath));
	return zipPath;
}

async function expectArchiveError(promise: Promise<unknown>, message: RegExp) {
	await expect(promise).rejects.toThrow(ArchiveError);
	await expect(promise).rejects.toThrow(message);
}

describe('extractArchive', () => {
	it('unpacks files with their paths', async () => {
		const zipPath = await zipOf({
			'main.typ': '= Title',
			'chapters/intro.typ': 'Intro',
			'assets/Übersicht.txt': 'x'
		});
		const result = await extractArchive(zipPath, destination, limits);

		expect(result.files).toEqual([
			{ path: 'assets/Übersicht.txt', size: 1 },
			{ path: 'chapters/intro.typ', size: 5 },
			{ path: 'main.typ', size: 7 }
		]);
		expect(result.strippedFolder).toBeNull();
		expect(await readFile(path.join(destination, 'chapters/intro.typ'), 'utf8')).toBe('Intro');
	});

	it('removes a single folder that wraps the whole project', async () => {
		const zipPath = await zipOf({
			'thesis-main/main.typ': 'Text',
			'thesis-main/img/a.txt': 'a'
		});
		const result = await extractArchive(zipPath, destination, limits);

		expect(result.strippedFolder).toBe('thesis-main');
		expect(result.files.map((file) => file.path)).toEqual(['img/a.txt', 'main.typ']);
	});

	it('keeps top-level folders when files also sit at the top level', async () => {
		const zipPath = await zipOf({ 'main.typ': 'Text', 'src/a.typ': 'a' });
		const result = await extractArchive(zipPath, destination, limits);
		expect(result.strippedFolder).toBeNull();
		expect(result.files.map((file) => file.path)).toEqual(['main.typ', 'src/a.typ']);
	});

	it('skips system files, Git metadata and symbolic links, and says so', async () => {
		const zipPath = await zipOf({
			'main.typ': 'Text',
			'.DS_Store': 'junk',
			'__MACOSX/._main.typ': 'junk',
			'.git/config': '[core]',
			'link.typ': { content: '/etc/passwd', mode: 0o120777 }
		});
		const result = await extractArchive(zipPath, destination, limits);

		expect(result.files.map((file) => file.path)).toEqual(['main.typ']);
		expect(result.skippedCount).toBe(4);
		expect(result.skipped.find((entry) => entry.path === 'link.typ')?.reason).toMatch(/Symbolic/);
		expect(result.skipped.find((entry) => entry.path === '.git/config')?.reason).toMatch(/Git/);
		expect(await readdir(destination)).toEqual(['main.typ']);
	});

	it('skips a file above the size limit instead of failing the import', async () => {
		const zipPath = await zipOf({ 'main.typ': 'Text', 'big.bin': 'x'.repeat(1001) });
		const result = await extractArchive(zipPath, destination, limits);
		expect(result.files.map((file) => file.path)).toEqual(['main.typ']);
		expect(result.skipped[0]).toMatchObject({ path: 'big.bin' });
	});

	it('rejects archives with too many files or too much data', async () => {
		const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}.typ`, 'x']));
		await expectArchiveError(extractArchive(await zipOf(many), destination, limits), /at most 10/);

		const heavy = Object.fromEntries(
			Array.from({ length: 4 }, (_, i) => [`f${i}.bin`, 'x'.repeat(900)])
		);
		await expectArchiveError(extractArchive(await zipOf(heavy), destination, limits), /unpacks to/);
	});

	it('rejects files that are not ZIP archives', async () => {
		const notZip = path.join(directory, 'fake.zip');
		await writeFile(notZip, 'this is not a zip file at all');
		await expectArchiveError(extractArchive(notZip, destination, limits), /not a ZIP archive/);
	});

	it('refuses entries that point outside the archive and writes nothing', async () => {
		// yazl refuses to create such entries, so patch the name inside a valid archive.
		const zipPath = await zipOf({ 'aa/evil.typ': 'x', 'main.typ': 'Text' });
		const bytes = await readFile(zipPath);
		const patched = Buffer.from(
			bytes.toString('latin1').replaceAll('aa/evil.typ', '../evil.typ'),
			'latin1'
		);
		await writeFile(zipPath, patched);

		await expectArchiveError(extractArchive(zipPath, destination, limits), /outside of it/);
		expect(await readdir(directory)).toEqual(['upload.zip']);
	});
});
