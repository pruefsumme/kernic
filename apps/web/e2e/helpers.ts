import { test as base, expect, type Page } from '@playwright/test';

/**
 * `test` that also fails when the page reports an uncaught error or a blocked
 * resource (content security policy), which would otherwise pass unnoticed.
 */
export const test = base.extend<{ pageProblems: string[] }>({
	pageProblems: [
		async ({ page }, use) => {
			const problems: string[] = [];
			page.on('pageerror', (error) => problems.push(`uncaught error: ${error.message}`));
			page.on('console', (message) => {
				if (message.type() === 'error' && message.text().includes('Content Security Policy')) {
					problems.push(message.text());
				}
			});
			await use(problems);
			expect(problems, 'problems reported by the browser').toEqual([]);
		},
		{ auto: true }
	]
});

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
/** The page slots of the preview; one per page of the document, loaded or not. */
export const pages = (page: Page) => page.locator('.sheet[data-index]');
/** The page images that have actually been loaded. */
export const loadedPages = (page: Page) => page.locator('.sheet[data-index] img');
export const panel = (page: Page, name: 'Files' | 'Outline' | 'Issues' | 'History') =>
	page.getByRole('complementary', { name });

/** Opens one of the sections of a settings page, by its name in the list of sections. */
export async function openSection(page: Page, name: string): Promise<void> {
	const link = page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name });
	await link.click();
	await expect(link).toHaveAttribute('aria-current', 'page');
}

/** Types at the end of the open document. */
export async function appendSource(page: Page, text: string): Promise<void> {
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type(text);
}

export async function editorText(page: Page): Promise<string> {
	return page.locator('.cm-content').innerText();
}

/** The page itself must never scroll horizontally; wide content scrolls inside its pane. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - window.innerWidth
	);
	expect(overflow, 'horizontal overflow of the page in pixels').toBeLessThanOrEqual(0);
}
