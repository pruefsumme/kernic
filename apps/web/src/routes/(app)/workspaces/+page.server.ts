import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** "Workspaces" opens on the person's own one; the others are a click away in the list. */
export const load: PageServerLoad = async ({ parent }) => {
	const { overviews } = await parent();
	const own = overviews.find((workspace) => workspace.kind === 'personal') ?? overviews[0];
	if (!own) error(404, 'You are not in any workspace.');
	redirect(303, `/workspaces/${own.id}`);
};
