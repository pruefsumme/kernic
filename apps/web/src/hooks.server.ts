import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import * as fs from 'node:fs/promises';
import {
	clearSessionCookie,
	readSessionCookie,
	setSessionCookie
} from '#lib/server/auth/cookies.ts';
import { deleteExpiredSessions, validateSession } from '#lib/server/auth/sessions.ts';
import { isSetupComplete, prepareSetup } from '#lib/server/auth/setup.ts';
import { startJobDispatcher } from '#lib/server/compile/jobs.ts';
import { dataDir } from '#lib/server/config.ts';
import { sql } from '#lib/server/db/client.ts';
import { bundledMigrations, migrate } from '#lib/server/db/migrate.ts';
import { startImportCleanup } from '#lib/server/imports/imports.ts';

export const init: ServerInit = async () => {
	// Migrate before serving anything, so an upgrade is: replace the image, start it.
	const applied = await migrate(sql, bundledMigrations());
	if (applied.length > 0) console.log(`Applied database migrations: ${applied.join(', ')}`);

	await fs.mkdir(dataDir, { recursive: true });
	await deleteExpiredSessions();
	await prepareSetup();
	await startJobDispatcher();
	await startImportCleanup();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const handle: Handle = async ({ event, resolve }) => {
	const { url, request } = event;

	// SvelteKit already rejects cross-origin form posts. The JSON and upload
	// endpoints authenticate with the same cookie, so hold every state-changing
	// request to the same rule. Browsers always send Origin on such requests.
	if (!SAFE_METHODS.has(request.method) && request.headers.get('origin') !== url.origin) {
		return Response.json({ message: 'Cross-origin requests are not allowed.' }, { status: 403 });
	}

	event.locals.user = null;
	const token = readSessionCookie(event);
	if (token) {
		const session = await validateSession(token);
		if (session) {
			event.locals.user = session.user;
			if (session.renewed) setSessionCookie(event, token, session.expiresAt);
		} else {
			clearSessionCookie(event);
		}
	}

	const isHealthCheck = url.pathname === '/healthz';
	const onSetupPage = url.pathname === '/setup';
	if (!isHealthCheck) {
		const setupComplete = await isSetupComplete();
		if (!setupComplete && !onSetupPage) redirect(303, '/setup');
		if (setupComplete && onSetupPage) redirect(303, '/login');
	}

	const response = await resolve(event);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-frame-options', 'DENY');
	return response;
};
