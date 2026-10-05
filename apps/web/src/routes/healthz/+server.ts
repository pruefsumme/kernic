import { workerHealth } from '#lib/server/compile/worker-client.ts';
import { sql } from '#lib/server/db/client.ts';
import type { RequestHandler } from './$types';

/** Readiness probe: the app is useful only if it can reach its database. */
export const GET: RequestHandler = async () => {
	let database = true;
	try {
		await sql`SELECT 1`;
	} catch {
		database = false;
	}
	const worker = await workerHealth();

	return Response.json(
		{ ok: database, database, worker: worker.ok, typstVersion: worker.typstVersion ?? null },
		{ status: database ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
