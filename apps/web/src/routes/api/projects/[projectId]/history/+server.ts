import { authorOf, validateCheckpointMessage, withHistory } from '#lib/server/history/history.ts';
import { requireProject, throwAsHttpError } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Checkpoints of the project, newest first, and what changed since the last one. */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const [checkpoints, changes] = await withHistory(project.id, async (history) => [
		await history.list(),
		await history.changes()
	]);
	return Response.json({ checkpoints, changes }, { headers: { 'cache-control': 'no-store' } });
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
