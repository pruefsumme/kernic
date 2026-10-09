import { expect, type APIRequestContext, type Browser } from '@playwright/test';
import postgres from 'postgres';
import yazl from 'yazl';
import { hashPassword } from '../src/lib/server/auth/passwords.ts';
import { baseURL, databaseUrl, externalBaseURL } from './environment.ts';
import { appendSource, createProject, pages, panel, saveState, test } from './helpers.ts';

// A second account is created directly in the test database; there is no
// user management in the interface yet.
test.skip(!!externalBaseURL, 'needs direct access to the test database');

const outsider = {
	name: 'Mallory Outsider',
	email: 'mallory@example.org',
	password: 'a different passphrase'
};

async function ensureOutsider(): Promise<void> {
	const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	try {
		const [existing] = await sql`SELECT 1 FROM users WHERE email = ${outsider.email}`;
		if (existing) return;
		const [user] = await sql<{ id: string }[]>`
			INSERT INTO users (email, display_name, password_hash)
			VALUES (${outsider.email}, ${outsider.name}, ${await hashPassword(outsider.password)})
			RETURNING id
		`;
		const [workspace] = await sql<{ id: string }[]>`
			INSERT INTO workspaces (name, kind) VALUES ('Personal', 'personal') RETURNING id
		`;
		await sql`
			INSERT INTO workspace_members (workspace_id, user_id, role)
			VALUES (${workspace!.id}, ${user!.id}, 'owner')
		`;
	} finally {
		await sql.end();
	}
}

/** A browser context signed in as the second user. */
async function signInAsOutsider(browser: Browser) {
	await ensureOutsider();
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByLabel('Email').fill(outsider.email);
	await page.getByLabel('Password').fill(outsider.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');
	return { context, page };
}

function zipOf(entries: Record<string, string>): Promise<Buffer> {
	const zip = new yazl.ZipFile();
	for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
	zip.end();
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
		zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

test('another user can neither see nor change a project, through any route', async ({
	page,
	browser
}) => {
	// The owner sets up a project with a rendered page, a checkpoint and a pending import.
	const projectId = await createProject(page, 'Blank document', 'Private thesis');
	await expect(pages(page)).toHaveCount(1);
	await appendSource(page, '\nConfidential paragraph.');
	await expect(saveState(page)).toContainText('Saved');
	await page.getByRole('button', { name: 'History', exact: true }).click();
	await expect(panel(page, 'History').getByText('1 file changed')).toBeVisible();

	const api = `/api/projects/${projectId}`;
	const owner = page.request;
	const history = await (await owner.get(`${api}/history`)).json();
	const checkpointId: string = history.checkpoints[0].id;
	const jobId = new URL((await pages(page).first().getAttribute('src'))!, baseURL).pathname.split(
		'/'
	)[5]!;
	const [{ workspace_id: ownerWorkspace }] = await (async () => {
		const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
		try {
			return await sql<{ workspace_id: string }[]>`
				SELECT workspace_id FROM projects WHERE id = ${projectId}
			`;
		} finally {
			await sql.end();
		}
	})();
	const upload = await owner.post(`/api/imports?workspace=${ownerWorkspace}&name=secret.zip`, {
		data: await zipOf({ 'main.typ': 'Secret import\n' }),
		headers: { origin: baseURL, 'content-type': 'application/zip' }
	});
	const importId: string = (await upload.json()).id;
	const before = await (await owner.get(`${api}/files/main.typ`)).text();

	// The ids are real: the owner reaches each of these.
	for (const url of [
		`${api}/jobs/${jobId}`,
		`${api}/jobs/${jobId}/pages/1`,
		`${api}/history/${checkpointId}/diff`,
		`${api}/history/${checkpointId}/archive`,
		`/api/imports/${importId}`
	]) {
		expect((await owner.get(url)).status(), `owner: ${url}`).toBe(200);
	}

	const { context, page: theirs } = await signInAsOutsider(browser);
	const outsiderRequest: APIRequestContext = context.request;
	const write = { headers: { origin: baseURL, 'content-type': 'application/json' } };

	// Their own dashboard does not mention the project.
	await expect(theirs.getByText('Private thesis')).toHaveCount(0);

	const attempts: [string, () => Promise<{ status(): number }>][] = [
		['list files', () => outsiderRequest.get(`${api}/tree`)],
		['read file', () => outsiderRequest.get(`${api}/files/main.typ`)],
		[
			'write file',
			() =>
				outsiderRequest.put(`${api}/files/main.typ`, {
					data: 'owned',
					headers: { origin: baseURL, 'content-type': 'text/plain' }
				})
		],
		[
			'delete file',
			() => outsiderRequest.delete(`${api}/files/main.typ`, { headers: { origin: baseURL } })
		],
		[
			'create file',
			() =>
				outsiderRequest.post(`${api}/entries`, { data: { type: 'file', path: 'x.typ' }, ...write })
		],
		[
			'move file',
			() =>
				outsiderRequest.post(`${api}/move`, { data: { from: 'main.typ', to: 'y.typ' }, ...write })
		],
		[
			'upload',
			() =>
				outsiderRequest.post(`${api}/upload`, {
					multipart: {
						directory: '',
						files: { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') }
					},
					headers: { origin: baseURL }
				})
		],
		[
			'compile',
			() => outsiderRequest.post(`${api}/compile`, { data: { format: 'pdf' }, ...write })
		],
		['job status', () => outsiderRequest.get(`${api}/jobs/${jobId}`)],
		['rendered page', () => outsiderRequest.get(`${api}/jobs/${jobId}/pages/1`)],
		['exported pdf', () => outsiderRequest.get(`${api}/jobs/${jobId}/pdf`)],
		['zip of files', () => outsiderRequest.get(`${api}/archive`)],
		['history', () => outsiderRequest.get(`${api}/history`)],
		[
			'create checkpoint',
			() => outsiderRequest.post(`${api}/history`, { data: { message: 'x' }, ...write })
		],
		['checkpoint diff', () => outsiderRequest.get(`${api}/history/${checkpointId}/diff`)],
		['working diff', () => outsiderRequest.get(`${api}/history/working/diff`)],
		[
			'restore',
			() => outsiderRequest.post(`${api}/history/${checkpointId}/restore`, { data: {}, ...write })
		],
		['zip of checkpoint', () => outsiderRequest.get(`${api}/history/${checkpointId}/archive`)],
		['import status', () => outsiderRequest.get(`/api/imports/${importId}`)],
		['import preview', () => outsiderRequest.get(`/api/imports/${importId}/preview`)],
		['editor page', () => outsiderRequest.get(`/projects/${projectId}`)],
		['settings page', () => outsiderRequest.get(`/projects/${projectId}/settings`)],
		['import page', () => outsiderRequest.get(`/import/${importId}`)]
	];
	for (const [name, attempt] of attempts) {
		expect((await attempt()).status(), name).toBe(404);
	}

	// Form actions: rename, delete, confirm someone else's import.
	const form = { headers: { origin: baseURL, accept: 'application/json' } };
	const rename = await outsiderRequest.post(`/projects/${projectId}/settings?/rename`, {
		form: { name: 'Stolen' },
		...form
	});
	const remove = await outsiderRequest.post(`/projects/${projectId}/settings?/delete`, {
		form: { confirm: 'Private thesis' },
		...form
	});
	const confirm = await outsiderRequest.post(`/import/${importId}?/confirm`, {
		form: { name: 'Mine now', entryPath: 'main.typ' },
		...form
	});
	for (const [name, response] of [
		['rename', rename],
		['delete', remove],
		['confirm import', confirm]
	] as const) {
		const body = await response.text();
		expect(body, name).toMatch(/"status":40[49]|"type":"error"/);
		expect(body, name).not.toContain('"type":"success"');
		expect(body, name).not.toContain('"type":"redirect"');
	}

	// They cannot create things inside the owner's workspace either.
	const create = await outsiderRequest.post('/?/create', {
		form: { name: 'Intruder', template: 'blank', workspace: ownerWorkspace },
		...form
	});
	expect(await create.text()).toContain('You cannot create projects in that workspace');
	const foreignImport = await outsiderRequest.post(
		`/api/imports?workspace=${ownerWorkspace}&name=x.zip`,
		{
			data: await zipOf({ 'main.typ': 'x' }),
			headers: { origin: baseURL, 'content-type': 'application/zip' }
		}
	);
	expect(foreignImport.status()).toBe(403);

	// Nothing of the owner's changed.
	expect(await (await owner.get(`${api}/files/main.typ`)).text()).toBe(before);
	expect((await (await owner.get(`${api}/history`)).json()).checkpoints).toHaveLength(
		history.checkpoints.length
	);
	await page.goto('/');
	await expect(page.getByText('Private thesis')).toBeVisible();
	await expect(page.getByText('Intruder')).toHaveCount(0);
	await context.close();
});

test('a disabled account is signed out everywhere and cannot sign in', async ({ browser }) => {
	const { context, page } = await signInAsOutsider(browser);
	await expect(page.getByRole('button', { name: /Empty document/ })).toBeVisible();

	const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
	try {
		await sql`UPDATE users SET disabled_at = now() WHERE email = ${outsider.email}`;
		await page.goto('/');
		await expect(page).toHaveURL(/\/login/);

		await page.getByLabel('Email').fill(outsider.email);
		await page.getByLabel('Password').fill(outsider.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		await expect(page.getByRole('alert')).toContainText('Email or password is not correct');
	} finally {
		await sql`UPDATE users SET disabled_at = NULL WHERE email = ${outsider.email}`;
		await sql.end();
		await context.close();
	}
});
