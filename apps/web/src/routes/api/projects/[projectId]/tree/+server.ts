import { projectTreeDir } from '#lib/server/config.ts';
import { requireProject } from '#lib/server/http.ts';
import { listTree } from '#lib/server/projects/tree.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	return Response.json({
		entries: await listTree(projectTreeDir(project.id)),
		revision: project.revision
	});
};
