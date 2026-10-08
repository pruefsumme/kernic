import { Readable } from 'node:stream';
import { withHistory } from '#lib/server/history/history.ts';
import { attachment, requireProject, throwAsHttpError } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Downloads the project's files as they were at a checkpoint, as a ZIP archive. */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const id = event.params.checkpointId;
	const stream = await withHistory(project.id, (history) => history.archive(id)).catch(
		throwAsHttpError
	);

	return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': attachment(`${project.name} (${id.slice(0, 8)})`, 'zip'),
			'cache-control': 'private, no-store'
		}
	});
};
