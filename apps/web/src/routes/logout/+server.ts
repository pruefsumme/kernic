import { redirect } from '@sveltejs/kit';
import { clearSessionCookie, readSessionCookie } from '#lib/server/auth/cookies.ts';
import { revokeSession } from '#lib/server/auth/sessions.ts';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	const token = readSessionCookie(event);
	if (token) await revokeSession(token);
	clearSessionCookie(event);
	redirect(303, '/login');
};
