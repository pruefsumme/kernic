import { projectTreeDir } from '#lib/server/config.ts';
import { attachment, requireProject } from '#lib/server/http.ts';
import { zipTree } from '#lib/server/projects/archive.ts';
import type { RequestHandler } from './$types';

/** Downloads all project files as a ZIP archive. */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');

	return new Response(await zipTree(projectTreeDir(project.id)), {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': attachment(project.name, 'zip'),
			'cache-control': 'private, no-store'
		}
	});
};
