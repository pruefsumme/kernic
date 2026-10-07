import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/http.ts';
import { getImport } from '#lib/server/imports/imports.ts';
import type { RequestHandler } from './$types';

/** Status of an import, polled while the archive is being checked. */
export const GET: RequestHandler = async (event) => {
	const user = requireUser(event);
	const pending = await getImport(user.id, event.params.importId);
	if (!pending) error(404, 'Import not found.');
	return Response.json({ status: pending.status }, { headers: { 'cache-control': 'no-store' } });
};
