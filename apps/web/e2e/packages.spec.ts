import { expect } from '@playwright/test';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { dataDir, externalBaseURL } from './environment.ts';
import { appendSource, createProject, pages, panel, previewStatus, test } from './helpers.ts';

// These tests rely on the fake registry that is only started for local runs.
test.skip(!!externalBaseURL, 'needs the fake package registry');

test('a document can use a package, and the packages that package uses', async ({ page }) => {
	await createProject(page, 'Blank document', 'Uses packages');
	await expect(previewStatus(page)).toContainText('Up to date');

	// greeting imports punctuation; neither is installed before this compile.
	await appendSource(page, '\n#import "@preview/greeting:0.1.0": greet\n#greet("Kernic")');
	await expect(previewStatus(page)).toContainText('Up to date');
	await expect(pages(page)).toHaveCount(1);
	await page.getByRole('button', { name: /^Issues/ }).click();
	await expect(panel(page, 'Issues')).toContainText('No errors or warnings');
});

test('a package that does not exist is named in the error, with the reason', async ({ page }) => {
	await createProject(page, 'Blank document', 'Missing package');
	await appendSource(page, '\n#import "@preview/no-such-package:9.9.9": thing');

	await expect(previewStatus(page)).toContainText('1 error');
	await page.getByRole('button', { name: /^Issues/ }).click();
	const issue = panel(page, 'Issues').getByRole('button', { name: /no-such-package/ });
	await expect(issue).toContainText('@preview/no-such-package:9.9.9 is not available');
	await expect(issue).toContainText('does not exist on Typst Universe');
	await expect(issue).toContainText('main.typ, line 5');
});

test('packages outside Typst Universe are refused with an explanation', async ({ page }) => {
	await createProject(page, 'Blank document', 'Private namespace');
	await appendSource(page, '\n#import "@local/house-style:1.0.0": style');

	await page.getByRole('button', { name: /^Issues/ }).click();
	await expect(panel(page, 'Issues')).toContainText('only packages from Typst Universe');
});

test('links inside a package archive are not unpacked', async ({ page }) => {
	await createProject(page, 'Blank document', 'Hostile package');
	// The package tries to read a file of the server through a symbolic link it ships.
	await appendSource(page, '\n#import "@preview/hostile:1.0.0": secret\n#secret');

	await expect(previewStatus(page)).toContainText('1 error');
	await page.getByRole('button', { name: /^Issues/ }).click();
	await expect(panel(page, 'Issues')).toContainText('file not found');

	const packageDir = path.join(dataDir, 'packages', 'preview', 'hostile', '1.0.0');
	expect((await lstat(path.join(packageDir, 'lib.typ'))).isFile()).toBe(true);
	await expect(lstat(path.join(packageDir, 'stolen.txt'))).rejects.toThrow();
});
