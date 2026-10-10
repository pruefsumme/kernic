import { fail } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { readSessionCookie } from '#lib/server/auth/cookies.ts';
import { RateLimiter } from '#lib/server/auth/rate-limit.ts';
import { listSessions, revokeAllSessions, revokeSessionById } from '#lib/server/auth/sessions.ts';
import { WrongPasswordError, changePassword, updateDisplayName } from '#lib/server/auth/users.ts';
import { validateDisplayName, validateNewPassword } from '#lib/server/auth/validation.ts';
import { requireUser } from '#lib/server/http.ts';
import type { Actions, PageServerLoad } from './$types';

// Guessing the current password from a hijacked session is throttled like sign-in.
const passwordAttempts = new RateLimiter(8, 10 * 60 * 1000);

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	return {
		account: { email: user.email, displayName: user.displayName, isAdmin: user.isAdmin },
		sessions: await listSessions(user.id, readSessionCookie(event) ?? '')
	};
};

export const actions: Actions = {
	name: async (event) => {
		const user = requireUser(event);
		const form = await event.request.formData();
		const displayName = validateDisplayName(form.get('displayName'));
		if (!displayName.ok) return fail(400, { action: 'name', message: displayName.message });
		await updateDisplayName(user.id, displayName.value);
		return { action: 'name', saved: true };
	},

	password: async (event) => {
		const user = requireUser(event);
		const form = await event.request.formData();

		const wait = passwordAttempts.hit(user.id);
		if (wait > 0) {
			return fail(429, {
				action: 'password',
				message: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.`
			});
		}
		const next = validateNewPassword(form.get('newPassword'));
		if (!next.ok) return fail(400, { action: 'password', message: next.message });
		if (form.get('newPassword') !== form.get('repeatPassword')) {
			return fail(400, { action: 'password', message: 'The two new passwords are not the same.' });
		}

		try {
			await changePassword(user.id, String(form.get('currentPassword') ?? ''), next.value);
		} catch (cause) {
			if (cause instanceof WrongPasswordError) {
				return fail(400, { action: 'password', message: 'The current password is not correct.' });
			}
			throw cause;
		}

		// Anyone else who was signed in with the old password is signed out.
		await revokeAllSessions(user.id, readSessionCookie(event));
		passwordAttempts.reset(user.id);
		await recordAudit(event, 'password.changed');
		return { action: 'password', saved: true };
	},

	revoke: async (event) => {
		const user = requireUser(event);
		const form = await event.request.formData();
		if (await revokeSessionById(user.id, String(form.get('sessionId') ?? ''))) {
			await recordAudit(event, 'session.revoked');
		}
		return { action: 'revoke', saved: true };
	}
};
