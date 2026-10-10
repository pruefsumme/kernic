import { withHistory } from '#lib/server/history/history.ts';
import { requireProject, throwAsHttpError } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * What changed in a checkpoint; for an automatic snapshot, what changed since
 * it. The id `working` stands for the current files compared with the last
 * checkpoint.
 */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const id = event.params.checkpointId === 'working' ? null : event.params.checkpointId;
	const files = await withHistory(project.id, (history) => history.diff(id)).catch(
		throwAsHttpError
	);
	return Response.json({ files }, { headers: { 'cache-control': 'no-store' } });
};
