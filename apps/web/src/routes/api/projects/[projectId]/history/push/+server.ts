import { error } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { NothingToPushError, RemoteError } from '#lib/server/history/git.ts';
import {
	getRemoteStatus,
	pushProject,
	RemoteUnavailableError
} from '#lib/server/history/remotes.ts';
import { requireProject } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Pushes the project's checkpoints to the repository it is connected to. */
export const POST: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'write');
	try {
		await pushProject(project.id);
	} catch (cause) {
		if (cause instanceof NothingToPushError) error(400, cause.message);
		if (cause instanceof RemoteUnavailableError) error(409, cause.message);
		// The forge said no, or could not be reached: not this server's failure, and not the browser's.
		if (cause instanceof RemoteError) {
			error(cause.kind === 'diverged' ? 409 : 502, cause.message, { code: cause.kind });
		}
		throw cause;
	}
	await recordAudit(event, 'project.pushed', { subject: project.name });
	return Response.json({ remote: await getRemoteStatus(project.id) });
};
