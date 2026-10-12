/**
 * Migration check: the built app is started against databases it must not
 * use, and against one it can.
 *
 * What must hold:
 * - on an empty database the app migrates and serves, and what it recorded is
 *   exactly the set of migrations bundled with it;
 * - a database that was migrated by a newer release is refused: the app stops
 *   with an explanation, serves nothing and writes nothing;
 * - a migration that was edited after it was applied is refused the same way;
 * - after the cause is removed, the same database starts normally again, so a
 *   refusal never leaves it in a state that needs repair.
 *
 * The unit tests show this for the function that migrates; this shows it for
 * the app as it is started in a container.
 *
 * Run with `pnpm test:migrations` (needs the test database server, like the
 * end-to-end tests).
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import postgres from 'postgres';

const run = promisify(execFile);
const port = 5188;
const base = `http://localhost:${port}`;
const dataDir = path.join(tmpdir(), 'kernic-migrations-data');
const databaseUrl =
	process.env.KERNIC_MIGRATIONS_DATABASE_URL ??
	'postgres://kernic:kernic@127.0.0.1:54329/kernic_migrations_test';
const web = path.join(import.meta.dirname, '..');
const migrationsDir = path.join(web, 'src/lib/server/db/migrations');

const appEnv = {
	...process.env,
	PORT: String(port),
	HOST: '127.0.0.1',
	PROTOCOL_HEADER: 'x-forwarded-proto',
	DATABASE_URL: databaseUrl,
	KERNIC_DATA_DIR: dataDir,
	KERNIC_SETUP_TOKEN: 'migrations-setup-token',
	KERNIC_PACKAGE_REGISTRY: 'off',
	// Nothing is compiled here; no worker runs.
	KERNIC_WORKER_URL: 'http://127.0.0.1:9',
	KERNIC_WORKER_TOKEN: 'migrations-worker-token-0123456789'
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const problems: string[] = [];
const expect = (condition: boolean, message: string) => {
	if (!condition) problems.push(message);
};

interface Outcome {
	/** Whether the app answered /healthz before it stopped. */
	served: boolean;
	/** Null while the app is still running. */
	exitCode: number | null;
	log: string;
}

let app: ChildProcess | null = null;

/** Starts the app and waits until it either serves or stops. */
async function start(): Promise<Outcome> {
	const child = spawn('node', ['build'], {
		cwd: web,
		env: appEnv,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	child.stdout!.on('data', (chunk: Buffer) => (log += chunk));
	child.stderr!.on('data', (chunk: Buffer) => (log += chunk));
	app = child;
	// A refused start must end by itself; a started one answers within seconds.
	for (let attempt = 0; attempt < 400; attempt++) {
		if (child.exitCode !== null) return { served: false, exitCode: child.exitCode, log };
		const up = await fetch(`${base}/healthz`).then(
			(response) => response.ok,
			() => false
		);
		if (up) return { served: true, exitCode: null, log };
		await sleep(50);
	}
	return { served: false, exitCode: child.exitCode, log };
}

async function stop(): Promise<void> {
	const child = app;
	app = null;
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	child.kill('SIGTERM');
	const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
	await exited;
	clearTimeout(timeout);
}

// --- A fresh database and data directory. ---

await rm(dataDir, { recursive: true, force: true });
await run('node', ['e2e/reset.ts'], {
	cwd: web,
	env: { ...process.env, KERNIC_TEST_DATABASE_URL: databaseUrl }
});
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });

/** Everything that identifies the state of the schema, to see that a refusal changed nothing. */
async function snapshot(): Promise<string> {
	const migrations =
		await sql`SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name`;
	const tables = await sql`
		SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1
	`;
	return JSON.stringify({ migrations, tables });
}

try {
	// 1. An empty database is migrated, and nothing else is recorded.
	const bundled = (await readdir(migrationsDir))
		.filter((file) => file.endsWith('.sql'))
		.map((file) => file.replace(/\.sql$/, ''))
		.sort();
	const first = await start();
	expect(first.served, `an empty database: the app did not start.\n${first.log.slice(-1500)}`);
	expect(
		/Applied database migrations: /.test(first.log),
		'an empty database: the app did not report applying its migrations'
	);
	await stop();
	const applied = (
		await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`
	).map((row) => row.name);
	expect(
		JSON.stringify(applied) === JSON.stringify(bundled),
		`an empty database: recorded ${applied.join(', ')}, but the app bundles ${bundled.join(', ')}`
	);

	// 2. A database migrated by a newer release is refused, and left as it was.
	await sql`INSERT INTO schema_migrations (name, checksum) VALUES ('9999_from_a_newer_release', 'x')`;
	const before = await snapshot();
	const newer = await start();
	expect(!newer.served, 'newer database: the app served although the database is newer');
	expect(
		newer.exitCode !== null && newer.exitCode !== 0,
		`newer database: the app should stop with an error, exit code was ${newer.exitCode}`
	);
	expect(
		newer.log.includes('downgrades are not supported') &&
			newer.log.includes('9999_from_a_newer_release'),
		`newer database: the refusal does not explain itself.\n${newer.log.slice(-1500)}`
	);
	await stop();
	expect((await snapshot()) === before, 'newer database: the refused start changed the database');
	await sql`DELETE FROM schema_migrations WHERE name = '9999_from_a_newer_release'`;

	// 3. A migration edited after it was applied is refused, and left as it was.
	const edited = bundled[0]!;
	await sql`UPDATE schema_migrations SET checksum = 'edited-' || checksum WHERE name = ${edited}`;
	const beforeEdit = await snapshot();
	const changed = await start();
	expect(!changed.served, 'edited migration: the app served although a migration was edited');
	expect(
		changed.exitCode !== null && changed.exitCode !== 0,
		`edited migration: the app should stop with an error, exit code was ${changed.exitCode}`
	);
	expect(
		changed.log.includes('was changed after it was applied') && changed.log.includes(edited),
		`edited migration: the refusal does not explain itself.\n${changed.log.slice(-1500)}`
	);
	await stop();
	expect(
		(await snapshot()) === beforeEdit,
		'edited migration: the refused start changed the database'
	);
	await sql`UPDATE schema_migrations SET checksum = substr(checksum, 8) WHERE name = ${edited}`;

	// 4. With the cause gone, the same database starts as if nothing had happened.
	const again = await start();
	expect(again.served, `after the refusals: the app did not start.\n${again.log.slice(-1500)}`);
	expect(
		!/Applied database migrations: /.test(again.log),
		'after the refusals: the app applied migrations again'
	);
	await stop();
} finally {
	await stop();
	await sql.end();
	await rm(dataDir, { recursive: true, force: true });
}

if (problems.length > 0) {
	console.error(`\n${problems.length} problems:\n${problems.join('\n')}`);
	process.exit(1);
}
console.log(
	'An empty database is migrated; a newer database and an edited migration are refused with an ' +
		'explanation and without a change; the same database starts again once the cause is gone.'
);
