import { DATABASE_URL } from '$app/env/private';
import postgres from 'postgres';

/**
 * Shared connection pool. postgres.js connects lazily, so importing this module
 * does not open a connection. Always pass values through the tagged template so
 * they are sent as parameters.
 */
export const sql = postgres(DATABASE_URL, {
	max: 10,
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

export type Sql = typeof sql;
/** The handle passed to `sql.begin` callbacks; queries on it run inside the transaction. */
export type Transaction = postgres.TransactionSql<{ bigint: number }>;
