/**
 * Gives the end-to-end run a clean slate: an empty test database and an empty
 * data directory. Runs before the app server starts.
 */
import { rm } from 'node:fs/promises';
import postgres from 'postgres';
import { dataDir, databaseUrl } from './environment.ts';

const url = new URL(databaseUrl);
const database = url.pathname.slice(1);

// This script drops everything in the database it is pointed at.
if (!database.endsWith('_test')) {
	throw new Error(`Refusing to reset "${database}": the test database name must end in "_test".`);
}

const maintenanceUrl = new URL(databaseUrl);
maintenanceUrl.pathname = '/postgres';
const maintenance = postgres(maintenanceUrl.href, { max: 1, onnotice: () => {} });
const [existing] = await maintenance`SELECT 1 FROM pg_database WHERE datname = ${database}`;
if (!existing) await maintenance.unsafe(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
await maintenance.end();

const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
await sql.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await sql.end();

// The worker's directory is left alone: the worker is already running, and its
// cache is addressed by content hash, so stale entries are harmless.
await rm(dataDir, { recursive: true, force: true });
