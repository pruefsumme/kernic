import { error } from '@sveltejs/kit';
import { projectTreeDir } from '#lib/server/config.ts';
import { requireProject } from '#lib/server/http.ts';
import { MAX_QUERY_LENGTH, searchTree } from '#lib/server/projects/search.ts';
import type { RequestHandler } from './$types';

/** Finds text in the saved files of the project. */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const query = event.url.searchParams.get('q') ?? '';
	if (query.trim().length < 2) error(400, 'Type at least two characters to search.');
	if (query.length > MAX_QUERY_LENGTH) error(400, 'That is too long to search for.');

	return Response.json(await searchTree(projectTreeDir(project.id), query));
};
