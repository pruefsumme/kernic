import { error } from '@sveltejs/kit';
import { requestCompile } from '#lib/server/compile/jobs.ts';
import { requireProject } from '#lib/server/http.ts';
import {
	isDefaultPdfOptions,
	parsePdfOptions,
	PdfOptionsError,
	type PdfOptions
} from '#lib/pdf-options.ts';
import type { RequestHandler } from './$types';

/** Queues a compile of the project's current files and returns the job. */
export const POST: RequestHandler = async (event) => {
	const { project, user } = await requireProject(event, 'read');
	const body = (await event.request.json().catch(() => null)) as {
		format?: unknown;
		options?: unknown;
	} | null;
	const format = body?.format ?? 'svg';
	if (format !== 'svg' && format !== 'pdf') error(400, 'format must be "svg" or "pdf".');

	let options: PdfOptions | null = null;
	if (body?.options !== undefined && body.options !== null) {
		if (format !== 'pdf') error(400, 'Export options only apply to a PDF.');
		try {
			options = parsePdfOptions(body.options);
		} catch (cause) {
			if (cause instanceof PdfOptionsError) error(400, cause.message);
			throw cause;
		}
		// The same as no options; stored as such, so that such exports coalesce.
		if (isDefaultPdfOptions(options)) options = null;
	}

	const job = await requestCompile({ projectId: project.id, userId: user.id, format, options });
	return Response.json({ job }, { status: 202 });
};
