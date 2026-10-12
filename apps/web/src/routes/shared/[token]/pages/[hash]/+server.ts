import { error } from '@sveltejs/kit';
import * as fs from 'node:fs/promises';
import { pagePath } from '#lib/server/compile/jobs.ts';
import { sharedPageProject } from '#lib/server/shares.ts';
import type { RequestHandler } from './$types';

/** One rendered page of a shared project. Served exactly like a page of the preview. */
export const GET: RequestHandler = async (event) => {
	const projectId = await sharedPageProject(event.params.token, event.params.hash);
	const file = projectId && pagePath(projectId, event.params.hash);
	if (!file) error(404, 'Page not found.');

	let content: Buffer;
	try {
		content = await fs.readFile(file);
	} catch {
		error(404, 'This page is no longer stored. Reload to see the current version.');
	}

	return new Response(new Uint8Array(content), {
		headers: {
			'content-type': 'image/svg+xml',
			// Rendered from untrusted documents: never allow it to script or load anything.
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			// The link can be withdrawn, so a page is not kept for long.
			'cache-control': 'private, max-age=300'
		}
	});
};
