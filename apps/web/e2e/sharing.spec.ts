import { expect } from '@playwright/test';
import { baseURL } from './environment.ts';
import { appendSource, createProject, pages, previewStatus, test } from './helpers.ts';

/**
 * Links for reading: what someone without an account gets to see through
 * one, and — more to the point — everything they do not.
 */

test('a link for reading shows the pages to someone without an account, and nothing else', async ({
	page,
	browser
}) => {
	const projectId = await createProject(page, 'Report', 'For my supervisor');
	await expect(pages(page)).toHaveCount(4);
	// A second project, to try reaching its pages through the first one's link.
	const otherId = await createProject(page, 'Blank document', 'Not shared');
	await expect(pages(page)).toHaveCount(1);
	const otherPage = new URL(
		(await page.locator('.sheet[data-index] img').first().getAttribute('src'))!,
		baseURL
	).pathname;
	const otherHash = otherPage.split('/').pop()!;

	await page.goto(`/projects/${projectId}/settings`);
	await page.getByLabel('The link works for').selectOption('7');
	await page.getByRole('button', { name: 'Create a link for reading' }).click();
	const field = page.getByRole('textbox', { name: 'Link', exact: true });
	await expect(field).toBeVisible();
	const link = new URL(await field.inputValue()).pathname;
	expect(link).toMatch(/^\/shared\/[A-Za-z0-9_-]{32}$/);

	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const visitor = await context.newPage();
	await visitor.goto(link);
	await expect(visitor.getByRole('heading', { name: 'For my supervisor', level: 1 })).toBeVisible();
	await expect(visitor.getByText('Shared for reading')).toBeVisible();
	await expect(visitor.getByRole('img', { name: /^Page \d of 4$/ })).toHaveCount(4);

	// The pages are served as inert images, like the preview's.
	const source = (await visitor.getByRole('img', { name: 'Page 1 of 4' }).getAttribute('src'))!;
	const image = await visitor.request.get(source);
	expect(image.status()).toBe(200);
	expect(image.headers()['content-type']).toBe('image/svg+xml');
	expect(image.headers()['content-security-policy']).toContain('sandbox');

	// Nothing else is within reach: not the project's files or editor, not a page
	// that is not this project's, not another project's page through this link.
	for (const path of [
		`/api/projects/${projectId}/tree`,
		`/api/projects/${projectId}/files/main.typ`,
		`/api/projects/${projectId}/archive`
	]) {
		expect((await visitor.request.get(path)).status(), path).toBe(401);
	}
	expect((await visitor.request.get(`${link}/pages/${'0'.repeat(64)}`)).status()).toBe(404);
	expect((await visitor.request.get(`${link}/pages/${otherHash}`)).status()).toBe(404);
	expect((await visitor.request.get(`${link}/files/main.typ`)).status()).toBe(404);
	await visitor.goto(`/projects/${projectId}`);
	await expect(visitor).toHaveURL(/\/login/);
	expect(otherId).not.toBe(projectId);

	// The link shows the document as it is now: a change appears on reload.
	await page.goto(`/projects/${projectId}`);
	await appendSource(page, '\n#pagebreak()\n= An added chapter\n');
	await expect(pages(page)).toHaveCount(5);
	await expect(previewStatus(page)).toContainText('Up to date');
	await visitor.goto(link);
	await expect(visitor.getByRole('img', { name: /^Page \d of 5$/ })).toHaveCount(5);

	// The owner sees that it was opened, and can withdraw it.
	await page.goto(`/projects/${projectId}/settings`);
	await expect(page.getByText(/last opened/)).toBeVisible();
	await page.getByRole('button', { name: 'Withdraw' }).click();
	await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);

	await visitor.goto(link);
	await expect(
		visitor.getByRole('heading', { name: 'This link does not show anything' })
	).toBeVisible();
	expect((await visitor.request.get(source)).status()).toBe(404);
	await context.close();
});

test('a link that is not one shows nothing', async ({ browser }) => {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const visitor = await context.newPage();
	for (const path of [
		'/shared/short',
		`/shared/${'a'.repeat(32)}`,
		`/shared/${'%2e%2e%2f'.repeat(4)}`
	]) {
		const response = await visitor.request.get(path);
		expect(response.status(), path).toBe(404);
		expect(await response.text()).not.toContain('For my supervisor');
	}
	await context.close();
});
