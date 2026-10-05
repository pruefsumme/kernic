import { KERNIC_SETUP_TOKEN } from '$app/env/private';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hasAnyUser } from './users';

/**
 * First-run setup is protected by a token that only someone with access to the
 * server (its configuration or its log) can know. Without it, whoever reaches a
 * fresh instance first could claim the administrator account.
 */
let setupToken: string | null = null;
let setupComplete = false;

export async function isSetupComplete(): Promise<boolean> {
	// Once a user exists setup can never reopen, so the positive answer is cached.
	if (!setupComplete) setupComplete = await hasAnyUser();
	return setupComplete;
}

export function markSetupComplete(): void {
	setupComplete = true;
	setupToken = null;
}

/** Call once at startup. Logs the generated token when setup is still pending. */
export async function prepareSetup(): Promise<void> {
	if (await isSetupComplete()) return;

	if (KERNIC_SETUP_TOKEN) {
		setupToken = KERNIC_SETUP_TOKEN;
		console.log('Kernic is not set up yet. Open /setup and enter the value of KERNIC_SETUP_TOKEN.');
		return;
	}

	setupToken = randomBytes(18).toString('base64url');
	console.log(
		`Kernic is not set up yet. Open /setup and enter this setup token: ${setupToken}\n` +
			'The token changes when the server restarts.'
	);
}

export function verifySetupToken(candidate: string): boolean {
	if (!setupToken) return false;
	const digest = (value: string) => createHash('sha256').update(value).digest();
	return timingSafeEqual(digest(candidate.trim()), digest(setupToken));
}
