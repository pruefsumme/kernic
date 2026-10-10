import { error, fail, redirect } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import {
	LinkNotValidError,
	findAccountLink,
	redeemAccountLink
} from '#lib/server/auth/account-links.ts';
import { setSessionCookie } from '#lib/server/auth/cookies.ts';
import { RateLimiter } from '#lib/server/auth/rate-limit.ts';
import { createSession } from '#lib/server/auth/sessions.ts';
import { EmailTakenError } from '#lib/server/auth/users.ts';
import { validateDisplayName, validateNewPassword } from '#lib/server/auth/validation.ts';
import type { Actions, PageServerLoad } from './$types';

// Tokens are long and random; this only keeps a guesser from hammering the database.
const lookups = new RateLimiter(30, 10 * 60 * 1000);
const GONE =
	'This link is not valid any more. It may have been used already or have expired. Ask your administrator for a new one.';

export const load: PageServerLoad = async (event) => {
	if (lookups.hit(event.getClientAddress()) > 0) error(429, 'Too many attempts. Try again later.');
	const link = await findAccountLink(event.params.token);
	if (!link) error(404, GONE);
	return { link: { kind: link.kind, email: link.email } };
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const link = await findAccountLink(event.params.token);
		if (!link) error(404, GONE);

		const displayNameInput = String(form.get('displayName') ?? '');
		let displayName: string | undefined;
		if (link.kind === 'invite') {
			const name = validateDisplayName(displayNameInput);
			if (!name.ok) return fail(400, { displayName: displayNameInput, message: name.message });
			displayName = name.value;
		}
		const password = validateNewPassword(form.get('password'));
		if (!password.ok)
			return fail(400, { displayName: displayNameInput, message: password.message });
		if (form.get('password') !== form.get('repeatPassword')) {
			return fail(400, {
				displayName: displayNameInput,
				message: 'The two passwords are not the same.'
			});
		}

		let result;
		try {
			result = await redeemAccountLink(event.params.token, {
				displayName,
				password: password.value
			});
		} catch (cause) {
			if (cause instanceof LinkNotValidError) error(404, GONE);
			if (cause instanceof EmailTakenError) {
				return fail(400, {
					displayName: displayNameInput,
					message: 'An account with this email already exists. Sign in instead.'
				});
			}
			throw cause;
		}

		await recordAudit(event, result.kind === 'invite' ? 'account.created' : 'password.reset', {
			actor: result.user
		});
		const session = await createSession(result.user.id, event.request.headers.get('user-agent'));
		setSessionCookie(event, session.token, session.expiresAt);
		redirect(303, '/');
	}
};
