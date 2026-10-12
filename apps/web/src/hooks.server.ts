import { redirect } from '@sveltejs/kit';
import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
	clearSessionCookie,
	readSessionCookie,
	setSessionCookie
} from '#lib/server/auth/cookies.ts';
import { APPEARANCE_COOKIE, parseAppearance } from '#lib/appearance.ts';
import { deleteExpiredSessions, validateSession } from '#lib/server/auth/sessions.ts';
import { isSetupComplete, prepareSetup } from '#lib/server/auth/setup.ts';
import { startJobDispatcher } from '#lib/server/compile/jobs.ts';
import { dataDir } from '#lib/server/config.ts';
import { sql } from '#lib/server/db/client.ts';
import { bundledMigrations, migrate } from '#lib/server/db/migrate.ts';
import { startImportCleanup } from '#lib/server/imports/imports.ts';
import { measureUnmeasuredProjects } from '#lib/server/projects/projects.ts';
import { removeInterruptedWrites } from '#lib/server/projects/tree.ts';

export const init: ServerInit = async () => {
	// A promise nobody awaited must not take the whole server down with everyone's
	// open editors. Log it loudly instead; real programming errors still surface.
	process.on('unhandledRejection', (reason) => {
		console.error('Unhandled promise rejection (the server keeps running):', reason);
	});

	// Migrate before serving anything, so an upgrade is: replace the image, start it.
	const applied = await migrate(sql, bundledMigrations());
	if (applied.length > 0) console.log(`Applied database migrations: ${applied.join(', ')}`);

	await fs.mkdir(dataDir, { recursive: true });
	const leftovers = await removeInterruptedWrites(path.join(dataDir, 'projects'));
	if (leftovers > 0) {
		console.log(`Removed ${leftovers} temporary file(s) of saves that were interrupted.`);
	}
	await deleteExpiredSessions();
	await prepareSetup();
	// Projects from before sizes were kept are measured once, without holding up the start.
	void measureUnmeasuredProjects().catch((error) =>
		console.error('could not measure project sizes', error)
	);
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

	// The look chosen in this browser is part of the page from its first byte.
	const look = parseAppearance(event.cookies.get(APPEARANCE_COOKIE));
	const response = await resolve(event, {
		transformPageChunk: ({ html }) =>
			html
				.replace('%kernic.theme%', look.theme)
				.replace('%kernic.pages%', look.pages)
				.replace('%kernic.hue%', String(look.hue))
	});
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-frame-options', 'DENY');
	// No other site may hold a window reference to Kernic, and Kernic uses none
	// of the browser's device features.
	response.headers.set('cross-origin-opener-policy', 'same-origin');
	response.headers.set(
		'permissions-policy',
		'camera=(), microphone=(), geolocation=(), payment=()'
	);
	return response;
};
