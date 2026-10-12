import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Ports, paths and credentials shared by the end-to-end servers and tests. */

export const appPort = 5183;
export const workerPort = 3183;
export const registryPort = 4183;
export const forgePort = 4184;

/**
 * Set KERNIC_E2E_BASE_URL to run the suite against an already running, freshly
 * installed deployment (for example the Docker Compose stack) instead of
 * starting the app here. Pass that deployment's setup token as KERNIC_E2E_SETUP_TOKEN.
 */
export const externalBaseURL = process.env.KERNIC_E2E_BASE_URL?.replace(/\/+$/, '');
export const baseURL = externalBaseURL ?? `http://localhost:${appPort}`;

export const databaseUrl =
	process.env.KERNIC_TEST_DATABASE_URL ?? 'postgres://kernic:kernic@127.0.0.1:54329/kernic_test';
export const dataDir = path.join(tmpdir(), 'kernic-e2e-data');
export const workerDir = path.join(tmpdir(), 'kernic-e2e-worker');

export const setupToken = process.env.KERNIC_E2E_SETUP_TOKEN ?? 'e2e-setup-token';
export const workerToken = 'e2e-worker-token-e2e-worker-token';

/** The stand-in Git forge of the tests, and tokens it knows. */
export const forgeOrigin = `http://127.0.0.1:${forgePort}`;
export const forgeToken = 'e2e-forge-token-that-may-write';
export const forgeReadOnlyToken = 'e2e-forge-token-that-may-read';

export const admin = {
	name: 'Ada Lovelace',
	email: 'ada@example.org',
	password: 'correct horse battery staple'
};

export const adminStorageState = path.join(import.meta.dirname, '.auth', 'admin.json');

/**
 * How the worker started for the tests confines compilers. Landlock where this
 * machine's `setpriv` offers it, as in the Docker image: only then can a place
 * on a page be traced to its source. Otherwise bubblewrap, the worker's default.
 * The documents compiled here are the tests' own, so it does not matter that
 * Landlock alone leaves the network open.
 */
export const workerSandbox =
	process.env.KERNIC_WORKER_SANDBOX ?? (setprivHasLandlock() ? 'landlock' : 'bwrap');

function setprivHasLandlock(): boolean {
	try {
		return execFileSync('setpriv', ['--help'], { encoding: 'utf8' }).includes('landlock');
	} catch {
		return false;
	}
}
