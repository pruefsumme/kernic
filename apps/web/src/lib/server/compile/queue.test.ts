import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../db/client';
import { bundledMigrations, migrate } from '../db/migrate';
import { claimNextJob, pendingJobsOf } from './queue';

const databaseUrl =
	process.env.KERNIC_TEST_DATABASE_URL ?? 'postgres://kernic:kernic@127.0.0.1:54329/kernic_test';

const probe = postgres(databaseUrl, { max: 1, onnotice: () => {}, connect_timeout: 3 });
const reachable = await probe`SELECT 1`.then(
	() => true,
	() => false
);
await probe.end({ timeout: 1 });
if (!reachable && process.env.CI) {
	throw new Error(`The test database at ${databaseUrl} is not reachable.`);
}

const schema = `queue_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

describe.skipIf(!reachable)('the compile queue', () => {
	let sql: Sql;
	let ada: string;
	let lin: string;
	let project: string;

	beforeAll(async () => {
		const setup = postgres(databaseUrl, { max: 1, onnotice: () => {} });
		await setup.unsafe(`CREATE SCHEMA "${schema}"`);
		await setup.end();
		sql = postgres(databaseUrl, {
			max: 4,
			onnotice: () => {},
			connection: { search_path: schema },
			types: {
				bigint: { to: 20, from: [20], serialize: String, parse: Number }
			}
		}) as unknown as Sql;
		await migrate(sql, bundledMigrations());

		const person = async (email: string) =>
			(
				await sql<{ id: string }[]>`
					INSERT INTO users (email, display_name, password_hash)
					VALUES (${email}, ${email}, 'x') RETURNING id
				`
			)[0]!.id;
		ada = await person('ada@example.org');
		lin = await person('lin@example.org');
		const [workspace] = await sql<{ id: string }[]>`
			INSERT INTO workspaces (name, kind) VALUES ('Shared', 'team') RETURNING id
		`;
		project = (
			await sql<{ id: string }[]>`
				INSERT INTO projects (workspace_id, name, entry_path)
				VALUES (${workspace!.id}, 'Project', 'main.typ') RETURNING id
			`
		)[0]!.id;
	});

	afterAll(async () => {
		await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
		await sql.end();
	});

	beforeEach(() => sql`DELETE FROM compile_jobs`);

	/** Queues a job; `age` puts its creation that many seconds into the past. */
	const queue = async (user: string | null, age: number, status = 'queued') =>
		(
			await sql<{ id: string }[]>`
				INSERT INTO compile_jobs (project_id, requested_by, format, status, created_at)
				VALUES (${project}, ${user}, 'svg', ${status}, now() - make_interval(secs => ${age}))
				RETURNING id
			`
		)[0]!.id;

	it('hands out the job that has waited longest when nobody is compiling', async () => {
		const newer = await queue(ada, 5);
		const older = await queue(lin, 10);
		expect(await claimNextJob(sql)).toBe(older);
		expect(await claimNextJob(sql)).toBe(newer);
		expect(await claimNextJob(sql)).toBeNull();
	});

	it('lets an account that has nothing running go before one that has', async () => {
		await queue(ada, 30, 'running');
		const adaWaiting = await queue(ada, 20);
		const linWaiting = await queue(lin, 1);
		// Lin's job is newer, but Ada already has a compile running.
		expect(await claimNextJob(sql)).toBe(linWaiting);
		expect(await claimNextJob(sql)).toBe(adaWaiting);
	});

	it('serves several accounts in turn', async () => {
		const adaJobs = [await queue(ada, 40), await queue(ada, 39), await queue(ada, 38)];
		const linJob = await queue(lin, 10);
		// Ada queued three before Lin queued one: Lin still gets the second slot.
		expect(await claimNextJob(sql)).toBe(adaJobs[0]);
		expect(await claimNextJob(sql)).toBe(linJob);
		expect(await claimNextJob(sql)).toBe(adaJobs[1]);
	});

	it('never hands the same job out twice', async () => {
		for (let index = 0; index < 6; index++) await queue(index % 2 ? ada : lin, index);
		const claimed = await Promise.all(Array.from({ length: 10 }, () => claimNextJob(sql)));
		const ids = claimed.filter((id): id is string => id !== null);
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(6);
	});

	it('counts what an account has waiting and running', async () => {
		await queue(ada, 3);
		await queue(ada, 2, 'running');
		await queue(ada, 1, 'succeeded');
		await queue(lin, 1);
		expect(await pendingJobsOf(sql, ada)).toBe(2);
		expect(await pendingJobsOf(sql, lin)).toBe(1);
	});
});
