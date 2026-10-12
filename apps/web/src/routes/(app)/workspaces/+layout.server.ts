import { requireUser } from '#lib/server/http.ts';
import { listWorkspaceOverviews } from '#lib/server/workspaces.ts';
import type { LayoutServerLoad } from './$types';

/** Every workspace of the signed-in person, for the list beside whichever one is open. */
export const load: LayoutServerLoad = async (event) => {
	const user = requireUser(event);
	return { overviews: await listWorkspaceOverviews(user.id) };
};
