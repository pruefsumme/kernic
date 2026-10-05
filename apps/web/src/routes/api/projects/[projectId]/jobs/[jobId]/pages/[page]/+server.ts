import { error } from '@sveltejs/kit';
import * as fs from 'node:fs/promises';
import { getJob, pageArtifactPath } from '#lib/server/compile/jobs.ts';
import { requireProject } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Serves one rendered page of a preview job as SVG. */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const job = await getJob(project.id, event.params.jobId);
	const pagePath = job && pageArtifactPath(job, Number(event.params.page));
	if (!pagePath) error(404, 'Page not found.');

	let content: Buffer;
	try {
		content = await fs.readFile(pagePath);
	} catch {
		error(404, 'This preview is no longer stored. Compile again to refresh it.');
	}

	return new Response(new Uint8Array(content), {
		headers: {
			'content-type': 'image/svg+xml',
			// Rendered from untrusted documents: never allow it to script or load anything.
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			// A job's output never changes, so the browser may keep it.
			'cache-control': 'private, max-age=31536000, immutable'
		}
	});
};
