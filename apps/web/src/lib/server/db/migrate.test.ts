import postgres from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from './client';
import { bundledMigrations, migrate, type Migration } from './migrate';

/**
 * These run against a real PostgreSQL, in a schema of their own. They are
 * skipped when the development database is not running.
 */
const databaseUrl =
	process.env.KERNIC_TEST_DATABASE_URL ?? 'postgres://kernic:kernic@127.0.0.1:54329/kernic_test';

const probe = postgres(databaseUrl, { max: 1, connect_timeout: 2, onnotice: () => {} });
const reachable = await probe`SELECT 1`.then(
	() => true,
	() => false
);

const schema = `migrate_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
const connect = () =>
	postgres(databaseUrl, {
		max: 2,
		onnotice: () => {},
		connection: { search_path: schema }
	}) as unknown as Sql;

const first: Migration = { name: '0001_first', sql: 'CREATE TABLE notes (id int PRIMARY KEY)' };
const second: Migration = { name: '0002_second', sql: 'ALTER TABLE notes ADD COLUMN body text' };

describe.skipIf(!reachable)('migrate', () => {
	let sql: Sql;

	beforeEach(async () => {
		await probe.unsafe(`CREATE SCHEMA "${schema}"`);
		sql = connect();
	});

	afterEach(async () => {
		await sql.end();
		await probe.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
	});

	afterAll(() => probe.end());

	const applied = () =>
		sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`.then((rows) =>
			rows.map((row) => row.name)
		);

	it('applies pending migrations in order, once', async () => {
		expect(await migrate(sql, [first])).toEqual(['0001_first']);
		expect(await migrate(sql, [first, second])).toEqual(['0002_second']);
		expect(await migrate(sql, [first, second])).toEqual([]);
		expect(await applied()).toEqual(['0001_first', '0002_second']);
		await sql`INSERT INTO notes (id, body) VALUES (1, 'kept')`;
	});

	it('refuses a migration that was edited after it was applied', async () => {
		await migrate(sql, [first]);
		const edited = { ...first, sql: `${first.sql}; CREATE TABLE sneaky (id int)` };
		await expect(migrate(sql, [edited])).rejects.toThrow(/changed after it was applied/);
	});

	it('refuses to run against a database from a newer version', async () => {
		await migrate(sql, [first, second]);
		await expect(migrate(sql, [first])).rejects.toThrow(/does not know \(0002_second\)/);
	});

	it('leaves the database untouched when a migration fails', async () => {
		await migrate(sql, [first]);
		const broken: Migration = {
			name: '0003_broken',
			sql: 'ALTER TABLE notes ADD COLUMN extra int; SELECT 1 / 0'
		};
		await expect(migrate(sql, [first, second, broken])).rejects.toThrow();

		// Neither the failing migration nor the good one before it in the same run remains.
		expect(await applied()).toEqual(['0001_first']);
		const columns = await sql<{ column_name: string }[]>`
			SELECT column_name FROM information_schema.columns
			WHERE table_schema = ${schema} AND table_name = 'notes'
		`;
		expect(columns.map((column) => column.column_name)).toEqual(['id']);
	});

	it('does not apply a migration twice when two instances start together', async () => {
		const other = connect();
		try {
			const results = await Promise.all([
				migrate(sql, [first, second]),
				migrate(other, [first, second])
			]);
			expect(results.flat().sort()).toEqual(['0001_first', '0002_second']);
		} finally {
			await other.end();
		}
	});

	it('the bundled migrations apply to an empty database', async () => {
		const names = await migrate(sql, bundledMigrations());
		expect(names.length).toBeGreaterThanOrEqual(2);
		expect(names).toEqual([...names].sort());
	});
});
