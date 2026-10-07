import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/http.ts';
import { maxArchiveBytes, startImport } from '#lib/server/imports/imports.ts';
import { canWrite, getWorkspaceRole } from '#lib/server/projects/projects.ts';
import type { RequestHandler } from './$types';

/**
 * Uploads a ZIP archive for import. The request body is the archive itself, so
 * it is written to disk as it arrives rather than buffered in memory. Responds
 * with the id of the import, whose analysis continues in the background.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireUser(event);
	const workspaceId = event.url.searchParams.get('workspace') ?? '';
	const role = await getWorkspaceRole(user.id, workspaceId);
	if (!role || !canWrite(role)) error(403, 'You cannot create projects in that workspace.');

	const declared = Number(event.request.headers.get('content-length') ?? '0');
	if (declared > maxArchiveBytes) {
		error(413, 'The archive is larger than this server accepts.', { code: 'file-too-large' });
	}
	if (!event.request.body) error(400, 'The request has no archive attached.');

	const id = await startImport({
		userId: user.id,
		workspaceId,
		sourceName: event.url.searchParams.get('name') ?? '',
		body: event.request.body
	});
	return Response.json({ id }, { status: 202 });
};
