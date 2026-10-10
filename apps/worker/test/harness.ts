import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type WorkerConfig } from '../src/config.ts';
import { createWorker } from '../src/server.ts';

export const TOKEN = 'test-token-test-token-test-token';

export interface Harness {
	baseUrl: string;
	workDir: string;
	close: () => Promise<void>;
}

export async function startWorker(env: Record<string, string> = {}): Promise<Harness> {
	const workDir = await mkdtemp(path.join(tmpdir(), 'kernic-worker-test-'));
	const config: WorkerConfig = loadConfig({
		KERNIC_WORKER_TOKEN: TOKEN,
		KERNIC_WORKER_DIR: workDir,
		KERNIC_WORKER_SANDBOX: process.env.KERNIC_WORKER_SANDBOX ?? 'bwrap',
		...env
	});
	const { server, close } = await createWorker(config);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		workDir,
		close: async () => {
			await close();
			await new Promise((resolve) => server.close(resolve));
			await rm(workDir, { recursive: true, force: true });
		}
	};
}

export function sha256(content: string | Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

export const auth = { authorization: `Bearer ${TOKEN}` };

export async function uploadBlob(harness: Harness, content: string): Promise<string> {
	const hash = sha256(content);
	const response = await fetch(`${harness.baseUrl}/blobs/${hash}`, {
		method: 'PUT',
		headers: auth,
		body: content
	});
	assert.equal(response.status, 200);
	return hash;
}

export type PackageSource = {
	namespace: string;
	name: string;
	version: string;
	files: Record<string, string>;
};

export async function uploadAll(harness: Harness, files: Record<string, string>) {
	const list = [];
	for (const [filePath, content] of Object.entries(files)) {
		list.push({ path: filePath, sha256: await uploadBlob(harness, content) });
	}
	return list;
}

export async function compile(
	harness: Harness,
	files: Record<string, string>,
	options: {
		entry?: string;
		format?: 'svg' | 'pdf';
		packages?: PackageSource[];
		session?: string;
		knownPages?: string[];
		pdf?: unknown;
	} = {}
) {
	const snapshot = await uploadAll(harness, files);
	const packages = [];
	for (const item of options.packages ?? []) {
		packages.push({ ...item, files: await uploadAll(harness, item.files) });
	}
	const response = await fetch(`${harness.baseUrl}/compile`, {
		method: 'POST',
		headers: { ...auth, 'content-type': 'application/json' },
		body: JSON.stringify({
			entry: options.entry ?? 'main.typ',
			format: options.format ?? 'svg',
			files: snapshot,
			packages,
			session: options.session,
			knownPages: options.knownPages,
			pdf: options.pdf
		})
	});
	return { status: response.status, body: (await response.json()) as any };
}
