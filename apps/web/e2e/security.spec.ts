import { expect } from '@playwright/test';
import { createProject, test } from './helpers.ts';

test('the API refuses requests without a session', async ({ browser }) => {
	// A context of its own, so it carries no session; other options come from the config.
	const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const response = await anonymous.request.get(
		'/api/projects/00000000-0000-0000-0000-000000000000/tree'
	);
	expect(response.status()).toBe(401);
	await anonymous.close();
});

test('state-changing requests from another origin are rejected', async ({ page }) => {
	const id = await createProject(page, 'Blank document', 'Origin check');
	const url = `/api/projects/${id}/files/main.typ`;

	const foreign = await page.request.put(url, {
		data: 'overwritten',
		headers: { origin: 'https://evil.example', 'content-type': 'text/plain' }
	});
	expect(foreign.status()).toBe(403);

	const missing = await page.request.delete(url);
	expect(missing.status()).toBe(403);

	expect(await (await page.request.get(url)).text()).toContain('Start writing here.');
});

test('paths cannot reach outside the project', async ({ page }) => {
	const id = await createProject(page, 'Blank document', 'Traversal');
	const origin = new URL(page.url()).origin;

	for (const path of ['..%2f..%2fescape.typ', '%2e%2e%2f%2e%2e%2fescape.typ', '.git%2fconfig']) {
		const read = await page.request.get(`/api/projects/${id}/files/${path}`);
		expect([400, 404], `GET ${path}`).toContain(read.status());
		const write = await page.request.put(`/api/projects/${id}/files/${path}`, {
			data: 'x',
			headers: { origin, 'content-type': 'text/plain' }
		});
		expect([400, 404], `PUT ${path}`).toContain(write.status());
	}

	const move = await page.request.post(`/api/projects/${id}/move`, {
		data: { from: 'main.typ', to: '../main.typ' },
		headers: { origin }
	});
	expect(move.status()).toBe(400);
});

test('project files and rendered pages are served inertly', async ({ page }) => {
	const id = await createProject(page, 'Blank document', 'Headers');
	const origin = new URL(page.url()).origin;

	// An uploaded HTML file must never render as a page of this site.
	await page.request.put(`/api/projects/${id}/files/page.html`, {
		data: '<script>alert(1)</script>',
		headers: { origin, 'content-type': 'text/plain' }
	});
	const html = await page.request.get(`/api/projects/${id}/files/page.html`);
	expect(html.headers()['content-type']).toBe('text/plain; charset=utf-8');
	expect(html.headers()['content-security-policy']).toContain('sandbox');
	expect(html.headers()['x-content-type-options']).toBe('nosniff');

	const pageImage = page.locator('img.sheet').first();
	await expect(pageImage).toBeVisible();
	const rendered = await page.request.get((await pageImage.getAttribute('src'))!);
	expect(rendered.headers()['content-type']).toBe('image/svg+xml');
	expect(rendered.headers()['content-security-policy']).toContain("default-src 'none'");
});
