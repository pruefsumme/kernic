import { expect } from '@playwright/test';
import yazl from 'yazl';
import { panel, previewStatus, test } from './helpers.ts';

/** Builds a ZIP archive in memory. */
function zipOf(entries: Record<string, string>): Promise<Buffer> {
	const zip = new yazl.ZipFile();
	for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
	zip.end();
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
		zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
		zip.outputStream.on('error', reject);
	});
}

async function uploadArchive(
	page: import('@playwright/test').Page,
	name: string,
	buffer: Buffer
): Promise<void> {
	await page.goto('/');
	await page.getByRole('link', { name: 'Import a ZIP archive' }).click();
	await page.getByLabel('ZIP archive').setInputFiles({ name, mimeType: 'application/zip', buffer });
	await page.getByRole('button', { name: 'Check archive' }).click();
	await expect(page).toHaveURL(/\/import\/[0-9a-f-]{36}/);
}

test('a clean archive is checked, previewed and imported with its paths intact', async ({
	page
}) => {
	const archive = await zipOf({
		'thesis-main/main.typ': '= Thesis\n#include "chapters/one.typ"\n',
		'thesis-main/chapters/one.typ': '== Chapter one\nText.\n',
		'thesis-main/.DS_Store': 'junk',
		'thesis-main/.git/config': '[core]'
	});
	await uploadArchive(page, 'thesis-main.zip', archive);

	await expect(page.getByRole('heading', { name: 'Check before importing' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Compiles' })).toBeVisible();
	await expect(page.getByText('main.typ compiles to 1 page')).toBeVisible();
	await expect(page.getByRole('heading', { name: 'No packages needed' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'No missing files' })).toBeVisible();
	await expect(page.getByRole('heading', { name: '2 entries will be left out' })).toBeVisible();
	await expect(
		page.getByText('the single enclosing folder “thesis-main” is removed')
	).toBeVisible();
	await expect(page.getByAltText('First page of the document')).toBeVisible();

	// Nothing exists until the import is confirmed.
	const projectsBefore = await page.request.get('/');
	expect(await projectsBefore.text()).not.toContain('thesis-main');

	await expect(page.getByLabel('Project name')).toHaveValue('thesis-main');
	await expect(page.getByLabel('Main file')).toHaveValue('main.typ');
	await page.getByRole('button', { name: 'Import project' }).click();

	await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
	await expect(previewStatus(page)).toContainText('Up to date');
	const files = panel(page, 'Files');
	await expect(files.getByRole('button', { name: 'chapters', exact: true })).toBeVisible();
	await expect(files.getByRole('button', { name: 'one.typ', exact: true })).toBeVisible();
	await expect(files.getByRole('button', { name: '.DS_Store' })).toHaveCount(0);
});

test('problems are reported before anything is created, and the import can be cancelled', async ({
	page
}) => {
	const archive = await zipOf({
		// A package that exists neither in the test registry nor on Typst Universe.
		'main.typ':
			'#import "@preview/kernic-no-such-package:9.9.9": thing\n#image("figures/missing.png")\nText\n',
		'notes.typ': 'Loose notes\n'
	});
	await uploadArchive(page, 'Broken report.zip', archive);

	await expect(page.getByRole('heading', { name: /Does not compile yet/ })).toBeVisible();
	await expect(page.getByRole('heading', { name: '1 package is not available' })).toBeVisible();
	await expect(page.getByText('@preview/kernic-no-such-package:9.9.9').first()).toBeVisible();
	await expect(
		page.getByRole('heading', { name: '1 referenced file is not in the archive' })
	).toBeVisible();
	await expect(page.getByText('figures/missing.png')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Import anyway' })).toBeVisible();

	const importUrl = page.url();
	await page.getByRole('button', { name: 'Cancel and discard the upload' }).click();
	await expect(page).toHaveURL('/');
	await expect(page.getByText('Broken report')).toHaveCount(0);
	// The staged upload is gone.
	expect((await page.request.get(importUrl)).status()).toBe(404);
});

test('a file that is not a ZIP archive is rejected with an explanation', async ({ page }) => {
	await uploadArchive(page, 'fake.zip', Buffer.from('this is not an archive'));

	await expect(page.getByRole('heading', { name: 'fake.zip cannot be imported' })).toBeVisible();
	await expect(page.getByRole('alert')).toContainText('not a ZIP archive');
	await expect(page.getByText('Nothing was created')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Choose another archive' })).toBeVisible();
});

test('an archive without Typst files is rejected', async ({ page }) => {
	await uploadArchive(page, 'photos.zip', await zipOf({ 'a.txt': 'hello', 'b.csv': '1,2' }));
	await expect(page.getByRole('alert')).toContainText('no .typ files');
});
