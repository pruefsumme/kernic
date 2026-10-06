import { expect, type Page } from '@playwright/test';

/** Creates a project from a template through the picker and returns its id. */
export async function createProject(
	page: Page,
	template: 'Blank document' | 'Article' | 'Report' | 'Letter',
	name: string
): Promise<string> {
	await page.goto('/?new');
	const dialog = page.getByRole('dialog');
	await dialog.getByText(template, { exact: true }).first().click();
	await dialog.getByLabel('Project name').fill(name);
	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
	await expect(page.locator('.cm-content')).toBeVisible();
	return new URL(page.url()).pathname.split('/')[2]!;
}

export const previewStatus = (page: Page) =>
	page.getByRole('region', { name: 'Preview' }).getByRole('status');
export const saveState = (page: Page) => page.locator('.save');
export const pages = (page: Page) => page.locator('img.sheet');
export const panel = (page: Page, name: 'Files' | 'Outline' | 'Issues') =>
	page.getByRole('complementary', { name });

/** Types at the end of the open document. */
export async function appendSource(page: Page, text: string): Promise<void> {
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(text);
}

export async function editorText(page: Page): Promise<string> {
	return page.locator('.cm-content').innerText();
}
