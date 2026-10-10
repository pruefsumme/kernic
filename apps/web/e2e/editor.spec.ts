import { expect } from '@playwright/test';
import {
	appendSource,
	createProject,
	editorText,
	expectNoSidewaysScroll,
	loadedPages,
	pages,
	panel,
	previewStatus,
	saveState,
	test
} from './helpers.ts';

test('a new project opens its main file and renders the template', async ({ page }) => {
	await createProject(page, 'Report', 'Renders');

	await expect(page).toHaveURL(/file=main\.typ/);
	await expect(previewStatus(page)).toContainText('Up to date');
	await expect(pages(page)).toHaveCount(4);
	await expect(page.getByRole('button', { name: 'Files', exact: true })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
});

test('typing saves automatically and updates the preview and the outline', async ({ page }) => {
	await createProject(page, 'Report', 'Autosave');
	await expect(pages(page)).toHaveCount(4);

	await appendSource(page, '\n= Added chapter\nMore text.\n');
	await expect(saveState(page)).toContainText('Unsaved changes');
	await expect(saveState(page)).toContainText('Saved');
	await expect(pages(page)).toHaveCount(5);
	await expect(previewStatus(page)).toContainText('Up to date');

	await page.getByRole('button', { name: 'Outline' }).click();
	await expect(panel(page, 'Outline').getByRole('button', { name: 'Added chapter' })).toBeVisible();

	// The text is on the server, not only in this tab.
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Added chapter');
});

test('edits typed just before leaving the editor are not lost', async ({ page }) => {
	const id = await createProject(page, 'Blank document', 'Leave quickly');

	await appendSource(page, '\nLast words before leaving.');
	// Navigate within the autosave delay.
	await page.getByRole('link', { name: 'Settings' }).click();
	await expect(page).toHaveURL(/\/settings$/);

	await page.goto(`/projects/${id}`);
	await expect(page.locator('.cm-content')).toContainText('Last words before leaving.');
});

test('a compile error is reported, located and cleared when fixed', async ({ page }) => {
	await createProject(page, 'Blank document', 'Errors');
	await expect(previewStatus(page)).toContainText('Up to date');

	await appendSource(page, '\n#let broken = 1 +');
	await expect(previewStatus(page)).toContainText('1 error');
	await expect(previewStatus(page)).toContainText('last version that compiled');
	// The longer status text must not push the layout wider than the window.
	await expectNoSidewaysScroll(page);
	// The last good page stays on screen.
	await expect(pages(page)).toHaveCount(1);
	await expect(page.locator('.cm-lintRange-error')).toBeVisible();

	await page.getByRole('button', { name: /^Issues/ }).click();
	const issue = panel(page, 'Issues').getByRole('button', { name: /expected expression/ });
	await expect(issue).toContainText('main.typ, line 5');
	await issue.click();

	await appendSource(page, ' 2');
	await expect(previewStatus(page)).toContainText('Up to date');
	await expect(panel(page, 'Issues')).toContainText('No errors or warnings');
});

test('a file changed elsewhere is not overwritten without asking', async ({ page }) => {
	const id = await createProject(page, 'Blank document', 'Conflict');
	await expect(saveState(page)).toContainText('Saved');
	const fileUrl = `/api/projects/${id}/files/main.typ`;
	const origin = new URL(page.url()).origin;
	const writeElsewhere = (text: string) =>
		page.request.put(fileUrl, { data: text, headers: { origin, 'content-type': 'text/plain' } });

	// Someone else replaces the file, then this tab keeps typing.
	expect((await writeElsewhere('= Written elsewhere\n')).ok()).toBe(true);
	await appendSource(page, '\nMy local edit.');

	const banner = page.getByRole('alert').filter({ hasText: 'was changed somewhere else' });
	await expect(banner).toBeVisible();
	await expect(saveState(page)).toContainText('Conflict');
	expect(await (await page.request.get(fileUrl)).text()).toBe('= Written elsewhere\n');

	// Keeping the local version is an explicit choice.
	await banner.getByRole('button', { name: 'Keep mine, overwrite' }).click();
	await expect(saveState(page)).toContainText('Saved');
	expect(await (await page.request.get(fileUrl)).text()).toContain('My local edit.');

	// The other choice: take the server's version.
	expect((await writeElsewhere('= Second remote version\n')).ok()).toBe(true);
	await appendSource(page, '\nAnother local edit.');
	await expect(banner).toBeVisible();
	await banner.getByRole('button', { name: 'Discard mine, load theirs' }).click();
	await expect(page.locator('.cm-content')).toContainText('Second remote version');
	expect(await editorText(page)).not.toContain('Another local edit.');
	await expect(saveState(page)).toContainText('Saved');
});

test('files can be created, renamed and deleted without overwriting', async ({ page }) => {
	await createProject(page, 'Report', 'File operations');
	const files = panel(page, 'Files');

	await files.getByRole('button', { name: 'File', exact: true }).click();
	await page.getByLabel('File name').fill('notes.typ');
	await page.getByRole('button', { name: 'Create file' }).click();
	await expect(page).toHaveURL(/file=notes\.typ/);
	await expect(files.getByRole('button', { name: 'notes.typ', exact: true })).toBeVisible();

	// A second file with the same name is refused.
	await files.getByRole('button', { name: 'File', exact: true }).click();
	await page.getByLabel('File name').fill('notes.typ');
	await page.getByRole('button', { name: 'Create file' }).click();
	await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
	await page.getByRole('button', { name: 'Cancel' }).click();

	// Paths that would leave the project are refused.
	await files.getByRole('button', { name: 'File', exact: true }).click();
	await page.getByLabel('File name').fill('../outside.typ');
	await page.getByRole('button', { name: 'Create file' }).click();
	await expect(page.getByRole('dialog').getByRole('alert')).toContainText('".."');
	await page.getByRole('button', { name: 'Cancel' }).click();

	await files.getByRole('button', { name: 'Actions for notes.typ' }).click();
	await page.getByRole('menuitem', { name: 'Rename or move' }).click();
	await page.getByLabel('Path').fill('chapters/notes.typ');
	await page.getByRole('button', { name: 'Rename', exact: true }).click();
	await expect(page).toHaveURL(/file=chapters%2Fnotes\.typ/);

	await files.getByRole('button', { name: 'Actions for notes.typ' }).click();
	await page.getByRole('menuitem', { name: 'Delete' }).click();
	await page.getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(page).toHaveURL(/file=main\.typ/);
	await expect(files.getByRole('button', { name: 'notes.typ', exact: true })).toHaveCount(0);
});

test('uploads are stored, shown, and never replace an existing file', async ({ page }) => {
	await createProject(page, 'Blank document', 'Uploads');
	const files = panel(page, 'Files');
	const pixel = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
		'base64'
	);
	const upload = (name: string, buffer: Buffer) =>
		page.locator('input[type=file]').setInputFiles({ name, mimeType: 'image/png', buffer });

	await upload('dot.png', pixel);
	await expect(files.getByRole('status')).toContainText('1 file uploaded.');
	await files.getByRole('button', { name: 'dot.png', exact: true }).click();
	await expect(page.locator('.asset img')).toBeVisible();

	await upload('dot.png', pixel);
	await expect(files.getByRole('status')).toContainText('was not uploaded');

	// Larger than the Node adapter's default request limit of 512 KB.
	await upload('large.png', Buffer.concat([pixel, Buffer.alloc(2 * 1024 * 1024)]));
	await expect(files.getByRole('status')).toContainText('1 file uploaded.');
});

test('files dropped on the editor are added, and images land in the source', async ({ page }) => {
	await createProject(page, 'Blank document', 'Drop zone');
	const files = panel(page, 'Files');
	await expect(previewStatus(page)).toContainText('Up to date');

	/** Drops or pastes a small file the way a browser reports it. */
	const deliver = (how: 'drop' | 'paste', selector: string, name: string, type: string) =>
		page.evaluate(
			({ how, selector, name, type }) => {
				const png = Uint8Array.from(
					atob(
						'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
					),
					(character) => character.charCodeAt(0)
				);
				const transfer = new DataTransfer();
				transfer.items.add(new File([type === 'image/png' ? png : 'plain text'], name, { type }));
				const target = document.querySelector(selector)!;
				const options = { bubbles: true, cancelable: true };
				if (how === 'paste') {
					target.dispatchEvent(
						new ClipboardEvent('paste', { ...options, clipboardData: transfer })
					);
					return;
				}
				for (const kind of ['dragenter', 'dragover', 'drop']) {
					target.dispatchEvent(new DragEvent(kind, { ...options, dataTransfer: transfer }));
				}
			},
			{ how, selector, name, type }
		);

	// While files hover over the editor, it says what dropping them will do.
	await page.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.items.add(new File(['x'], 'hover.txt'));
		document
			.querySelector('.cm-content')!
			.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }));
	});
	await expect(page.getByText('Drop to add to “Drop zone”')).toBeVisible();

	// An image dropped on the source is stored beside the file and inserted.
	await deliver('drop', '.cm-content', 'figure.png', 'image/png');
	await expect(page.getByText('Drop to add to “Drop zone”')).toHaveCount(0);
	await expect.poll(() => editorText(page)).toContain('#image("figure.png")');
	await expect(files.getByRole('button', { name: 'figure.png', exact: true })).toBeVisible();
	await expect(saveState(page)).toContainText('Saved');
	await expect(previewStatus(page)).toContainText('Up to date');

	// A pasted screenshot gets a name of its own.
	await deliver('paste', '.cm-content', 'image.png', 'image/png');
	await expect.poll(() => editorText(page)).toMatch(/#image\("pasted-\d{8}-\d{6}\.png"\)/);

	// Other files, and anything dropped on the preview, go to the top folder and
	// are not written into the source.
	await deliver('drop', '.preview', 'data.csv', 'text/csv');
	await expect(files.getByRole('status')).toContainText('1 file uploaded.');
	await expect(files.getByRole('button', { name: 'data.csv', exact: true })).toBeVisible();
	expect(await editorText(page)).not.toContain('plain text');

	// The file list takes drops as well.
	await deliver('drop', '[aria-label="Files"] .tree', 'listed.csv', 'text/csv');
	await expect(files.getByRole('button', { name: 'listed.csv', exact: true })).toBeVisible();

	// Dropping a file again never replaces the one that is there.
	await deliver('drop', '.cm-content', 'figure.png', 'image/png');
	await expect(files.getByRole('status')).toContainText('was not uploaded');
	expect((await editorText(page)).match(/figure\.png/g)).toHaveLength(1);
});

test('export produces a PDF and a ZIP of the project', async ({ page }) => {
	await createProject(page, 'Article', 'Export me');
	await expect(previewStatus(page)).toContainText('Up to date');

	await page.getByRole('button', { name: 'Export' }).click();
	const [pdf] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('menuitem', { name: 'PDF' }).click()
	]);
	expect(pdf.suggestedFilename()).toBe('Export me.pdf');
	const pdfStream = await pdf.createReadStream();
	const pdfHead = await new Promise<Buffer>((resolve) => pdfStream.once('data', resolve));
	expect(pdfHead.subarray(0, 5).toString()).toBe('%PDF-');

	await page.getByRole('button', { name: 'Export' }).click();
	const [zip] = await Promise.all([
		page.waitForEvent('download'),
		page.getByRole('menuitem', { name: 'All files (ZIP)' }).click()
	]);
	const zipStream = await zip.createReadStream();
	const zipHead = await new Promise<Buffer>((resolve) => zipStream.once('data', resolve));
	expect(zipHead.subarray(0, 2).toString()).toBe('PK');
});

test('zoom changes the size of the rendered pages', async ({ page }) => {
	await createProject(page, 'Blank document', 'Zoom');
	await expect(pages(page)).toHaveCount(1);
	const width = () =>
		pages(page)
			.first()
			.evaluate((image) => image.clientWidth);

	const fitted = await width();
	await page.getByRole('button', { name: 'Zoom in' }).click();
	expect(await width()).toBeGreaterThan(fitted);
	await page.getByRole('button', { name: 'Fit width' }).click();
	expect(await width()).toBe(fitted);
});

test('on a phone the editor shows one pane at a time', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 800 });
	await createProject(page, 'Blank document', 'Phone');

	await expect(page.locator('.cm-content')).toBeVisible();
	await expect(pages(page).first()).toBeHidden();
	await page.getByRole('button', { name: 'Preview', exact: true }).click();
	await expect(pages(page).first()).toBeVisible();
	await expect(page.locator('.cm-content')).toBeHidden();

	await expectNoSidewaysScroll(page);
});

test('a failed save is visible, keeps the text, and retries when back online', async ({
	page,
	context
}) => {
	await createProject(page, 'Blank document', 'Offline');
	await expect(saveState(page)).toContainText('Saved');

	await context.setOffline(true);
	await appendSource(page, '\nWritten while offline.');
	await expect(saveState(page)).toContainText('Not saved');
	await expect(
		page.getByRole('alert').filter({ hasText: 'Your changes are not saved' })
	).toBeVisible();
	await expect(page.locator('.cm-content')).toContainText('Written while offline.');

	await context.setOffline(false);
	await expect(saveState(page)).toContainText('Saved');
	await page.reload();
	await expect(page.locator('.cm-content')).toContainText('Written while offline.');
});

test('when compiling is unavailable the preview says so and can be retried', async ({ page }) => {
	await createProject(page, 'Blank document', 'Compile outage');
	await expect(previewStatus(page)).toContainText('Up to date');

	await page.route('**/api/projects/*/compile', (route) =>
		route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({ message: 'The compile service is restarting.' })
		})
	);
	await appendSource(page, '\nMore text.');
	await expect(previewStatus(page)).toContainText('Preview unavailable');
	// The pages rendered before the outage stay visible.
	await expect(pages(page)).toHaveCount(1);

	await page.unroute('**/api/projects/*/compile');
	await previewStatus(page).getByRole('button', { name: 'Try again' }).click();
	await expect(previewStatus(page)).toContainText('Up to date');
});

test('the editor is usable from the keyboard', async ({ page }) => {
	await createProject(page, 'Blank document', 'Keyboard');

	// The skip link is the first stop and leads past the navigation.
	await page.keyboard.press('Tab');
	await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();

	// Escape closes the panel attached to the rail.
	const files = panel(page, 'Files');
	await files.getByRole('button', { name: 'File', exact: true }).focus();
	await page.keyboard.press('Escape');
	await expect(files).toBeHidden();

	// Formatting shortcuts edit the Typst markup.
	await appendSource(page, '\nbold');
	await page.keyboard.press('Shift+Home');
	await page.keyboard.press('ControlOrMeta+b');
	await expect(page.locator('.cm-content')).toContainText('*bold*');

	// Escape, then Tab, leaves the editor instead of trapping focus. (With text
	// selected, the first Escape only clears the selection.)
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Escape');
	await page.keyboard.press('Tab');
	await expect(page.locator('.cm-content')).not.toBeFocused();
});

test('a long document loads only the pages in view and re-fetches only what changed', async ({
	page
}) => {
	await createProject(page, 'Blank document', 'Long document');
	const pageRequests: string[] = [];
	page.on('request', (request) => {
		if (/\/pages\/[0-9a-f]{64}$/.test(request.url())) pageRequests.push(request.url());
	});

	// Forty pages, each with its own text, and a last page with the closing line.
	await page.locator('.cm-content').click();
	await page.keyboard.press('ControlOrMeta+a');
	await page.keyboard.type('#for i in range(40) [Page number #i #pagebreak(weak: true)]\nThe end.');
	await expect(pages(page)).toHaveCount(41);
	await expect(previewStatus(page)).toContainText('Up to date');

	// Every page has its place, but only those near the top were fetched.
	const loadedAtTop = await loadedPages(page).count();
	expect(loadedAtTop).toBeGreaterThan(0);
	expect(loadedAtTop).toBeLessThan(10);
	expect(pageRequests.length).toBeLessThan(10);

	// Changing the last page fetches nothing while the top of the document is in view.
	pageRequests.length = 0;
	await appendSource(page, ' With a postscript.');
	await expect(saveState(page)).toContainText('Saved');
	await expect(previewStatus(page)).toContainText('Up to date');
	expect(pageRequests).toEqual([]);

	// Scrolling to the end brings in the last page, with the new text's rendering.
	await pages(page).last().scrollIntoViewIfNeeded();
	await expect(pages(page).last().locator('img')).toBeVisible();
	expect(pageRequests.length).toBeGreaterThan(0);
	expect(pageRequests.length).toBeLessThan(10);
	await expectNoSidewaysScroll(page);
});
