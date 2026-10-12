import { fail, redirect } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { RateLimiter } from '#lib/server/auth/rate-limit.ts';
import { requireUser } from '#lib/server/http.ts';
import {
	acceptWorkspaceInvite,
	findWorkspaceInvite,
	getWorkspace,
	WorkspaceError
} from '#lib/server/workspaces.ts';
import type { Actions, PageServerLoad } from './$types';

// Links are long random values; this only keeps anyone from trying many.
const lookups = new RateLimiter(30, 10 * 60 * 1000);

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	if (lookups.hit(user.id) > 0) {
		return { invite: null, workspaceId: null, already: false, tooMany: true };
	}

	const invite = await findWorkspaceInvite(event.params.token);
	const already = invite ? (await getWorkspace(user.id, invite.workspaceId)) !== null : false;
	return {
		invite: invite && {
			workspaceName: invite.workspaceName,
			role: invite.role,
			invitedBy: invite.invitedBy
		},
		workspaceId: already ? invite!.workspaceId : null,
		already,
		tooMany: false
	};
};

export const actions: Actions = {
	default: async (event) => {
		const user = requireUser(event);
		const invite = await findWorkspaceInvite(event.params.token);
		let workspaceId: string;
		try {
			workspaceId = await acceptWorkspaceInvite(event.params.token, user.id);
		} catch (cause) {
			if (cause instanceof WorkspaceError) return fail(400, { message: cause.message });
			throw cause;
		}
		await recordAudit(event, 'workspace.member-joined', { subject: invite?.workspaceName });
		redirect(303, `/workspaces/${workspaceId}`);
	}
};
