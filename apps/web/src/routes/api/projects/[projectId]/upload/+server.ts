import { error } from '@sveltejs/kit';
import { projectTreeDir, treeLimits } from '#lib/server/config.ts';
import { requireProject } from '#lib/server/http.ts';
import { InvalidPathError, normalizeProjectPath } from '#lib/server/projects/paths.ts';
import { bumpRevision } from '#lib/server/projects/projects.ts';
import { TreeError, writeTreeFile } from '#lib/server/projects/tree.ts';
import type { RequestHandler } from './$types';

const MAX_FILES_PER_UPLOAD = 50;

/**
 * Uploads files into a folder of the project. Existing files are never
 * replaced: each file is reported individually as stored or skipped, with the
 * reason, so a partial upload is visible to the user.
 */
export const POST: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'write');

	// Reject oversized requests before parsing the multipart body into memory.
	const declared = Number(event.request.headers.get('content-length') ?? '0');
	if (declared > treeLimits.maxProjectBytes) error(413, 'The upload is too large.');

	const form = await event.request.formData().catch(() => null);
	if (!form) error(400, 'Expected a multipart form upload.');

	const directory = String(form.get('directory') ?? '').replace(/^\/+|\/+$/g, '');
	const files = form.getAll('files').filter((value): value is File => value instanceof File);
	if (files.length === 0) error(400, 'No files were uploaded.');
	if (files.length > MAX_FILES_PER_UPLOAD) {
		error(400, `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.`);
	}

	const root = projectTreeDir(project.id);
	const results: { name: string; path?: string; stored: boolean; message?: string }[] = [];

	for (const file of files) {
		try {
			const target = normalizeProjectPath(directory ? `${directory}/${file.name}` : file.name);
			if (file.size > treeLimits.maxFileBytes) {
				throw new TreeError('file-too-large', 'The file is larger than this server allows.');
			}
			await writeTreeFile(root, target, new Uint8Array(await file.arrayBuffer()), {
				limits: treeLimits,
				baseHash: null
			});
			results.push({ name: file.name, path: target, stored: true });
		} catch (cause) {
			if (cause instanceof TreeError || cause instanceof InvalidPathError) {
				const message =
					cause instanceof TreeError && cause.code === 'conflict'
						? 'A file with this name already exists. Rename or delete it first.'
						: cause.message;
				results.push({ name: file.name, stored: false, message });
			} else {
				throw cause;
			}
		}
	}

	const revision = results.some((result) => result.stored)
		? await bumpRevision(project.id)
		: project.revision;
	return Response.json({ results, revision });
};
