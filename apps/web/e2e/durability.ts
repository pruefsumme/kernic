/**
 * Durability check: the app is killed (SIGKILL) again and again while files
 * are being saved and checkpoints created, and after every kill the files on
 * disk, the Git history and a restarted app are examined.
 *
 * What must hold after each kill:
 * - every file is complete: either the content before a save or the whole new
 *   content, never an empty or half-written file;
 * - every save the server acknowledged is on disk;
 * - the project's Git repository passes `git fsck`;
 * - the restarted app serves the same content, accepts a new save and can
 *   create a checkpoint.
 *
 * A killed process is not a power cut: what the operating system had already
 * accepted is still written. This checks the app's own ordering of steps.
 *
 * Run with `pnpm test:durability` (needs the test database, like the
 * end-to-end tests). KERNIC_DURABILITY_ROUNDS sets the number of kills.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { admin } from './environment.ts';

const run = promisify(execFile);
const rounds = Number(process.env.KERNIC_DURABILITY_ROUNDS ?? 25);
const port = 5187;
const base = `http://localhost:${port}`;
const dataDir = path.join(tmpdir(), 'kernic-durability-data');
const databaseUrl =
	process.env.KERNIC_DURABILITY_DATABASE_URL ??
	'postgres://kernic:kernic@127.0.0.1:54329/kernic_durability_test';
const setupToken = 'durability-setup-token';
const web = path.join(import.meta.dirname, '..');

const appEnv = {
	...process.env,
	PORT: String(port),
	HOST: '127.0.0.1',
	PROTOCOL_HEADER: 'x-forwarded-proto',
	BODY_SIZE_LIMIT: '64M',
	DATABASE_URL: databaseUrl,
	KERNIC_DATA_DIR: dataDir,
	KERNIC_SETUP_TOKEN: setupToken,
	KERNIC_PACKAGE_REGISTRY: 'off',
	// Nothing is compiled here; no worker runs.
	KERNIC_WORKER_URL: 'http://127.0.0.1:9',
	KERNIC_WORKER_TOKEN: 'durability-worker-token-0123456789'
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const problems: string[] = [];
const fail = (round: number, message: string) => problems.push(`round ${round}: ${message}`);

let app: ChildProcess | null = null;
let appLog = '';
/** Temporary copies of cut-off saves that the app reported removing when it started. */
let clearedAtStart = 0;

async function startApp(): Promise<void> {
	appLog = '';
	const child = spawn('node', ['build'], {
		cwd: web,
		env: appEnv,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	child.stdout!.on('data', (chunk: Buffer) => (appLog += chunk));
	child.stderr!.on('data', (chunk: Buffer) => (appLog += chunk));
	app = child;
	for (let attempt = 0; attempt < 200; attempt++) {
		if (child.exitCode !== null) break;
		const up = await fetch(`${base}/healthz`).then(
			(response) => response.ok,
			() => false
		);
		if (up) {
			clearedAtStart += Number(/Removed (\d+) temporary file/.exec(appLog)?.[1] ?? 0);
			return;
		}
		await sleep(50);
	}
	throw new Error(`The app did not start.\n${appLog.slice(-2000)}`);
}

async function killApp(): Promise<void> {
	const child = app;
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once('exit', resolve));
	child.kill('SIGKILL');
	await exited;
}

/** A file body that can prove it is complete: its first line carries the hash of the rest. */
function payload(file: string, sequence: number): string {
	// Sizes from a few hundred bytes to a few hundred kilobytes, so that kills
	// land at different points of a write.
	const body = randomBytes(64 + Math.floor(Math.random() ** 3 * 200_000)).toString('hex');
	return `// durability file=${file} seq=${sequence} sha=${sha256(body)}\n${body}`;
}

/** The sequence number of a complete payload, or null if the content is not one. */
function sequenceOf(content: string): number | null {
	const newline = content.indexOf('\n');
	const header = /^\/\/ durability file=\S+ seq=(\d+) sha=([0-9a-f]{64})$/.exec(
		content.slice(0, Math.max(newline, 0))
	);
	if (!header || sha256(content.slice(newline + 1)) !== header[2]) return null;
	return Number(header[1]);
}

// --- Set up: a fresh database and data directory, an account and a project. ---

await rm(dataDir, { recursive: true, force: true });
await run('node', ['e2e/reset.ts'], {
	cwd: web,
	env: { ...process.env, KERNIC_TEST_DATABASE_URL: databaseUrl }
});
await startApp();

const origin = { origin: base, 'x-forwarded-proto': 'http' };
const form = (fields: Record<string, string>) => new URLSearchParams(fields);
const setup = await fetch(`${base}/setup`, {
	method: 'POST',
	redirect: 'manual',
	headers: { ...origin, accept: 'text/html' },
	body: form({ setupToken, displayName: admin.name, email: admin.email, password: admin.password })
});
const cookie = setup.headers.getSetCookie()[0]?.split(';')[0];
if (!cookie) throw new Error(`Setup failed with HTTP ${setup.status}.`);
const headers = { ...origin, cookie };

const home = await (await fetch(`${base}/`, { headers })).text();
const workspace = /name="workspace" value="([^"]+)"/.exec(home)![1]!;
const created = await fetch(`${base}/?/create`, {
	method: 'POST',
	redirect: 'manual',
	headers: { ...headers, accept: 'text/html' },
	body: form({ name: 'Durability', template: 'report', workspace })
});
const projectId = created.headers.get('location')!.split('/').pop()!;
const api = `${base}/api/projects/${projectId}`;
const treeDir = path.join(dataDir, 'projects', projectId, 'tree');
const repoDir = path.join(dataDir, 'projects', projectId, 'repo.git');

const files = ['main.typ', 'stress/first.typ', 'stress/second.typ'];
/** Per file: the last sequence sent, the last one the server acknowledged, and the stored hash. */
const onDisk = (file: string) =>
	readFile(path.join(treeDir, ...file.split('/')), 'utf8').catch(() => null);
const state = new Map<
	string,
	{
		sent: number;
		acknowledged: number;
		hash: string | null;
		written: boolean;
		original: string | null;
	}
>();
for (const file of files) {
	state.set(file, {
		sent: 0,
		acknowledged: 0,
		hash: null,
		written: false,
		original: await onDisk(file)
	});
}

let saves = 0;
let checkpoints = 0;
let killedDuringWrite = 0;

for (let round = 1; round <= rounds; round++) {
	// What the app serves after a (re)start must be what is on disk.
	for (const file of files) {
		const response = await fetch(`${api}/files/${file}`, { headers });
		const served = response.ok ? await response.text() : null;
		if (response.ok) state.get(file)!.hash = response.headers.get('x-kernic-hash');
		else await response.arrayBuffer();
		if (served !== (await onDisk(file)))
			fail(round, `${file}: the app serves other content than is on disk`);
	}

	let killed = false;
	const saver = async (file: string) => {
		const entry = state.get(file)!;
		while (!killed) {
			const body = payload(file, ++entry.sent);
			try {
				const response = await fetch(`${api}/files/${file}`, {
					method: 'PUT',
					headers: {
						...headers,
						'content-type': 'text/plain',
						'x-kernic-base-hash': entry.hash ?? 'none'
					},
					body
				});
				if (!response.ok) {
					fail(round, `${file}: save answered HTTP ${response.status} ${await response.text()}`);
					return;
				}
				entry.hash = ((await response.json()) as { hash: string }).hash;
				entry.acknowledged = entry.sent;
				saves++;
			} catch {
				// The app was killed while this save was on its way.
				return;
			}
		}
	};
	const checkpointer = async () => {
		while (!killed) {
			try {
				const response = await fetch(`${api}/history`, {
					method: 'POST',
					headers: { ...headers, 'content-type': 'application/json' },
					body: JSON.stringify({ message: `Round ${round}` })
				});
				await response.arrayBuffer();
				if (response.ok) checkpoints++;
				else if (response.status >= 500) fail(round, `checkpoint answered HTTP ${response.status}`);
			} catch {
				return;
			}
			await sleep(20);
		}
	};
	const working = [...files.map(saver), checkpointer()];

	await sleep(20 + Math.random() * 500);
	const pending = [...state.values()].some((entry) => entry.sent > entry.acknowledged);
	await killApp();
	killed = true;
	if (pending) killedDuringWrite++;
	await Promise.all(working);

	// Examine the disk before anything runs again.
	for (const file of files) {
		const entry = state.get(file)!;
		const content = await onDisk(file);
		const sequence = content === null ? null : sequenceOf(content);
		// Until a first save has landed, the file is as it was before the test.
		const untouched = !entry.written && content === entry.original;
		if (sequence === null && !untouched) {
			fail(
				round,
				content === ''
					? `${file} is empty`
					: `${file} is not a complete file (${content?.length ?? 'no'} characters)`
			);
		}
		if (entry.acknowledged > 0 && (sequence === null || sequence < entry.acknowledged)) {
			fail(
				round,
				`${file}: acknowledged save ${entry.acknowledged} is not on disk (found ${sequence})`
			);
		}
		if (sequence !== null && sequence > entry.sent)
			fail(round, `${file}: found a save that was never sent`);
		if (sequence !== null) entry.written = true;
	}
	const entries = await readdir(treeDir, { recursive: true });
	if (entries.some((name) => name.endsWith('.tmp')))
		fail(round, 'a temporary file is inside the project');

	try {
		await run('git', ['--git-dir', repoDir, 'fsck', '--no-dangling']);
	} catch (error) {
		fail(round, `git fsck failed: ${(error as { stderr?: string }).stderr ?? error}`);
	}

	await startApp().catch((error: Error) => {
		fail(round, error.message);
		throw error;
	});
}

// --- After the last restart: saving and checkpoints still work. ---

const current = await fetch(`${api}/files/main.typ`, { headers });
const finalHash = current.headers.get('x-kernic-hash');
await current.arrayBuffer();
const finalSave = await fetch(`${api}/files/main.typ`, {
	method: 'PUT',
	headers: { ...headers, 'content-type': 'text/plain', 'x-kernic-base-hash': finalHash ?? 'none' },
	body: 'Written after the last restart.\n'
});
if (!finalSave.ok) problems.push(`after the last restart: save answered HTTP ${finalSave.status}`);
const finalCheckpoint = await fetch(`${api}/history`, {
	method: 'POST',
	headers: { ...headers, 'content-type': 'application/json' },
	body: JSON.stringify({ message: 'After the last restart' })
});
if (!finalCheckpoint.ok) {
	problems.push(
		`after the last restart: checkpoint answered HTTP ${finalCheckpoint.status} ${await finalCheckpoint.text()}`
	);
}
const history = await fetch(`${api}/history`, { headers });
const listed = history.ok
	? ((await history.json()) as { checkpoints: unknown[] }).checkpoints.length
	: -1;
if (listed < 1) problems.push('after the last restart: the history cannot be listed');

// Temporary copies of saves that were cut off are cleared when the app starts.
const leftovers = await readdir(`${treeDir}.tmp`).catch(() => []);
if (leftovers.length > 0) {
	problems.push(
		`${leftovers.length} temporary files of interrupted saves were not removed at startup`
	);
}
await killApp();

console.log(
	`${rounds} kills, ${killedDuringWrite} of them while a save was on its way; ` +
		`${saves} saves and ${checkpoints} checkpoints acknowledged; ${listed} checkpoints listed; ` +
		`${clearedAtStart} temporary copies of cut-off saves cleared at restarts.`
);
if (problems.length > 0) {
	console.error(`\n${problems.length} problems:\n${problems.join('\n')}`);
	process.exit(1);
}
console.log(
	'No file was empty or incomplete, no acknowledged save was missing, and the history stayed intact.'
);
await rm(dataDir, { recursive: true, force: true });
