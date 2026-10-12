import { fail, redirect } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { requireUser } from '#lib/server/http.ts';
import {
	createSharedWorkspace,
	listWorkspaceOverviews,
	WorkspaceError
} from '#lib/server/workspaces.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	return { workspaces: await listWorkspaceOverviews(user.id) };
};

export const actions: Actions = {
	create: async (event) => {
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
		redirect(303, `/workspaces/${id}`);
	}
};
