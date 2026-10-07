import { error } from '@sveltejs/kit';
import * as fs from 'node:fs/promises';
import { requireUser } from '#lib/server/http.ts';
import { getImport, previewPath } from '#lib/server/imports/imports.ts';
import type { RequestHandler } from './$types';

/** First page rendered by the dry-run compile of a staged import. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const pending = await getImport(user.id, event.params.importId);
	if (!pending || pending.status !== 'ready') error(404, 'Preview not found.');

	let content: Buffer;
	try {
		content = await fs.readFile(previewPath(pending.id));
	} catch {
		error(404, 'Preview not found.');
	}
	return new Response(new Uint8Array(content), {
		headers: {
			'content-type': 'image/svg+xml',
			// Rendered from an untrusted document: never allow it to script or load anything.
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'cache-control': 'private, no-store'
		}
	});
};
