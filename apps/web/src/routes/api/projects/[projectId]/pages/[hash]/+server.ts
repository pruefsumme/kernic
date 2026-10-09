import { error } from '@sveltejs/kit';
import * as fs from 'node:fs/promises';
import { pagePath } from '#lib/server/compile/jobs.ts';
import { requireProject } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * Serves one rendered page as SVG, addressed by the hash of its content. The
 * address of a page only changes when the page does, so the browser fetches a
 * page of a long document again only after an edit that affected it.
 */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const file = pagePath(project.id, event.params.hash);
	if (!file) error(404, 'Page not found.');

	let content: Buffer;
	try {
		content = await fs.readFile(file);
	} catch {
		error(404, 'This page is no longer stored. Compile again to refresh the preview.');
	}

	return new Response(new Uint8Array(content), {
		headers: {
			'content-type': 'image/svg+xml',
			// Rendered from untrusted documents: never allow it to script or load anything.
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
};
