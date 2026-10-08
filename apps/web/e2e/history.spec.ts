import { expect } from '@playwright/test';
import { appendSource, createProject, panel, previewStatus, saveState, test } from './helpers.ts';

test('checkpoints record versions, show what changed and can be restored', async ({ page }) => {
	await createProject(page, 'Blank document', 'Versions');
	await page.getByRole('button', { name: 'History', exact: true }).click();
	const history = panel(page, 'History');

	// A new project starts with a checkpoint of the template.
	await expect(history.getByText('Created from the “Blank document” template')).toBeVisible();
	await expect(history.getByText('No changes since the last checkpoint.')).toBeVisible();
	await expect(history.getByRole('button', { name: 'Create checkpoint' })).toBeDisabled();

	await appendSource(page, '\nA sentence for the first draft.');
	await expect(saveState(page)).toContainText('Saved');
	await expect(history.getByText('1 file changed since the last checkpoint')).toBeVisible();

	// Review the pending changes.
	await history.getByRole('button', { name: 'Review changes' }).click();
	const diff = page.getByRole('dialog', { name: 'Changes since the last checkpoint' });
	await expect(diff.getByText('A sentence for the first draft.')).toBeVisible();
	await expect(diff.locator('.line.added').filter({ hasText: 'A sentence' })).toHaveCount(1);
	await expect(diff.locator('.line.removed')).toHaveCount(0);
	await diff.getByRole('button', { name: 'Close' }).click();

	await history.getByRole('button', { name: 'Create checkpoint' }).click();
	await page.getByLabel('Description').fill('First draft');
	await page.getByRole('dialog').getByRole('button', { name: 'Create checkpoint' }).click();
	await expect(history.getByText('First draft', { exact: true })).toBeVisible();
	await expect(history.getByText('No changes since the last checkpoint.')).toBeVisible();

	// Keep writing, without making a checkpoint of it.
	await appendSource(page, '\nA later, uncheckpointed thought.');
	await expect(saveState(page)).toContainText('Saved');

	// Go back to the template version.
	await history
		.getByRole('button', {
			name: 'Actions for checkpoint “Created from the “Blank document” template”'
		})
		.click();
	await page.getByRole('menuitem', { name: 'Restore this version' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();

	await expect(page.locator('.cm-content')).not.toContainText('first draft');
	await expect(page.locator('.cm-content')).toContainText('Start writing here.');
	await expect(previewStatus(page)).toContainText('Up to date');

	// Nothing was lost: the uncheckpointed text was recorded before the restore.
	const entries = history.locator('.checkpoints .message');
	await expect(entries).toHaveText([
		'Restored “Created from the “Blank document” template”',
		'Before restoring an earlier checkpoint',
		'First draft',
		'Created from the “Blank document” template'
	]);

	await history
		.getByRole('button', {
			name: 'Actions for checkpoint “Before restoring an earlier checkpoint”'
		})
		.click();
	await page.getByRole('menuitem', { name: 'Restore this version' }).click();
	await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
	await expect(page.locator('.cm-content')).toContainText('A later, uncheckpointed thought.');
});

test('a checkpoint can be downloaded as a ZIP archive', async ({ page }) => {
	await createProject(page, 'Report', 'Archive of a version');
	await page.getByRole('button', { name: 'History', exact: true }).click();
	const history = panel(page, 'History');

	await history.getByRole('button', { name: /^Actions for checkpoint/ }).click();
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('menuitem', { name: 'Download as ZIP' }).click()
	]);
	expect(download.suggestedFilename()).toMatch(/^Archive of a version \([0-9a-f]{8}\)\.zip$/);
	const stream = await download.createReadStream();
	const head = await new Promise<Buffer>((resolve) => stream.once('data', resolve));
	expect(head.subarray(0, 2).toString()).toBe('PK');
});

test('history rejects checkpoint ids that are not checkpoints', async ({ page }) => {
	const id = await createProject(page, 'Blank document', 'Bad ids');
	const origin = new URL(page.url()).origin;

	for (const bad of ['HEAD', '0'.repeat(40), '--help', 'main~1']) {
		const diff = await page.request.get(
			`/api/projects/${id}/history/${encodeURIComponent(bad)}/diff`
		);
		expect(diff.status(), `diff ${bad}`).toBe(404);
		const restore = await page.request.post(
			`/api/projects/${id}/history/${encodeURIComponent(bad)}/restore`,
			{ data: {}, headers: { origin } }
		);
		expect(restore.status(), `restore ${bad}`).toBe(404);
	}
});
