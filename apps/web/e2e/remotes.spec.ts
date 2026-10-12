import { expect, type Page } from '@playwright/test';
import {
	baseURL,
	externalBaseURL,
	forgeOrigin,
	forgeReadOnlyToken,
	forgeToken
} from './environment.ts';
import { appendSource, createProject, panel, saveState, test } from './helpers.ts';

/**
 * Pushing checkpoints to a Git repository, against a stand-in forge that is
 * real Git behind access tokens. A deployment under test has no forge it may
 * talk to, which is the default; there the page has to say so.
 */

const settingsOf = (projectId: string) => `/projects/${projectId}/settings?section=git`;
const repositorySection = (page: Page) =>
	page.locator('section', { has: page.getByRole('heading', { name: 'Git repository' }) });

/** A repository on the forge with a name no other test uses. */
async function newRepository(kind: 'empty' | 'busy'): Promise<{ name: string; url: string }> {
	const name = `ada/${kind}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const response = await fetch(
		`${forgeOrigin}/__forge/new/${name}${kind === 'busy' ? '?busy' : ''}`,
		{ method: 'POST' }
	);
	return { name, url: (await response.json()) as string };
}

const onForge = async (what: 'log' | 'files', name: string, branch = 'main') =>
	(await (await fetch(`${forgeOrigin}/__forge/${what}/${name}/${branch}`)).json()) as string[];

async function connect(page: Page, projectId: string, url: string, token: string, branch = '') {
	await page.goto(settingsOf(projectId));
	const section = repositorySection(page);
	// A project has one repository: to name another, the present one is disconnected first.
	const address = section.getByLabel('Address of the repository');
	const disconnect = section.getByRole('button', { name: 'Disconnect' });
	await expect(address.or(disconnect)).toBeVisible();
	if (await disconnect.isVisible()) await disconnect.click();
	await address.fill(url);
	await section.getByLabel('Branch').fill(branch);
	await section.getByLabel('Access token').fill(token);
	await section.getByRole('button', { name: 'Connect' }).click();
	return section;
}

/** Someone else's change to a file of the repository, made on the forge. */
async function changeOnForge(
	name: string,
	file: string,
	content: string,
	options: { message?: string; symlink?: string } = {}
) {
	const query = new URLSearchParams();
	if (options.message) query.set('message', options.message);
	if (options.symlink) query.set('symlink', options.symlink);
	const response = await fetch(`${forgeOrigin}/__forge/commit/${name}/main/${file}?${query}`, {
		method: 'POST',
		body: content
	});
	expect(response.status).toBe(201);
}

const forgeText = async (name: string, file: string) =>
	await (await fetch(`${forgeOrigin}/__forge/text/${name}/main/${file}`)).text();

const historyOf = async (page: Page, projectId: string) => {
	await page.goto(`/projects/${projectId}`);
	await page.getByRole('button', { name: 'History', exact: true }).click();
	return panel(page, 'History').getByRole('region', { name: 'Git repository' });
};

test('a server that names no hosts says so and offers nothing to fill in', async ({ page }) => {
	test.skip(!externalBaseURL, 'the server started for the tests does name a host');
	const projectId = await createProject(page, 'Blank document', 'No forge here');
	await page.goto(settingsOf(projectId));
	const section = repositorySection(page);
	await expect(section).toContainText('This server is not set up for that');
	await expect(section.getByRole('textbox')).toHaveCount(0);

	await page.goto(`/projects/${projectId}`);
	await page.getByRole('button', { name: 'History', exact: true }).click();
	await expect(panel(page, 'History').getByText('Created from the')).toBeVisible();
	await expect(panel(page, 'History').getByRole('button', { name: /^Push/ })).toHaveCount(0);
});

test('a project is connected to a repository and its checkpoints are pushed', async ({ page }) => {
	test.skip(!!externalBaseURL, 'a deployment under test has no forge it may talk to');
	const projectId = await createProject(page, 'Article', 'Pushed thesis');
	const repository = await newRepository('empty');

	// Values that cannot work are refused before anything is stored, and say why.
	let section = await connect(
		page,
		projectId,
		'https://elsewhere.example.org/ada/x.git',
		forgeToken
	);
	await expect(section.getByRole('alert')).toContainText(
		'not set up to connect to elsewhere.example.org'
	);
	// What was typed is still there to be corrected.
	await expect(section.getByLabel('Address of the repository')).toHaveValue(/elsewhere/);

	section = await connect(page, projectId, repository.url, 'not-a-token-of-this-forge');
	await expect(section.getByRole('alert')).toContainText('did not accept the token');
	section = await connect(page, projectId, `${forgeOrigin}/ada/does-not-exist.git`, forgeToken);
	await expect(section.getByRole('alert')).toContainText('no repository at that address');

	// With an address and a token that work, it is connected. The token is nowhere on the page.
	section = await connect(page, projectId, repository.url, forgeToken);
	await expect(section).toContainText(repository.url);
	await expect(section).toContainText('Nothing has been pushed yet');
	expect(await page.content()).not.toContain(forgeToken);

	// The history panel knows what the repository does not have yet, and pushes it.
	await page.goto(`/projects/${projectId}`);
	await page.getByRole('button', { name: 'History', exact: true }).click();
	const history = panel(page, 'History');
	const remote = history.getByRole('region', { name: 'Git repository' });
	await expect(remote).toContainText('1 checkpoint is not pushed yet');
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote).toContainText('Pushed.');
	expect(await onForge('log', repository.name)).toEqual(['Created from the “Article” template']);
	expect(await onForge('files', repository.name)).toContain('main.typ');
	await expect(remote.getByRole('button', { name: /^Push/ })).toHaveCount(0);

	// A later checkpoint is the only thing the next push sends.
	await appendSource(page, '\nA paragraph for the second checkpoint.');
	await expect(saveState(page)).toContainText('Saved');
	await history.getByRole('button', { name: 'Create checkpoint' }).click();
	await page.getByLabel('Description').fill('Second draft');
	await page.getByRole('dialog').getByRole('button', { name: 'Create checkpoint' }).click();
	await expect(remote).toContainText('1 checkpoint is not pushed yet');
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote).toContainText('Pushed.');
	expect(await onForge('log', repository.name)).toEqual([
		'Second draft',
		'Created from the “Article” template'
	]);

	// Disconnecting forgets the token; the repository keeps what it has.
	await page.goto(settingsOf(projectId));
	await repositorySection(page).getByRole('button', { name: 'Disconnect' }).click();
	await expect(repositorySection(page).getByLabel('Access token')).toBeVisible();
	const pushing = await page.request.post(`/api/projects/${projectId}/history/push`, {
		headers: { origin: baseURL, 'content-type': 'application/json' },
		data: {}
	});
	expect(pushing.status()).toBe(409);
	expect(await onForge('log', repository.name)).toHaveLength(2);

	// Who connected, pushed and disconnected is on record.
	await page.goto('/admin/activity');
	for (const entry of [
		'Connected the project to a Git repository',
		'Pushed the checkpoints of the project',
		'Disconnected the project from its Git repository'
	]) {
		await expect(page.getByText(entry).first()).toBeVisible();
	}
});

test('a push never overwrites a repository, and a refusal is explained', async ({ page }) => {
	test.skip(!!externalBaseURL, 'a deployment under test has no forge it may talk to');
	const projectId = await createProject(page, 'Blank document', 'Late to the repository');

	// A repository that already holds someone else's commits.
	const busy = await newRepository('busy');
	await connect(page, projectId, busy.url, forgeToken);
	await page.goto(`/projects/${projectId}`);
	await page.getByRole('button', { name: 'History', exact: true }).click();
	let remote = panel(page, 'History').getByRole('region', { name: 'Git repository' });
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote.getByRole('alert')).toContainText(
		'contains commits this project does not have'
	);
	expect(await onForge('log', busy.name)).toEqual(['Edit README.md elsewhere']);
	// Still to be pushed, and the button is still there to try again.
	await expect(remote.getByRole('button', { name: 'Push to main' })).toBeEnabled();

	// Another branch of the same repository takes it.
	await connect(page, projectId, busy.url, forgeToken, 'kernic/drafts');
	await page.goto(`/projects/${projectId}`);
	await page.getByRole('button', { name: 'History', exact: true }).click();
	remote = panel(page, 'History').getByRole('region', { name: 'Git repository' });
	await remote.getByRole('button', { name: 'Push to kernic/drafts' }).click();
	await expect(remote).toContainText('Pushed.');
	expect(await onForge('log', busy.name, 'kernic/drafts')).toHaveLength(1);
	expect(await onForge('log', busy.name)).toEqual(['Edit README.md elsewhere']);

	// A token that may only read connects, and is told so when it tries to write.
	const empty = await newRepository('empty');
	await connect(page, projectId, empty.url, forgeReadOnlyToken);
	await page.goto(`/projects/${projectId}`);
	await page.getByRole('button', { name: 'History', exact: true }).click();
	remote = panel(page, 'History').getByRole('region', { name: 'Git repository' });
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote.getByRole('alert')).toContainText('refused the push');
	expect(await onForge('log', empty.name)).toEqual([]);
});

test('a repository that has commits of its own is pulled, then pushed to', async ({ page }) => {
	test.skip(!!externalBaseURL, 'a deployment under test has no forge it may talk to');
	const projectId = await createProject(page, 'Blank document', 'Joined to a busy repository');
	const busy = await newRepository('busy');
	await connect(page, projectId, busy.url, forgeToken);

	// Pushing is refused, and says what to do about it.
	let remote = await historyOf(page, projectId);
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote.getByRole('alert')).toContainText('Pull them first');

	// Pulling merges the two histories: the forge's file arrives next to the project's.
	await remote.getByRole('button', { name: 'Pull' }).click();
	await expect(remote.getByRole('status').last()).toContainText('Took over 1 changed file.');
	await page.getByRole('button', { name: 'Files', exact: true }).click();
	await expect(
		panel(page, 'Files').getByRole('button', { name: 'README.md', exact: true })
	).toBeVisible();
	await expect(panel(page, 'Files').getByRole('button', { name: /^main\.typ/ })).toBeVisible();

	// Now the push is a plain fast-forward, and a second pull has nothing to bring.
	await page.getByRole('button', { name: 'History', exact: true }).click();
	remote = panel(page, 'History').getByRole('region', { name: 'Git repository' });
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote).toContainText('Pushed.');
	expect(await onForge('files', busy.name)).toEqual(['README.md', 'main.typ']);
	await remote.getByRole('button', { name: 'Pull' }).click();
	await expect(remote).toContainText('The repository has nothing new.');
});

test('a file changed in both places is settled by choosing, nothing is applied before', async ({
	page
}) => {
	test.skip(!!externalBaseURL, 'a deployment under test has no forge it may talk to');
	const projectId = await createProject(page, 'Blank document', 'Changed in two places');
	const repository = await newRepository('empty');
	await connect(page, projectId, repository.url, forgeToken);
	const remote = await historyOf(page, projectId);
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote).toContainText('Pushed.');

	// Someone changes main.typ on the forge while it is being edited here.
	await changeOnForge(repository.name, 'main.typ', 'Written on the forge.\n');
	await appendSource(page, '\nWritten in the editor.');
	await expect(saveState(page)).toContainText('Saved');

	await remote.getByRole('button', { name: 'Pull' }).click();
	const dialog = page.getByRole('dialog', { name: /changed in both places/ });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText('main.typ')).toBeVisible();
	// A choice is asked for, not assumed; until it is made nothing can be taken over.
	await expect(dialog.getByRole('button', { name: 'Take over the changes' })).toBeDisabled();
	await expect(page.locator('.cm-content')).toContainText('Written in the editor.');
	await expect(page.locator('.cm-content')).not.toContainText('<<<<<<<');

	// Keeping the project's version leaves its text, and the push then replaces the forge's.
	await dialog.getByLabel('Keep mine').check();
	await dialog.getByRole('button', { name: 'Take over the changes' }).click();
	await expect(dialog).toBeHidden();
	await expect(page.locator('.cm-content')).toContainText('Written in the editor.');
	await expect(page.locator('.cm-content')).not.toContainText('Written on the forge.');
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote).toContainText('Pushed.');
	expect(await forgeText(repository.name, 'main.typ')).toContain('Written in the editor.');

	// Again, and this time the repository's version is taken; the editor shows it at once.
	await changeOnForge(repository.name, 'main.typ', 'Rewritten on the forge.\n');
	await appendSource(page, '\nAnd edited here again.');
	await expect(saveState(page)).toContainText('Saved');
	await remote.getByRole('button', { name: 'Pull' }).click();
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Take the repository’s').check();
	await dialog.getByRole('button', { name: 'Take over the changes' }).click();
	await expect(page.locator('.cm-content')).toContainText('Rewritten on the forge.');
	await expect(page.locator('.cm-content')).not.toContainText('And edited here again.');
	// What was written here is not lost: it is in the checkpoint made before the pull.
	await expect(
		panel(page, 'History')
			.getByText(/^Before pulling from/)
			.first()
	).toBeVisible();
});

test('what a repository must not bring in is refused, and nothing changes', async ({ page }) => {
	test.skip(!!externalBaseURL, 'a deployment under test has no forge it may talk to');
	const projectId = await createProject(page, 'Blank document', 'Hostile repository');
	const repository = await newRepository('empty');
	await connect(page, projectId, repository.url, forgeToken);
	const remote = await historyOf(page, projectId);
	await remote.getByRole('button', { name: 'Push to main' }).click();
	await expect(remote).toContainText('Pushed.');

	await changeOnForge(repository.name, 'passwd.typ', '', { symlink: '/etc/passwd' });
	await remote.getByRole('button', { name: 'Pull' }).click();
	await expect(remote.getByRole('alert')).toContainText('passwd.typ');
	await expect(remote.getByRole('alert')).toContainText('a link');
	await page.getByRole('button', { name: 'Files', exact: true }).click();
	await expect(panel(page, 'Files').getByRole('button', { name: /^main\.typ/ })).toBeVisible();
	await expect(panel(page, 'Files').getByText('passwd.typ')).toHaveCount(0);
});
