import { DATABASE_URL } from '$app/env/private';
import postgres from 'postgres';

/**
 * Shared connection pool. postgres.js connects lazily, so importing this module
 * does not open a connection. Always pass values through the tagged template so
 * they are sent as parameters.
 */
const connect = () =>
	postgres(DATABASE_URL, {
		max: 10,
		// Connections nobody uses are closed again instead of being held for good.
		idle_timeout: 120,
		onnotice: () => {},
		types: {
			// Return bigint columns as numbers; revisions and counts stay far below 2^53.
			bigint: {
				to: 20,
				from: [20],
				serialize: (value: number) => String(value),
				parse: (value: string) => Number(value)
			}
		}
	});

// The development server evaluates this module again after every change to
// server code. Keeping the pool on the global object makes those reloads share
// it; each would otherwise leave its connections open until the database
// refuses new ones.
const shared = globalThis as { kernicSql?: ReturnType<typeof connect> };
export const sql = (shared.kernicSql ??= connect());

export type Sql = typeof sql;
/** The handle passed to `sql.begin` callbacks; queries on it run inside the transaction. */
export type Transaction = postgres.TransactionSql<{ bigint: number }>;
