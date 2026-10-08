import { error } from '@sveltejs/kit';
import { MAX_EDITABLE_BYTES, projectTreeDir, treeLimits } from '#lib/server/config.ts';
import { readBody, requireProject, throwAsHttpError } from '#lib/server/http.ts';
import { responseHeadersFor } from '#lib/server/projects/content-types.ts';
import { withProjectLock } from '#lib/server/projects/lock.ts';
import { bumpRevision } from '#lib/server/projects/projects.ts';
import { deleteTreeEntry, readTreeFile, sha256, writeTreeFile } from '#lib/server/projects/tree.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');

	const content = await readTreeFile(projectTreeDir(project.id), event.params.path).catch(
		throwAsHttpError
	);

	return new Response(new Uint8Array(content), {
		headers: {
			...responseHeadersFor(event.params.path, content),
			// The editor sends this hash back when saving, to detect concurrent changes.
			'x-kernic-hash': sha256(content),
			'cache-control': 'private, no-cache'
		}
	});
};

/**
 * Saves a file. `x-kernic-base-hash` carries the hash of the content the client
 * started from (`none` for a file it believes is new); the write is refused
 * with 409 if the stored file differs, so no change is overwritten silently.
 */
export const PUT: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'write');

	const baseHeader = event.request.headers.get('x-kernic-base-hash');
	if (baseHeader !== null && baseHeader !== 'none' && !/^[0-9a-f]{64}$/.test(baseHeader)) {
		error(400, 'Invalid x-kernic-base-hash header.');
	}
	const baseHash = baseHeader === null ? undefined : baseHeader === 'none' ? null : baseHeader;

	const content = await readBody(event.request, treeLimits.maxFileBytes);
	// Saves from the editor are text; the larger general limit applies to uploads only.
	if (
		event.request.headers.get('x-kernic-source') === 'editor' &&
		content.byteLength > MAX_EDITABLE_BYTES
	) {
		error(413, 'This file is too large to edit in the browser.', { code: 'file-too-large' });
	}

	const hash = await withProjectLock(project.id, () =>
		writeTreeFile(projectTreeDir(project.id), event.params.path, content, {
			limits: treeLimits,
			baseHash
		})
	).catch(throwAsHttpError);

	return Response.json({ hash, revision: await bumpRevision(project.id) });
};

export const DELETE: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'write');
	await withProjectLock(project.id, () =>
		deleteTreeEntry(projectTreeDir(project.id), event.params.path)
	).catch(throwAsHttpError);
	return Response.json({ revision: await bumpRevision(project.id) });
};
