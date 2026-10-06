import { expect } from '@playwright/test';
import { createProject, test } from './helpers.ts';

test('the dashboard lists, searches and sorts projects', async ({ page }) => {
	await createProject(page, 'Letter', 'Zebra letter');
	await createProject(page, 'Blank document', 'Alpha notes');

	await page.goto('/');
	const names = page.locator('.projects .name');
	await expect(names.first()).toHaveText('Alpha notes'); // most recently edited first

	await page.getByLabel('Sort by').selectOption('name');
	await expect(names.first()).toHaveText('Alpha notes');
	await page.getByRole('button', { name: 'List' }).click();
	await expect(page.locator('.projects.list')).toBeVisible();

	await page.getByPlaceholder('Search projects').fill('zebra');
	await expect(names).toHaveText(['Zebra letter']);
	await page.getByPlaceholder('Search projects').fill('no such project');
	await expect(page.getByText('No project name contains')).toBeVisible();
	await page.getByRole('button', { name: 'Clear search' }).click();
	await expect(names).not.toHaveCount(0);
});

test('"Empty document" creates a project in one step', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('button', { name: /Empty document/ }).click();
	await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
	await expect(page.locator('.cm-content')).toContainText('Start writing here.');
});

test('the template picker filters by category and search', async ({ page }) => {
	await page.goto('/?new');
	const dialog = page.getByRole('dialog');
	const options = dialog.locator('.option-name');
	await expect(options).toHaveCount(4);

	await dialog.getByRole('button', { name: 'Letters' }).click();
	await expect(options).toHaveText(['Letter']);
	await dialog.getByRole('button', { name: 'All', exact: true }).click();
	await dialog.getByPlaceholder('Search templates').fill('bibliography');
	await expect(options).toHaveText(['Article']);
	await dialog.getByPlaceholder('Search templates').fill('nothing like this');
	await expect(dialog.getByText('No template matches')).toBeVisible();

	// Closing the picker also removes it from the address.
	await dialog.getByRole('button', { name: 'Close' }).click();
	await expect(page).toHaveURL('/');
});

test('settings rename the project, change the main file and delete it', async ({ page }) => {
	const id = await createProject(page, 'Report', 'Settings subject');
	await page.goto(`/projects/${id}/settings`);

	await page.getByLabel('Project name', { exact: true }).fill('Renamed subject');
	await page.getByRole('button', { name: 'Save name' }).click();
	await expect(page.getByRole('link', { name: 'Renamed subject' })).toBeVisible();

	await page.getByLabel('Main file').selectOption('chapters/introduction.typ');
	await page.getByRole('button', { name: 'Save main file' }).click();
	await expect(page.getByRole('status')).toHaveText('Saved');
	await page.reload();
	await expect(page.getByLabel('Main file')).toHaveValue('chapters/introduction.typ');

	const remove = page.getByRole('button', { name: 'Delete this project' });
	await expect(remove).toBeDisabled();
	await page.getByLabel('Type the project name to confirm').fill('Renamed subject');
	await remove.click();
	await expect(page).toHaveURL('/');
	await expect(page.getByText('Renamed subject')).toHaveCount(0);
	expect((await page.request.get(`/api/projects/${id}/tree`)).status()).toBe(404);
});
