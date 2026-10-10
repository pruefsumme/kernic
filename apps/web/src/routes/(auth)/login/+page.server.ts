import { fail, redirect } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { setSessionCookie } from '#lib/server/auth/cookies.ts';
import { RateLimiter } from '#lib/server/auth/rate-limit.ts';
import { createSession } from '#lib/server/auth/sessions.ts';
import { authenticate } from '#lib/server/auth/users.ts';
import { validateEmail } from '#lib/server/auth/validation.ts';
import type { Actions, PageServerLoad } from './$types';

const attemptsByAddress = new RateLimiter(30, 10 * 60 * 1000);
const attemptsByAccount = new RateLimiter(8, 10 * 60 * 1000);

/** Only follow `next` to a path on this site, never to another origin. */
function safeNextPath(next: string | null): string {
	if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
	return next;
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.user) redirect(303, safeNextPath(url.searchParams.get('next')));
	return {};
};

export const actions: Actions = {
	default: async (event) => {
		const form = await event.request.formData();
		const emailInput = String(form.get('email') ?? '');
		const password = String(form.get('password') ?? '');

		const email = validateEmail(emailInput);
		const wait = Math.max(
			attemptsByAddress.hit(event.getClientAddress()),
			email.ok ? attemptsByAccount.hit(email.value) : 0
		);
		if (wait > 0) {
			return fail(429, {
				email: emailInput,
				message: `Too many sign-in attempts. Try again in ${Math.ceil(wait / 60)} minutes.`
			});
		}

		const user = email.ok && password ? await authenticate(email.value, password) : null;
		if (!user) {
			await recordAudit(event, 'sign-in.failed', {
				subject: emailInput.slice(0, 254),
				actor: null
			});
			// One message for unknown address and wrong password alike.
			return fail(400, { email: emailInput, message: 'Email or password is not correct.' });
		}

		attemptsByAccount.reset(user.email);
		await recordAudit(event, 'sign-in.succeeded', { actor: user });
		const session = await createSession(user.id, event.request.headers.get('user-agent'));
		setSessionCookie(event, session.token, session.expiresAt);
		redirect(303, safeNextPath(event.url.searchParams.get('next')));
	}
};
