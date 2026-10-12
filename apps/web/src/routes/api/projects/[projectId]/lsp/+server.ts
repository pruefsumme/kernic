import { openLanguageConnection } from '#lib/server/compile/language.ts';
import { WorkerRefusedError, WorkerUnavailableError } from '#lib/server/compile/worker-client.ts';
import { requireProject } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * Opens a connection to a language server for one editor. Reading the project
 * is enough: the server works on a copy and changes nothing.
 */
export const POST: RequestHandler = async (event) => {
	const { project, user } = await requireProject(event, 'read');
	try {
		const { id, jump } = await openLanguageConnection({
			userId: user.id,
			projectId: project.id,
			entryPath: project.entryPath
		});
		return Response.json({ id, rootUri: 'file:///project', jump });
	} catch (cause) {
		// Assistance is an extra: the editor carries on without it and says why.
		if (cause instanceof WorkerRefusedError || cause instanceof WorkerUnavailableError) {
			return Response.json({ unavailable: cause.message }, { status: 503 });
		}
		throw cause;
	}
};
