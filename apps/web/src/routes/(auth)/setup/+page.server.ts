import { fail, redirect } from '@sveltejs/kit';
import { setSessionCookie } from '#lib/server/auth/cookies.ts';
import { RateLimiter } from '#lib/server/auth/rate-limit.ts';
import { createSession } from '#lib/server/auth/sessions.ts';
import { markSetupComplete, verifySetupToken } from '#lib/server/auth/setup.ts';
import { SetupAlreadyCompleteError, createFirstAdmin } from '#lib/server/auth/users.ts';
import {
	validateDisplayName,
	validateEmail,
	validateNewPassword
} from '#lib/server/auth/validation.ts';
import type { Actions } from './$types';

// The setup token is the only thing protecting a fresh instance, so guessing it is throttled.
const attempts = new RateLimiter(10, 10 * 60 * 1000);

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const values = {
			displayName: String(form.get('displayName') ?? ''),
			email: String(form.get('email') ?? '')
		};

		const wait = attempts.hit(event.getClientAddress());
		if (wait > 0) {
			return fail(429, {
				values,
				field: 'setupToken',
				message: `Too many attempts. Try again in ${Math.ceil(wait / 60)} minutes.`
			});
		}

		if (!verifySetupToken(String(form.get('setupToken') ?? ''))) {
			return fail(400, {
				values,
				field: 'setupToken',
				message: 'That setup token is not correct. Copy it from the server log.'
			});
		}

		const displayName = validateDisplayName(form.get('displayName'));
		if (!displayName.ok)
			return fail(400, { values, field: 'displayName', message: displayName.message });
		const email = validateEmail(form.get('email'));
		if (!email.ok) return fail(400, { values, field: 'email', message: email.message });
		const password = validateNewPassword(form.get('password'));
		if (!password.ok) return fail(400, { values, field: 'password', message: password.message });

		let user;
		try {
			user = await createFirstAdmin({
				displayName: displayName.value,
				email: email.value,
				password: password.value
			});
		} catch (error) {
			if (error instanceof SetupAlreadyCompleteError) redirect(303, '/login');
			throw error;
		}

		markSetupComplete();
		const session = await createSession(user.id);
		setSessionCookie(event, session.token, session.expiresAt);
		redirect(303, '/');
	}
};
