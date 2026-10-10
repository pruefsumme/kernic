import { fail } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { createInvitation, createPasswordReset } from '#lib/server/auth/account-links.ts';
import {
	EmailTakenError,
	LastAdminError,
	listUsers,
	setUserDisabled
} from '#lib/server/auth/users.ts';
import { validateEmail } from '#lib/server/auth/validation.ts';
import { requireAdmin } from '#lib/server/http.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const admin = requireAdmin(event);
	return { users: await listUsers(), ownId: admin.id };
};

export const actions: Actions = {
	/** Creates an invitation link. The link is returned once and not stored in readable form. */
	invite: async (event) => {
		const admin = requireAdmin(event);
		const form = await event.request.formData();
		const email = validateEmail(form.get('email'));
		if (!email.ok) return fail(400, { action: 'invite', message: email.message });

		try {
			const { token, expiresAt } = await createInvitation(email.value, admin.id);
			await recordAudit(event, 'account.invited', { subject: email.value });
			return {
				action: 'invite',
				link: {
					url: `${event.url.origin}/link/${token}`,
					for: email.value,
					expiresAt,
					kind: 'invite'
				}
			};
		} catch (cause) {
			if (cause instanceof EmailTakenError) {
				return fail(400, {
					action: 'invite',
					message: 'An account with this email already exists.'
				});
			}
			throw cause;
		}
	},

	reset: async (event) => {
		const admin = requireAdmin(event);
		const form = await event.request.formData();
		const user = (await listUsers()).find((candidate) => candidate.id === form.get('userId'));
		if (!user || user.disabledAt)
			return fail(400, { action: 'reset', message: 'That account cannot be reset.' });

		const { token, expiresAt } = await createPasswordReset(user.id, admin.id);
		await recordAudit(event, 'account.reset-link-created', { subject: user.email });
		return {
			action: 'reset',
			link: { url: `${event.url.origin}/link/${token}`, for: user.email, expiresAt, kind: 'reset' }
		};
	},

	disable: async (event) => setDisabled(event, true),
	enable: async (event) => setDisabled(event, false)
};

async function setDisabled(event: Parameters<Actions[string]>[0], disabled: boolean) {
	const admin = requireAdmin(event);
	const form = await event.request.formData();
	const user = (await listUsers()).find((candidate) => candidate.id === form.get('userId'));
	if (!user) return fail(400, { action: 'status', message: 'Account not found.' });
	if (disabled && user.id === admin.id) {
		return fail(400, { action: 'status', message: 'You cannot disable your own account.' });
	}

	try {
		await setUserDisabled(user.id, disabled);
	} catch (cause) {
		if (cause instanceof LastAdminError) {
			return fail(400, {
				action: 'status',
				message: 'This is the only administrator. Make someone else an administrator first.'
			});
		}
		throw cause;
	}
	await recordAudit(event, disabled ? 'account.disabled' : 'account.enabled', {
		subject: user.email
	});
	return { action: 'status', saved: true };
}
