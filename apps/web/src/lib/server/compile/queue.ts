import type { Sql } from '../db/client';

/**
 * Which compile runs next. The queue is shared by everyone on the server, so
 * it serves accounts in turn rather than strictly first come, first served:
 * whoever has the fewest compiles running goes first, and among those the job
 * that has waited longest. One account with many projects cannot hold up the
 * others for longer than the compiles that are already running.
 */

/**
 * Claims the next queued job by marking it as running. Returns its id, or null
 * if nothing is waiting. Safe to call from several places at once: a job is
 * handed out only once.
 */
export async function claimNextJob(db: Sql): Promise<string | null> {
	const [claimed] = await db<{ id: string }[]>`
		UPDATE compile_jobs
		SET status = 'running', started_at = now()
		WHERE id = (
			SELECT waiting.id
			FROM compile_jobs waiting
			LEFT JOIN LATERAL (
				SELECT count(*) AS count
				FROM compile_jobs running
				WHERE running.status = 'running'
					AND running.requested_by IS NOT DISTINCT FROM waiting.requested_by
			) busy ON true
			WHERE waiting.status = 'queued'
			ORDER BY busy.count, waiting.created_at
			LIMIT 1
			FOR UPDATE OF waiting SKIP LOCKED
		)
		RETURNING id
	`;
	return claimed?.id ?? null;
}

/** Compiles of one account that are waiting or running. */
export async function pendingJobsOf(db: Sql, userId: string): Promise<number> {
	const [row] = await db<{ count: number }[]>`
		SELECT count(*)::int AS count FROM compile_jobs
		WHERE requested_by = ${userId} AND status IN ('queued', 'running')
	`;
	return row!.count;
}
