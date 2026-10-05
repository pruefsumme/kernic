import { error } from '@sveltejs/kit';
import { getJob, waitForJob } from '#lib/server/compile/jobs.ts';
import { requireProject } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

const LONG_POLL_MS = 25_000;

/**
 * Returns a compile job. With `?wait=1` the response is held until the job
 * finishes (or a timeout passes), so the editor learns about the result without
 * polling in a tight loop.
 */
export const GET: RequestHandler = async (event) => {
	const { project } = await requireProject(event, 'read');
	const job = event.url.searchParams.has('wait')
		? await waitForJob(project.id, event.params.jobId, LONG_POLL_MS)
		: await getJob(project.id, event.params.jobId);
	if (!job) error(404, 'Compile job not found.');

	return Response.json({ job }, { headers: { 'cache-control': 'no-store' } });
};
