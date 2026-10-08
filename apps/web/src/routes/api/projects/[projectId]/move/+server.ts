import { error } from '@sveltejs/kit';
import { projectTreeDir } from '#lib/server/config.ts';
import { requireProject, throwAsHttpError } from '#lib/server/http.ts';
import { normalizeProjectPath } from '#lib/server/projects/paths.ts';
import { withProjectLock } from '#lib/server/projects/lock.ts';
import { bumpRevision } from '#lib/server/projects/projects.ts';
import { moveTreeEntry } from '#lib/server/projects/tree.ts';
import { sql } from '#lib/server/db/client.ts';
import type { RequestHandler } from './$types';

/** Renames or moves a file or folder. Never overwrites an existing entry. */
export const POST: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'write');
	const body = (await event.request.json().catch(() => null)) as {
		from?: unknown;
		to?: unknown;
	} | null;
	if (!body) error(400, 'Expected a JSON body with "from" and "to".');

	let entryPath = project.entryPath;
	try {
		const from = normalizeProjectPath(body.from);
		const to = normalizeProjectPath(body.to);
		await withProjectLock(project.id, () => moveTreeEntry(projectTreeDir(project.id), from, to));

		// Keep the main file pointing at the same document when it, or a folder above it, moves.
		if (entryPath === from) entryPath = to;
		else if (entryPath.startsWith(`${from}/`)) entryPath = to + entryPath.slice(from.length);
	} catch (cause) {
		throwAsHttpError(cause);
	}

	if (entryPath !== project.entryPath) {
		await sql`UPDATE projects SET entry_path = ${entryPath} WHERE id = ${project.id}`;
	}
	return Response.json({ revision: await bumpRevision(project.id), entryPath });
};
