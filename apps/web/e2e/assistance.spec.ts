import { expect } from '@playwright/test';
import { externalBaseURL, workerPort } from './environment.ts';
import { appendSource, createProject, editorText, previewStatus, test } from './helpers.ts';

/**
 * Editor assistance from the language server. It is optional equipment of a
 * server, so these tests are skipped where the worker does not offer it.
 */

let offered = true;
test.beforeAll(async () => {
	// Against an external deployment the worker is not reachable; assume it is equipped.
	if (externalBaseURL) return;
	const health = await fetch(`http://127.0.0.1:${workerPort}/healthz`).then(
		(response) => response.json() as Promise<{ editorAssistance?: boolean }>,
		() => ({ editorAssistance: false })
	);
	offered = health.editorAssistance === true;
});

test('functions of the project are completed, documented and found', async ({ page }) => {
	test.skip(!offered, 'the worker has no language server installed');
	await createProject(page, 'Report', 'Assisted');
	await expect(previewStatus(page)).toContainText('Up to date');

	// Completion knows the function defined in another file, with its parameters.
	await appendSource(page, '\n#rep');
	const completions = page.locator('.cm-tooltip-autocomplete');
	const suggestion = completions.getByRole('option').filter({ hasText: /^report\b.*subtitle/ });
	await expect(suggestion).toBeVisible();
	await suggestion.click();
	await expect.poll(() => editorText(page)).toMatch(/#report\b/);
	for (let index = 0; index < '#report'.length; index++) await page.keyboard.press('Backspace');

	// Hovering a use of it shows its documentation.
	const use = page.locator('.cm-line', { hasText: '#show: report.with(' });
	const box = (await use.boundingBox())!;
	await page.mouse.move(box.x + 95, box.y + box.height / 2);
	const hover = page.locator('.cm-tooltip .cm-lsp-documentation');
	await expect(hover).toContainText('Named Parameters');

	// F12 on it opens the file that defines it, at the definition.
	await page.mouse.click(box.x + 95, box.y + box.height / 2);
	await page.keyboard.press('F12');
	await expect(page).toHaveURL(/file=template\.typ/);
	await expect(page.locator('.cm-activeLine')).toContainText('#let report(');
});

test('labels of the whole document are offered in a chapter', async ({ page }) => {
	test.skip(!offered, 'the worker has no language server installed');
	await createProject(page, 'Report', 'Labels');
	await expect(previewStatus(page)).toContainText('Up to date');

	// A label in the main file …
	await appendSource(page, '\n= Outlook <outlook>\n');
	await expect(previewStatus(page)).toContainText('Up to date');

	// … is known while writing in a chapter.
	await page.getByRole('button', { name: 'introduction.typ', exact: true }).click();
	await expect(page).toHaveURL(/file=chapters%2Fintroduction\.typ/);
	// Typed at a human pace: suggestions follow the keystrokes.
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+End');
	await page.keyboard.type('\nSee @outl', { delay: 80 });
	await expect(
		page.locator('.cm-tooltip-autocomplete').getByRole('option').filter({ hasText: 'outlook' })
	).toBeVisible();
});

test('documentation cannot bring markup of its own into the page', async ({ page }) => {
	test.skip(!offered, 'the worker has no language server installed');
	await createProject(page, 'Blank document', 'Hostile docs');
	await expect(previewStatus(page)).toContainText('Up to date');

	await appendSource(
		page,
		'\n/// <img src="x" onerror="window.planted = 1"> <b>Bold</b> <script>window.planted = 2</script>\n' +
			'#let danger(value) = value\n\n#danger(1)\n'
	);
	await expect(previewStatus(page)).toContainText('Up to date');

	const use = page.locator('.cm-line', { hasText: '#danger(1)' });
	const box = (await use.boundingBox())!;
	await page.mouse.move(box.x + 30, box.y + box.height / 2);
	const hover = page.locator('.cm-tooltip .cm-lsp-documentation');
	await expect(hover).toContainText('danger');
	await expect(hover.locator('img, script')).toHaveCount(0);
	expect(await page.evaluate(() => (window as { planted?: number }).planted)).toBeUndefined();
});
