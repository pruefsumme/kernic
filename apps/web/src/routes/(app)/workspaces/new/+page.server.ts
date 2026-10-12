import { fail, redirect } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { requireUser } from '#lib/server/http.ts';
import { createSharedWorkspace, WorkspaceError } from '#lib/server/workspaces.ts';
import type { Actions } from './$types';

export const actions: Actions = {
	default: async (event) => {
		const user = requireUser(event);
		const name = String((await event.request.formData()).get('name') ?? '');
		let id: string;
		try {
			id = await createSharedWorkspace(user.id, name);
		} catch (cause) {
			if (cause instanceof WorkspaceError) return fail(400, { name, message: cause.message });
			throw cause;
		}
		await recordAudit(event, 'workspace.created', { subject: name.trim() });
		// A new workspace has nobody else in it yet: start where people are let in.
		redirect(303, `/workspaces/${id}?section=invitations`);
	}
};
