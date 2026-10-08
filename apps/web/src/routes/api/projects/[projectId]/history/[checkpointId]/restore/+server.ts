import { authorOf, withHistory } from '#lib/server/history/history.ts';
import { requireProject, throwAsHttpError } from '#lib/server/http.ts';
import { bumpRevision } from '#lib/server/projects/projects.ts';
import type { RequestHandler } from './$types';

/**
 * Replaces the project's files with those of an earlier checkpoint. The current
 * state is checkpointed first, so a restore can itself be undone.
 */
export const POST: RequestHandler = async (event) => {
	const { project, user } = await requireProject(event, 'write');
	const checkpoint = await withHistory(project.id, (history) =>
		history.restore(event.params.checkpointId, authorOf(user))
	).catch(throwAsHttpError);
	return Response.json({ checkpoint, revision: await bumpRevision(project.id) });
};
