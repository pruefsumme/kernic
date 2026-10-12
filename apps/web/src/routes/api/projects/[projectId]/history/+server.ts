import { authorOf, validateCheckpointMessage, withHistory } from '#lib/server/history/history.ts';
import { getRemoteStatus } from '#lib/server/history/remotes.ts';
import { requireProject, throwAsHttpError } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * Checkpoints and automatic snapshots, newest first, what changed since the last
 * checkpoint, and the repository the checkpoints are pushed to.
 */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const result = await withHistory(project.id, async (history) => ({
		checkpoints: await history.list(),
		snapshots: await history.snapshots(),
		changes: await history.changes()
	}));
	// The repository the checkpoints go to, if any, and how many it does not have yet.
	const remote = await getRemoteStatus(project.id);
	return Response.json({ ...result, remote }, { headers: { 'cache-control': 'no-store' } });
};

/** Records the current files as a checkpoint. */
export const POST: RequestHandler = async (event) => {
	const { project, user } = await requireProject(event, 'write');
	const body = (await event.request.json().catch(() => null)) as { message?: unknown } | null;
	const message = validateCheckpointMessage(body?.message);

	const checkpoint = await withHistory(project.id, (history) =>
		history.createCheckpoint(message, authorOf(user))
	).catch(throwAsHttpError);
	return Response.json({ checkpoint }, { status: 201 });
};
