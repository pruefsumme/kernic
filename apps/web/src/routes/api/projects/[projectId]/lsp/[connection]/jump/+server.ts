import { error } from '@sveltejs/kit';
import {
	findLanguageConnection,
	locatePlace,
	sourceOfPlace
} from '#lib/server/compile/language.ts';
import { WorkerUnavailableError } from '#lib/server/compile/worker-client.ts';
import { requireProject } from '#lib/server/http.ts';
import { InvalidPathError, normalizeProjectPath } from '#lib/server/projects/paths.ts';
import type { RequestHandler } from './$types';

const finite = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

const MAX_NEARBY_PLACES = 16;

/** Places to fall back on, as the editor names them; anything else is a bad request. */
function parseNearby(value: unknown): { line: number; character: number }[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_NEARBY_PLACES) {
		error(400, `Expected at most ${MAX_NEARBY_PLACES} places nearby.`);
	}
	return value.map((entry: { line?: unknown; character?: unknown } | null) => {
		if (!finite(entry?.line) || !finite(entry.character)) {
			error(400, 'Expected a line and a character for each place nearby.');
		}
		return { line: entry.line, character: entry.character };
	});
}

/**
 * Jumps between the source and the rendered pages: either "where on the pages
 * is this place of the source" (`{ path, line, character, nearby? }`, where
 * `nearby` are places to answer for instead if that one prints nothing) or
 * "which place of the source is at this point of a page" (`{ page, x, y }`, in points).
 */
export const POST: RequestHandler = async (event) => {
	const { project, user } = await requireProject(event, 'read');
	const connection = findLanguageConnection(event.params.connection, user.id, project.id);
	if (!connection) error(404, 'This editor assistance connection has ended.');

	const body = (await event.request.json().catch(() => null)) as Record<string, unknown> | null;
	try {
		if (body && 'path' in body) {
			if (!finite(body.line) || !finite(body.character))
				error(400, 'Expected a line and a character.');
			const path = normalizeProjectPath(body.path);
			const positions = await locatePlace(
				connection,
				{ path, line: body.line, character: body.character },
				parseNearby(body.nearby)
			);
			return Response.json({ positions });
		}
		if (body && finite(body.page) && finite(body.x) && finite(body.y)) {
			const source = await sourceOfPlace(connection, { page: body.page, x: body.x, y: body.y });
			return Response.json({ source });
		}
	} catch (cause) {
		if (cause instanceof InvalidPathError) error(400, cause.message);
		// Jumps are a convenience; without the worker there simply is no answer.
		if (cause instanceof WorkerUnavailableError)
			return Response.json({ positions: [], source: null });
		throw cause;
	}
	error(400, 'Expected a place in the source or a point on a page.');
};
