import { error } from '@sveltejs/kit';
import * as fs from 'node:fs/promises';
import { getJob, pdfArtifactPath } from '#lib/server/compile/jobs.ts';
import { attachment, requireProject } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Downloads the PDF produced by an export job. */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const job = await getJob(project.id, event.params.jobId);
	const pdfPath = job && pdfArtifactPath(job);
	if (!pdfPath) error(404, 'PDF not found.');

	let content: Buffer;
	try {
		content = await fs.readFile(pdfPath);
	} catch {
		error(404, 'This export is no longer stored. Export again to create a new PDF.');
	}

	return new Response(new Uint8Array(content), {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': attachment(project.name, 'pdf'),
			'cache-control': 'private, no-store'
		}
	});
};
