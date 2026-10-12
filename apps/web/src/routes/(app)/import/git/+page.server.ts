import { error, fail, isHttpError, redirect } from '@sveltejs/kit';
import { remoteHosts, remotesEnabled } from '#lib/server/history/remotes.ts';
import { RemoteUrlError } from '#lib/server/history/remote-url.ts';
import { requireUser } from '#lib/server/http.ts';
import { startClone } from '#lib/server/imports/imports.ts';
import {
	canWrite,
	getWorkspaceRole,
	listWorkspacesForUser
} from '#lib/server/projects/projects.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	// Without a list of hosts this server does not connect to any.
	if (!remotesEnabled) redirect(303, '/import');
	const workspaces = (await listWorkspacesForUser(user.id)).filter((workspace) =>
		canWrite(workspace.role)
	);
	return { workspaces: workspaces.map(({ id, name }) => ({ id, name })), hosts: remoteHosts };
};

export const actions: Actions = {
	default: async (event) => {
		const user = requireUser(event);
		if (!remotesEnabled) error(400, 'This server is not set up to connect to Git repositories.');
		const form = await event.request.formData();
		const workspaceId = String(form.get('workspace') ?? '');
		const role = await getWorkspaceRole(user.id, workspaceId);
		if (!role || !canWrite(role)) error(403, 'You cannot create projects in that workspace.');

		// What was typed comes back if it is refused, except the token.
		const entered = {
			url: String(form.get('url') ?? ''),
			branch: String(form.get('branch') ?? ''),
			username: String(form.get('username') ?? ''),
			workspace: workspaceId
		};
		let id: string;
		try {
			id = await startClone({
				userId: user.id,
				workspaceId,
				url: entered.url,
				branch: entered.branch,
				username: entered.username,
				token: form.get('token') ?? ''
			});
		} catch (cause) {
			if (cause instanceof RemoteUrlError) return fail(400, { message: cause.message, entered });
			if (isHttpError(cause)) return fail(cause.status, { message: cause.body.message, entered });
			throw cause;
		}
		redirect(303, `/import/${id}`);
	}
};
