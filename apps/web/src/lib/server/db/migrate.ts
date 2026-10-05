import { createHash } from 'node:crypto';
import type { Sql } from './client';

export interface Migration {
	name: string;
	sql: string;
}

// Arbitrary constant; serializes migration runs across app instances.
const MIGRATION_LOCK_ID = 4_815_162_342;

function checksum(content: string): string {
	return createHash('sha256').update(content).digest('hex');
}

/** Migrations bundled with this build, in the order they must be applied. */
export function bundledMigrations(): Migration[] {
	const modules = import.meta.glob<string>('./migrations/*.sql', {
		query: '?raw',
		import: 'default',
		eager: true
	});
	return Object.entries(modules)
		.map(([file, content]) => ({
			name: file
				.split('/')
				.at(-1)!
				.replace(/\.sql$/, ''),
			sql: content
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Applies pending migrations. Migrations are forward-only: an applied migration
 * must never be edited, and a database that is newer than this build is refused
 * rather than guessed at.
 */
export async function migrate(sql: Sql, migrations: Migration[]): Promise<string[]> {
	const applied: string[] = [];

	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
		await tx`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				name text PRIMARY KEY,
				checksum text NOT NULL,
				applied_at timestamptz NOT NULL DEFAULT now()
			)
		`;

		const rows = await tx<{ name: string; checksum: string }[]>`
			SELECT name, checksum FROM schema_migrations
		`;
		const known = new Map(rows.map((row) => [row.name, row.checksum]));
		const bundled = new Set(migrations.map((migration) => migration.name));

		const unknown = [...known.keys()].filter((name) => !bundled.has(name));
		if (unknown.length > 0) {
			throw new Error(
				`The database has migrations this version does not know (${unknown.join(', ')}). ` +
					'It was probably migrated by a newer release; downgrades are not supported.'
			);
		}

		for (const migration of migrations) {
			const recorded = known.get(migration.name);
			if (recorded !== undefined) {
				if (recorded !== checksum(migration.sql)) {
					throw new Error(
						`Migration ${migration.name} was changed after it was applied. ` +
							'Add a new migration instead of editing an existing one.'
					);
				}
				continue;
			}

			await tx.unsafe(migration.sql);
			await tx`
				INSERT INTO schema_migrations (name, checksum)
				VALUES (${migration.name}, ${checksum(migration.sql)})
			`;
			applied.push(migration.name);
		}
	});

	return applied;
}
