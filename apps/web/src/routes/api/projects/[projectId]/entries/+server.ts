import { error } from '@sveltejs/kit';
import { projectTreeDir, treeLimits } from '#lib/server/config.ts';
import { requireProject, throwAsHttpError } from '#lib/server/http.ts';
import { bumpRevision } from '#lib/server/projects/projects.ts';
import { createTreeDirectory, writeTreeFile } from '#lib/server/projects/tree.ts';
import type { RequestHandler } from './$types';

/** Creates an empty file or a folder. Fails if something already has that name. */
export const POST: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'write');
	const body = (await event.request.json().catch(() => null)) as {
		type?: unknown;
		path?: unknown;
	} | null;
	if (!body || (body.type !== 'file' && body.type !== 'directory')) {
		error(400, 'Expected a JSON body with "type" and "path".');
	}

	const root = projectTreeDir(project.id);
	try {
		if (body.type === 'directory') {
			await createTreeDirectory(root, body.path as string, treeLimits);
		} else {
			await writeTreeFile(root, body.path as string, Buffer.alloc(0), {
				limits: treeLimits,
				baseHash: null
			});
		}
	} catch (cause) {
		throwAsHttpError(cause);
	}

	return Response.json({ revision: await bumpRevision(project.id) }, { status: 201 });
};
