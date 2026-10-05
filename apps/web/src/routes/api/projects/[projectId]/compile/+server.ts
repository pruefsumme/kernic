import { error } from '@sveltejs/kit';
import { requestCompile } from '#lib/server/compile/jobs.ts';
import { requireProject } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Queues a compile of the project's current files and returns the job. */
export const POST: RequestHandler = async (event) => {
	const { project, user } = await requireProject(event, 'read');
	const body = (await event.request.json().catch(() => null)) as { format?: unknown } | null;
	const format = body?.format ?? 'svg';
	if (format !== 'svg' && format !== 'pdf') error(400, 'format must be "svg" or "pdf".');

	const job = await requestCompile({ projectId: project.id, userId: user.id, format });
	return Response.json({ job }, { status: 202 });
};
