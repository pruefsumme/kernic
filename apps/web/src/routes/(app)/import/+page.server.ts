import { requireUser } from '#lib/server/http.ts';
import { maxArchiveBytes } from '#lib/server/imports/imports.ts';
import { canWrite, listWorkspacesForUser } from '#lib/server/projects/projects.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const workspaces = (await listWorkspacesForUser(user.id)).filter((workspace) =>
		canWrite(workspace.role)
	);
	return {
		workspaces: workspaces.map(({ id, name }) => ({ id, name })),
		maxArchiveBytes
	};
};
