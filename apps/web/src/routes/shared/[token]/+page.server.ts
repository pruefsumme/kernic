import { error } from '@sveltejs/kit';
import { RateLimiter } from '#lib/server/auth/rate-limit.ts';
import { openSharedDocument } from '#lib/server/shares.ts';
import type { PageServerLoad } from './$types';

// Links are long random values; this only keeps anyone from trying many.
const lookups = new RateLimiter(120, 10 * 60 * 1000);

/** A project's rendered pages for whoever has the link. No account is involved. */
export const load: PageServerLoad = async (event) => {
	let address = 'unknown';
	try {
		address = event.getClientAddress();
	} catch {
		// not available in every environment
	}
	if (lookups.hit(address) > 0) error(429, 'Too many requests. Try again in a few minutes.');

	const document = await openSharedDocument(event.params.token);
	if (!document) {
		error(404, 'This link is not valid. It may have been withdrawn or have expired.');
	}
	event.setHeaders({ 'cache-control': 'private, no-store' });
	return { document, token: event.params.token };
};
