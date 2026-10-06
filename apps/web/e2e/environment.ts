import { tmpdir } from 'node:os';
import path from 'node:path';

/** Ports, paths and credentials shared by the end-to-end servers and tests. */

export const appPort = 5183;
export const workerPort = 3183;
export const baseURL = `http://localhost:${appPort}`;

export const databaseUrl =
	process.env.KERNIC_TEST_DATABASE_URL ?? 'postgres://kernic:kernic@127.0.0.1:54329/kernic_test';
export const dataDir = path.join(tmpdir(), 'kernic-e2e-data');
export const workerDir = path.join(tmpdir(), 'kernic-e2e-worker');

export const setupToken = 'e2e-setup-token';
export const workerToken = 'e2e-worker-token-e2e-worker-token';

export const admin = {
	name: 'Ada Lovelace',
	email: 'ada@example.org',
	password: 'correct horse battery staple'
};

export const adminStorageState = path.join(import.meta.dirname, '.auth', 'admin.json');
