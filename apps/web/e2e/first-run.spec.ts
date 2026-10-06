import { expect, test } from '@playwright/test';
import { admin, adminStorageState, setupToken } from './environment.ts';

test.describe.configure({ mode: 'serial' });

test('a fresh server sends every visitor to setup', async ({ page }) => {
	await page.goto('/');
	await expect(page).toHaveURL(/\/setup$/);
	await page.goto('/login');
	await expect(page).toHaveURL(/\/setup$/);
	await expect(page.getByRole('heading', { name: 'Set up Kernic' })).toBeVisible();
});

test('setup rejects a wrong token and keeps the entered values', async ({ page }) => {
	await page.goto('/setup');
	await page.getByLabel('Setup token').fill('not-the-token');
	await page.getByLabel('Your name').fill(admin.name);
	await page.getByLabel('Email').fill(admin.email);
	await page.getByLabel('Password').fill(admin.password);
	await page.getByRole('button', { name: 'Create administrator' }).click();

	await expect(page.getByRole('alert')).toContainText('setup token is not correct');
	await expect(page.getByLabel('Your name')).toHaveValue(admin.name);
	await expect(page).toHaveURL(/\/setup/);
});

test('setup creates the administrator and signs them in', async ({ page }) => {
	await page.goto('/setup');
	await page.getByLabel('Setup token').fill(setupToken);
	await page.getByLabel('Your name').fill(admin.name);
	await page.getByLabel('Email').fill(admin.email);
	await page.getByLabel('Password').fill(admin.password);
	await page.getByRole('button', { name: 'Create administrator' }).click();

	await expect(page).toHaveURL('/');
	await expect(page.getByRole('heading', { name: 'No projects yet' })).toBeVisible();
	await page.context().storageState({ path: adminStorageState });
});

test('setup is closed once an account exists', async ({ page }) => {
	await page.goto('/setup');
	await expect(page).toHaveURL(/\/login$/);
});

test('sign-in rejects a wrong password and accepts the right one', async ({ page }) => {
	await page.goto('/projects/00000000-0000-0000-0000-000000000000');
	await expect(page).toHaveURL(/\/login\?next=/);

	await page.getByLabel('Email').fill(admin.email);
	await page.getByLabel('Password').fill('definitely wrong');
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('alert')).toContainText('Email or password is not correct');

	await page.getByLabel('Password').fill(admin.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	// `next` leads back to the page that asked for sign-in (which does not exist here).
	await expect(page).toHaveURL(/\/projects\/0{8}-/);
	await expect(page.getByRole('heading', { name: 'This page does not exist' })).toBeVisible();
});

test('signing out ends the session', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill(admin.email);
	await page.getByLabel('Password').fill(admin.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL('/');

	await page.getByRole('button', { name: /^Account/ }).click();
	await page.getByRole('menuitem', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login$/);
	await page.goto('/');
	await expect(page).toHaveURL(/\/login$/);
});
