import { expect, type Browser, type Page } from '@playwright/test';
import { test } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

const person = {
	email: `grace-${Date.now()}@example.org`,
	name: 'Grace Hopper',
	password: 'first passphrase here',
	newPassword: 'second passphrase here'
};

async function freshPage(browser: Browser): Promise<Page> {
	const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
	return context.newPage();
}

async function signIn(page: Page, password: string): Promise<void> {
	await page.goto('/login');
	await page.getByLabel('Email').fill(person.email);
	await page.getByLabel('Password').fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Creates a link on the People page and returns its address. */
async function linkFrom(page: Page, submit: () => Promise<void>): Promise<string> {
	await submit();
	const field = page.getByRole('textbox', { name: 'Link', exact: true });
	await expect(field).toBeVisible();
	return new URL(await field.inputValue()).pathname;
}

test('an invited person creates their own account, and the link works once', async ({
	page,
	browser
}) => {
	await page.goto('/admin/users');
	const link = await linkFrom(page, async () => {
		await page.getByLabel('Their email address').fill(person.email);
		await page.getByRole('button', { name: 'Create invitation link' }).click();
	});
	await expect(
		page.getByRole('heading', { name: `Invitation link for ${person.email}` })
	).toBeVisible();

	const theirs = await freshPage(browser);
	await theirs.goto(link);
	await expect(theirs.getByRole('heading', { name: 'Create your account' })).toBeVisible();
	await theirs.getByLabel('Your name').fill(person.name);
	await theirs.getByLabel('Password', { exact: true }).fill(person.password);
	await theirs.getByLabel('Password, again').fill('something else entirely');
	await theirs.getByRole('button', { name: 'Create account' }).click();
	await expect(theirs.getByRole('alert')).toContainText('not the same');

	await theirs.getByLabel('Password', { exact: true }).fill(person.password);
	await theirs.getByLabel('Password, again').fill(person.password);
	await theirs.getByRole('button', { name: 'Create account' }).click();
	await expect(theirs).toHaveURL('/');
	await expect(theirs.getByRole('heading', { name: 'No projects yet' })).toBeVisible();

	// The link is spent.
	const again = await freshPage(browser);
	await again.goto(link);
	await expect(again.getByRole('heading', { name: 'This link does not work' })).toBeVisible();

	// The administrator sees the new account; the invitation cannot be issued twice.
	await page.reload();
	await expect(page.getByText(person.name)).toBeVisible();
	await page.getByLabel('Their email address').fill(person.email);
	await page.getByRole('button', { name: 'Create invitation link' }).click();
	await expect(page.getByRole('alert')).toContainText('already exists');
	await theirs.context().close();
	await again.context().close();
});

test('people who are not administrators cannot open the administration pages', async ({
	browser
}) => {
	const theirs = await freshPage(browser);
	await signIn(theirs, person.password);
	await expect(theirs).toHaveURL('/');

	for (const path of ['/admin/users', '/admin/activity']) {
		const response = await theirs.goto(path);
		expect(response?.status(), path).toBe(404);
	}
	await theirs.goto('/');
	await theirs.getByRole('button', { name: /^Account/ }).click();
	await expect(theirs.getByRole('menuitem', { name: 'Your account' })).toBeVisible();
	await expect(theirs.getByRole('menuitem', { name: 'People' })).toHaveCount(0);

	const invite = await theirs.request.post('/admin/users?/invite', {
		form: { email: 'sneaky@example.org' },
		headers: { origin: new URL(theirs.url()).origin, accept: 'application/json' }
	});
	expect(await invite.text()).not.toContain('/link/');
	await theirs.context().close();
});

test('the account page changes name and password and signs other sessions out', async ({
	browser
}) => {
	const laptop = await freshPage(browser);
	const phone = await freshPage(browser);
	await signIn(laptop, person.password);
	await signIn(phone, person.password);
	await expect(phone).toHaveURL('/');

	await laptop.goto('/account');
	await expect(laptop.getByText('This session')).toHaveCount(1);
	// This one, the phone's, and those left by earlier sign-ins on other devices.
	expect(await laptop.locator('.sessions li').count()).toBeGreaterThanOrEqual(2);

	await laptop.getByLabel('Shown on your checkpoints and to others').fill('Rear Admiral Hopper');
	await laptop.getByRole('button', { name: 'Save name' }).click();
	await expect(laptop.getByRole('button', { name: /^Account: Rear Admiral Hopper/ })).toBeVisible();

	// The current password is required.
	await laptop.getByLabel('Current password').fill('not my password');
	await laptop.getByLabel('New password', { exact: true }).fill(person.newPassword);
	await laptop.getByLabel('New password, again').fill(person.newPassword);
	await laptop.getByRole('button', { name: 'Change password' }).click();
	await expect(laptop.getByRole('alert')).toContainText('current password is not correct');

	await laptop.getByLabel('Current password').fill(person.password);
	await laptop.getByLabel('New password', { exact: true }).fill(person.newPassword);
	await laptop.getByLabel('New password, again').fill(person.newPassword);
	await laptop.getByRole('button', { name: 'Change password' }).click();
	await expect(laptop.getByRole('status')).toContainText('Password changed');

	// This session survives; the other one is gone.
	await laptop.reload();
	await expect(laptop.locator('.sessions li')).toHaveCount(1);
	await phone.goto('/');
	await expect(phone).toHaveURL(/\/login/);

	// Old password out, new password in.
	await signIn(phone, person.password);
	await expect(phone.getByRole('alert')).toContainText('Email or password is not correct');
	await signIn(phone, person.newPassword);
	await expect(phone).toHaveURL('/');

	// A single session can be signed out from the list.
	await laptop.reload();
	await expect(laptop.locator('.sessions li')).toHaveCount(2);
	await laptop
		.locator('.sessions li')
		.nth(1)
		.getByRole('button', { name: /^Sign out/ })
		.click();
	await expect(laptop.locator('.sessions li')).toHaveCount(1);
	await phone.goto('/');
	await expect(phone).toHaveURL(/\/login/);
	await laptop.context().close();
	await phone.context().close();
});

test('an administrator can disable an account and issue a password reset link', async ({
	page,
	browser
}) => {
	const theirs = await freshPage(browser);
	await signIn(theirs, person.newPassword);
	await expect(theirs).toHaveURL('/');

	await page.goto('/admin/users');
	await page.getByRole('button', { name: 'Disable Rear Admiral Hopper' }).click();
	await expect(page.getByText('Disabled', { exact: true })).toBeVisible();

	// Signed out at once, and locked out.
	await theirs.goto('/');
	await expect(theirs).toHaveURL(/\/login/);
	await signIn(theirs, person.newPassword);
	await expect(theirs.getByRole('alert')).toContainText('Email or password is not correct');

	await page.getByRole('button', { name: 'Enable Rear Admiral Hopper' }).click();
	await expect(page.getByText('Disabled', { exact: true })).toHaveCount(0);

	const link = await linkFrom(page, () =>
		page.getByRole('button', { name: 'Password reset link for Rear Admiral Hopper' }).click()
	);
	await theirs.goto(link);
	await expect(theirs.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
	await theirs.getByLabel('New password', { exact: true }).fill('third passphrase here');
	await theirs.getByLabel('New password, again').fill('third passphrase here');
	await theirs.getByRole('button', { name: 'Set password and sign in' }).click();
	await expect(theirs).toHaveURL('/');

	// Administrators cannot lock themselves out.
	await expect(page.getByRole('button', { name: 'Disable Ada Lovelace' })).toHaveCount(0);
	await theirs.context().close();
});

test('the activity log records who did what', async ({ page }) => {
	await page.goto('/admin/activity');
	const rows = page.locator('tbody tr');
	await expect(rows.filter({ hasText: 'Invited' }).filter({ hasText: person.email })).toHaveCount(
		1
	);
	await expect(rows.filter({ hasText: 'Accepted an invitation' }).first()).toBeVisible();
	await expect(rows.filter({ hasText: 'Failed sign-in' }).first()).toBeVisible();
	await expect(rows.filter({ hasText: 'Changed their password' }).first()).toBeVisible();
	await expect(rows.filter({ hasText: 'Disabled the account of' }).first()).toBeVisible();
	await expect(
		rows.filter({ hasText: 'Set a new password with a reset link' }).first()
	).toBeVisible();

	await page.getByLabel('Filter by person, action or address').fill('failed sign-in');
	await expect(rows.first()).toContainText('Failed sign-in');
	await expect(rows.filter({ hasText: 'Invited' })).toHaveCount(0);
});
