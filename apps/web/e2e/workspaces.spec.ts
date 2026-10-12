import { expect, type Browser, type Page } from '@playwright/test';
import { baseURL } from './environment.ts';
import { appendSource, createProject, saveState, test } from './helpers.ts';

/**
 * Shared workspaces, with two real accounts: the administrator who owns the
 * workspace, and a colleague who is invited to the server and then to the
 * workspace. Everything goes through the interface, so this also runs against
 * a deployment.
 */

test.describe.configure({ mode: 'serial' });

const colleague = {
	email: `mary-${Date.now()}@example.org`,
	name: 'Mary Jackson',
	password: 'a passphrase for mary'
};
const workspaceName = `Thesis group ${Date.now()}`;

let theirs: Page;
let workspaceUrl: string;
let projectId: string;

/** Reads the link that a "create a link" action shows once. */
async function shownLink(page: Page): Promise<string> {
	const field = page.getByRole('textbox', { name: 'Link', exact: true });
	await expect(field).toBeVisible();
	return new URL(await field.inputValue()).pathname;
}

async function accountFor(page: Page, browser: Browser): Promise<Page> {
	await page.goto('/admin/users');
	await page.getByLabel('Their email address').fill(colleague.email);
	await page.getByRole('button', { name: 'Create invitation link' }).click();
	const link = await shownLink(page);

	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const fresh = await context.newPage();
	await fresh.goto(link);
	await fresh.getByLabel('Your name').fill(colleague.name);
	await fresh.getByLabel('Password', { exact: true }).fill(colleague.password);
	await fresh.getByLabel('Password, again').fill(colleague.password);
	await fresh.getByRole('button', { name: 'Create account' }).click();
	await expect(fresh).toHaveURL('/');
	return fresh;
}

const saveAs = (page: Page, text: string) =>
	page.request.put(`/api/projects/${projectId}/files/shared-note.typ`, {
		headers: { origin: baseURL, 'content-type': 'text/plain' },
		data: text
	});

test('an owner creates a shared workspace with a project in it', async ({ page, browser }) => {
	theirs = await accountFor(page, browser);

	await page.goto('/workspaces');
	await page.getByLabel('Name').fill(workspaceName);
	await page.getByRole('button', { name: 'Create workspace' }).click();
	await expect(page.getByRole('heading', { name: workspaceName, level: 1 })).toBeVisible();
	workspaceUrl = new URL(page.url()).pathname;
	await expect(page.getByText('you are an owner')).toBeVisible();

	// A project made in the personal workspace is moved into the shared one.
	projectId = await createProject(page, 'Report', 'Group report');
	await page.goto(`/projects/${projectId}/settings`);
	await page.getByLabel('Move to').selectOption({ label: workspaceName });
	await page.getByRole('button', { name: 'Move project' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toBeVisible();
	await expect(page.getByText(`This project is in ${workspaceName}`)).toBeVisible();

	// Until they are a member, the colleague cannot reach any of it.
	expect((await theirs.request.get(`/api/projects/${projectId}/tree`)).status()).toBe(404);
	expect((await theirs.request.get(workspaceUrl)).status()).toBe(404);
});

test('someone joins through a link, once, in the role it names', async ({ page }) => {
	await page.goto(workspaceUrl);
	await page.getByLabel('They join as').selectOption('viewer');
	await page.getByRole('button', { name: 'Create a link' }).click();
	const link = await shownLink(page);

	await theirs.goto(link);
	await expect(theirs.getByRole('heading', { name: `Join “${workspaceName}”?` })).toBeVisible();
	await expect(theirs.getByText('without changing them')).toBeVisible();
	await theirs.getByRole('button', { name: 'Join the workspace' }).click();
	await expect(theirs.getByRole('heading', { name: workspaceName, level: 1 })).toBeVisible();
	await expect(theirs.getByText('you are a viewer')).toBeVisible();
	// A viewer sees who is there but has none of the owner's controls.
	await expect(theirs.getByText(colleague.email)).toBeVisible();
	await expect(theirs.getByRole('button', { name: 'Create a link' })).toHaveCount(0);

	// The link is spent.
	await theirs.goto(link);
	await expect(theirs.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();

	// The project is on their dashboard and opens read-only.
	await theirs.goto('/');
	await theirs
		.getByRole('link', { name: /Group report/ })
		.first()
		.click();
	await expect(theirs.locator('.cm-content')).toBeVisible();
	await expect(theirs.getByText('Read only')).toBeVisible();
	expect((await saveAs(theirs, 'May a viewer write?')).status()).toBe(403);
});

test('roles decide what a member may do, and removal ends access at once', async ({ page }) => {
	// Made an editor, the colleague can write.
	await page.goto(workspaceUrl);
	await page.getByLabel(`Role of ${colleague.name}`).selectOption('editor');
	await expect(page.getByLabel(`Role of ${colleague.name}`)).toHaveValue('editor');
	await expect.poll(async () => (await saveAs(theirs, 'An editor writes.')).status()).toBe(200);

	// Showing the project to people outside the workspace is an owner's decision.
	const sharing = await theirs.request.post(`/projects/${projectId}/settings?/share`, {
		headers: { origin: baseURL },
		form: { lifetime: '7' }
	});
	expect(sharing.status()).toBe(403);
	// So is giving the server a token for a repository elsewhere. Pushing is for whoever may
	// write: the editor gets as far as "not connected", a viewer later does not.
	const connecting = await theirs.request.post(`/projects/${projectId}/settings?/connect`, {
		headers: { origin: baseURL },
		form: { url: 'https://git.example.org/mary/own.git', token: 'a-token-of-the-colleague' }
	});
	expect(connecting.status()).toBe(403);
	const pushAs = (who: Page) =>
		who.request.post(`/api/projects/${projectId}/history/push`, {
			headers: { origin: baseURL, 'content-type': 'application/json' },
			data: {}
		});
	expect((await pushAs(theirs)).status()).toBe(409);
	await page.getByLabel(`Role of ${colleague.name}`).selectOption('viewer');
	await expect(page.getByLabel(`Role of ${colleague.name}`)).toHaveValue('viewer');
	await expect.poll(async () => (await pushAs(theirs)).status()).toBe(403);
	await page.getByLabel(`Role of ${colleague.name}`).selectOption('editor');
	await expect(page.getByLabel(`Role of ${colleague.name}`)).toHaveValue('editor');

	// Both see the same file; the owner's editor shows the colleague's text.
	await page.goto(`/projects/${projectId}?file=shared-note.typ`);
	await expect(page.locator('.cm-content')).toContainText('An editor writes.');
	await appendSource(page, ' The owner adds to it.');
	await expect(saveState(page)).toContainText('Saved');

	// The workspace cannot lose its only owner, by leaving or by a change of role.
	await page.goto(workspaceUrl);
	await page.getByRole('button', { name: 'Leave the workspace' }).click();
	await expect(page.getByRole('alert')).toContainText('needs an owner');

	// Only owners manage members: the editor cannot remove the owner or promote themselves.
	const meddling = await theirs.request.post(`${workspaceUrl}?/role`, {
		headers: { origin: baseURL },
		form: { userId: 'not-a-user', role: 'owner' }
	});
	expect(meddling.status()).toBe(403);

	// Removed, the colleague loses the project and the workspace immediately.
	await page.getByRole('button', { name: `Remove ${colleague.name}` }).click();
	await expect(page.getByText(colleague.email)).toHaveCount(0);
	expect((await theirs.request.get(`/api/projects/${projectId}/tree`)).status()).toBe(404);
	expect((await saveAs(theirs, 'After removal.')).status()).toBe(404);
	expect((await pushAs(theirs)).status()).toBe(404);
	await theirs.goto('/');
	await expect(theirs.getByRole('link', { name: /Group report/ })).toHaveCount(0);
});

test('a workspace is deleted only when it is empty', async ({ page }) => {
	await page.goto(workspaceUrl);
	await expect(page.getByRole('button', { name: 'Delete this workspace' })).toBeDisabled();

	// A link that was made but never used can be withdrawn.
	await page.getByRole('button', { name: 'Create a link' }).click();
	const unused = await shownLink(page);
	await page.reload();
	await page.getByRole('button', { name: 'Withdraw' }).click();
	await expect(page.getByRole('button', { name: 'Withdraw' })).toHaveCount(0);
	await theirs.goto(unused);
	await expect(theirs.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();

	// The project goes back to the owner's own workspace; then the shared one can go.
	await page.goto(`/projects/${projectId}/settings`);
	await page.getByLabel('Move to').selectOption({ label: 'Your projects (only you)' });
	await page.getByRole('button', { name: 'Move project' }).click();
	await expect(page.getByRole('status').filter({ hasText: 'Moved' })).toBeVisible();

	await page.goto(workspaceUrl);
	await page.getByRole('button', { name: 'Delete this workspace' }).click();
	await expect(page).toHaveURL('/workspaces');
	await expect(page.getByText(workspaceName)).toHaveCount(0);
	await theirs.context().close();
});
