import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { loadConfig, type WorkerConfig } from '../src/config.ts';
import { createWorker } from '../src/server.ts';

const TOKEN = 'test-token-test-token-test-token';

interface Harness {
	baseUrl: string;
	workDir: string;
	close: () => Promise<void>;
}

async function startWorker(env: Record<string, string> = {}): Promise<Harness> {
	const workDir = await mkdtemp(path.join(tmpdir(), 'kernic-worker-test-'));
	const config: WorkerConfig = loadConfig({
		KERNIC_WORKER_TOKEN: TOKEN,
		KERNIC_WORKER_DIR: workDir,
		KERNIC_WORKER_SANDBOX: process.env.KERNIC_WORKER_SANDBOX ?? 'bwrap',
		...env
	});
	const { server } = await createWorker(config);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		workDir,
		close: async () => {
			await new Promise((resolve) => server.close(resolve));
			await rm(workDir, { recursive: true, force: true });
		}
	};
}

function sha256(content: string | Buffer): string {
	return createHash('sha256').update(content).digest('hex');
}

const auth = { authorization: `Bearer ${TOKEN}` };

async function uploadBlob(harness: Harness, content: string): Promise<string> {
	const hash = sha256(content);
	const response = await fetch(`${harness.baseUrl}/blobs/${hash}`, {
		method: 'PUT',
		headers: auth,
		body: content
	});
	assert.equal(response.status, 200);
	return hash;
}

async function compile(
	harness: Harness,
	files: Record<string, string>,
	options: { entry?: string; format?: 'svg' | 'pdf' } = {}
) {
	const snapshot = [];
	for (const [filePath, content] of Object.entries(files)) {
		snapshot.push({ path: filePath, sha256: await uploadBlob(harness, content) });
	}
	const response = await fetch(`${harness.baseUrl}/compile`, {
		method: 'POST',
		headers: { ...auth, 'content-type': 'application/json' },
		body: JSON.stringify({
			entry: options.entry ?? 'main.typ',
			format: options.format ?? 'svg',
			files: snapshot
		})
	});
	return { status: response.status, body: (await response.json()) as any };
}

describe('compile worker', () => {
	let harness: Harness;

	before(async () => {
		harness = await startWorker();
	});
	after(() => harness.close());

	test('reports health without authentication', async () => {
		const response = await fetch(`${harness.baseUrl}/healthz`);
		assert.equal(response.status, 200);
		const body = (await response.json()) as any;
		assert.equal(body.ok, true);
		assert.match(body.typstVersion, /^\d+\.\d+/);
	});

	test('rejects requests without the worker token', async () => {
		const response = await fetch(`${harness.baseUrl}/compile`, { method: 'POST', body: '{}' });
		assert.equal(response.status, 401);

		const wrong = await fetch(`${harness.baseUrl}/compile`, {
			method: 'POST',
			headers: { authorization: 'Bearer nope' },
			body: '{}'
		});
		assert.equal(wrong.status, 401);
	});

	test('compiles a multi-file project to one SVG per page', async () => {
		const { status, body } = await compile(harness, {
			'main.typ': '#import "parts/title.typ": title\n= #title\n#pagebreak()\nSecond page',
			'parts/title.typ': '#let title = "Kernic"'
		});

		assert.equal(status, 200);
		assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
		assert.deepEqual(
			body.artifacts.map((artifact: any) => artifact.name),
			['page-1.svg', 'page-2.svg']
		);
		const svg = Buffer.from(body.artifacts[0].data, 'base64').toString('utf8');
		assert.ok(svg.startsWith('<svg'));
		assert.equal(body.timedOut, false);
	});

	test('exports a PDF', async () => {
		const { body } = await compile(harness, { 'main.typ': 'Hello' }, { format: 'pdf' });
		assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
		assert.equal(body.artifacts.length, 1);
		assert.equal(body.artifacts[0].name, 'output.pdf');
		const pdf = Buffer.from(body.artifacts[0].data, 'base64');
		assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
	});

	test('returns located diagnostics for errors and warnings', async () => {
		const failed = await compile(harness, {
			'main.typ': '#import "chapter.typ"\nText',
			'chapter.typ': 'Fine line\n#let x = 1 +'
		});
		assert.equal(failed.body.ok, false);
		assert.deepEqual(failed.body.artifacts, []);
		assert.deepEqual(failed.body.diagnostics[0], {
			severity: 'error',
			message: 'expected expression',
			path: 'chapter.typ',
			line: 2,
			column: 12
		});

		const warned = await compile(harness, {
			'main.typ': '#set text(font: "No Such Font Family")\nText'
		});
		assert.equal(warned.body.ok, true);
		assert.equal(warned.body.diagnostics[0].severity, 'warning');
		assert.equal(warned.body.diagnostics[0].path, 'main.typ');
	});

	test('asks for blobs it does not have instead of compiling', async () => {
		const missing = sha256('never uploaded');
		const response = await fetch(`${harness.baseUrl}/compile`, {
			method: 'POST',
			headers: { ...auth, 'content-type': 'application/json' },
			body: JSON.stringify({
				entry: 'main.typ',
				format: 'svg',
				files: [{ path: 'main.typ', sha256: missing }]
			})
		});
		assert.equal(response.status, 409);
		assert.deepEqual(((await response.json()) as any).missing, [missing]);
	});

	test('rejects a blob whose content does not match its hash', async () => {
		const response = await fetch(`${harness.baseUrl}/blobs/${sha256('expected')}`, {
			method: 'PUT',
			headers: auth,
			body: 'something else'
		});
		assert.equal(response.status, 400);
	});

	test('rejects snapshot paths that escape the job directory', async () => {
		const hash = await uploadBlob(harness, 'Hello');
		for (const badPath of ['../escape.typ', '/etc/passwd', 'a//b.typ', 'a/../../b.typ', 'a\\b']) {
			const response = await fetch(`${harness.baseUrl}/compile`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					entry: 'main.typ',
					format: 'svg',
					files: [
						{ path: 'main.typ', sha256: hash },
						{ path: badPath, sha256: hash }
					]
				})
			});
			assert.equal(response.status, 400, `expected "${badPath}" to be rejected`);
		}
	});

	test('a document cannot read files outside its project', async () => {
		const { body } = await compile(harness, {
			'main.typ': '#read("/etc/hostname")\n#read("../../../../etc/hostname")'
		});
		assert.equal(body.ok, false);
		assert.ok(body.diagnostics.length > 0);
	});

	test('cleans up the job directory after each compile', async () => {
		await compile(harness, { 'main.typ': 'Hello' });
		assert.deepEqual(await readdir(path.join(harness.workDir, 'jobs')), []);
	});
});

describe('compile limits', () => {
	test('stops a compile that exceeds the time limit', async () => {
		const harness = await startWorker({ KERNIC_COMPILE_TIMEOUT_MS: '1500' });
		try {
			const { body } = await compile(harness, {
				// Typst rejects unbounded `while` loops itself, so keep it busy with nested ranges.
				'main.typ':
					'#{\n let x = 0\n for i in range(100000) { for j in range(100000) { x += 1 } }\n}'
			});
			assert.equal(body.ok, false);
			assert.equal(body.timedOut, true);
			assert.match(body.diagnostics.at(-1).message, /stopped after/);
		} finally {
			await harness.close();
		}
	});

	test('rejects blobs larger than the configured limit', async () => {
		const harness = await startWorker({ KERNIC_BLOB_MAX_MB: '1' });
		try {
			const content = Buffer.alloc(1024 * 1024 + 1, 'a');
			const response = await fetch(`${harness.baseUrl}/blobs/${sha256(content)}`, {
				method: 'PUT',
				headers: auth,
				body: content
			});
			assert.equal(response.status, 413);
		} finally {
			await harness.close();
		}
	});
});

describe('bubblewrap sandbox', { skip: !existsSync('/usr/bin/bwrap') }, () => {
	test('gives the compiler no network access', async () => {
		const harness = await startWorker({ KERNIC_WORKER_SANDBOX: 'bwrap' });
		try {
			// Package downloads are the one way a Typst document can reach the network.
			const { body } = await compile(harness, {
				'main.typ': '#import "@preview/example:0.1.0": *\nText'
			});
			assert.equal(body.ok, false);
			assert.match(body.diagnostics[0].message, /failed to download package|package/);
		} finally {
			await harness.close();
		}
	});
});
