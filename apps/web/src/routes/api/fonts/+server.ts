import { listFontFamilies } from '#lib/server/compile/fonts.ts';
import { requireUser } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** Font families installed on this server, for completion in the editor. */
export const GET: RequestHandler = async (event) => {
	requireUser(event);
	return Response.json(
		{ families: await listFontFamilies() },
		{ headers: { 'cache-control': 'private, max-age=600' } }
	);
};
