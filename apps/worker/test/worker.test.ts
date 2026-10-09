import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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

type PackageSource = {
	namespace: string;
	name: string;
	version: string;
	files: Record<string, string>;
};

async function uploadAll(harness: Harness, files: Record<string, string>) {
	const list = [];
	for (const [filePath, content] of Object.entries(files)) {
		list.push({ path: filePath, sha256: await uploadBlob(harness, content) });
	}
	return list;
}

async function compile(
	harness: Harness,
	files: Record<string, string>,
	options: { entry?: string; format?: 'svg' | 'pdf'; packages?: PackageSource[] } = {}
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
			packages
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

describe('packages', () => {
	let harness: Harness;
	before(async () => {
		harness = await startWorker();
	});
	after(() => harness.close());

	const manifest = (name: string, version: string) =>
		`[package]\nname = "${name}"\nversion = "${version}"\nentrypoint = "lib.typ"\n`;

	test('a document can import packages supplied with the request, including nested ones', async () => {
		const { body } = await compile(
			harness,
			{ 'main.typ': '#import "@preview/greeting:0.1.0": greet\n#greet("Kernic")' },
			{
				packages: [
					{
						namespace: 'preview',
						name: 'greeting',
						version: '0.1.0',
						files: {
							'typst.toml': manifest('greeting', '0.1.0'),
							'lib.typ':
								'#import "@preview/punctuation:1.2.0": mark\n#let greet(name) = [Hello #name#mark]'
						}
					},
					{
						namespace: 'preview',
						name: 'punctuation',
						version: '1.2.0',
						files: { 'typst.toml': manifest('punctuation', '1.2.0'), 'lib.typ': '#let mark = "!"' }
					}
				]
			}
		);
		assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
		assert.equal(body.artifacts.length, 1);
	});

	test('a package that was not supplied is reported as an error, not fetched', async () => {
		const { body } = await compile(harness, {
			'main.typ': '#import "@preview/greeting:0.1.0": greet\nText'
		});
		assert.equal(body.ok, false);
		assert.equal(body.diagnostics[0].path, 'main.typ');
		assert.equal(body.diagnostics[0].line, 1);
	});

	test('rejects package identifiers that could change where files are written', async () => {
		const hash = await uploadBlob(harness, 'Hello');
		for (const bad of [
			{ namespace: '..', name: 'x', version: '1.0.0' },
			{ namespace: 'preview', name: '../../etc', version: '1.0.0' },
			{ namespace: 'preview', name: 'x', version: '1.0.0/../..' },
			{ namespace: 'preview', name: 'X y', version: '1.0.0' }
		]) {
			const response = await fetch(`${harness.baseUrl}/compile`, {
				method: 'POST',
				headers: { ...auth, 'content-type': 'application/json' },
				body: JSON.stringify({
					entry: 'main.typ',
					format: 'svg',
					files: [{ path: 'main.typ', sha256: hash }],
					packages: [{ ...bad, files: [{ path: 'lib.typ', sha256: hash }] }]
				})
			});
			assert.equal(response.status, 400, JSON.stringify(bad));
		}
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

describe('hostile documents', () => {
	async function withWorker(
		env: Record<string, string>,
		run: (harness: Harness) => Promise<void>
	): Promise<void> {
		const harness = await startWorker(env);
		try {
			await run(harness);
			// Whatever the document did, the worker must still serve the next request.
			const { body } = await compile(harness, { 'main.typ': 'Still alive' });
			assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
		} finally {
			await harness.close();
		}
	}

	test('a document that exhausts memory fails without taking the worker down', async () => {
		await withWorker({ KERNIC_COMPILE_MEMORY_MB: '768' }, async (harness) => {
			const { status, body } = await compile(harness, {
				'main.typ': '#let big = "x" * 4000000000\n#big.len()'
			});
			assert.equal(status, 200);
			assert.equal(body.ok, false);
			assert.match(body.diagnostics.at(-1).message, /ran out of memory/);
		});
	});

	test('a document with more pages than allowed is refused with a clear message', async () => {
		await withWorker({ KERNIC_COMPILE_MAX_PAGES: '20' }, async (harness) => {
			const { body } = await compile(harness, {
				'main.typ': '#for i in range(60) [Page #i #pagebreak()]'
			});
			assert.equal(body.ok, false);
			assert.deepEqual(body.artifacts, []);
			assert.match(body.diagnostics.at(-1).message, /more than 20 pages/);
		});
	});

	test('output beyond the size limit is refused', async () => {
		await withWorker({ KERNIC_COMPILE_OUTPUT_MB: '1' }, async (harness) => {
			// Each page carries distinct text, so the pages cannot share glyph data.
			const { body } = await compile(harness, {
				'main.typ':
					'#set page(width: 30cm, height: 30cm, margin: 1cm)\n#set text(size: 6pt)\n' +
					'#for i in range(120) [#((str(i) + " lorem ipsum dolor sit amet ") * 600) #pagebreak()]'
			});
			assert.equal(body.ok, false);
			assert.deepEqual(body.artifacts, []);
			// Refused for its size, not because the test document is broken.
			assert.match(body.diagnostics.at(-1).message, /larger than 1 MB/);
		});
	});

	test('a document cannot see the environment or files of the worker', async () => {
		await withWorker({}, async (harness) => {
			for (const source of [
				'#read("/proc/self/environ")',
				'#read("/etc/passwd")',
				'#image("/etc/hostname")',
				'#include "/etc/os-release"',
				'#import "../../../etc/passwd": x'
			]) {
				const { body } = await compile(harness, { 'main.typ': source });
				assert.equal(body.ok, false, source);
			}
			// Command-line inputs are the only channel into a document, and none are passed.
			const { body } = await compile(harness, { 'main.typ': '#assert(sys.inputs.len() == 0)\nok' });
			assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
		});
	});
});

/**
 * Landlock is tested with a stand-in for the compiler that tries to step outside
 * its job: Typst itself refuses such paths, so the real compiler cannot show
 * what the sandbox would stop if that refusal were bypassed.
 */
describe(
	'landlock sandbox',
	{ skip: !execFileSync('setpriv', ['--help']).toString().includes('landlock') },
	() => {
		async function runIntruder(sandbox: 'landlock' | 'none'): Promise<string> {
			const workDir = await mkdtemp(path.join(tmpdir(), 'kernic-worker-test-'));
			const cache = path.join(workDir, 'blobs');
			const intruder = path.join(workDir, 'fake-typst');
			await writeFile(
				intruder,
				[
					'#!/bin/sh',
					'if [ "$1" = "--version" ]; then echo "typst 0.0.0"; exit 0; fi',
					'for last; do :; done',
					'out=$(dirname "$last")',
					'{',
					'  printf "<svg width=\\"10pt\\" height=\\"10pt\\">"',
					`  if ls -R ${cache} >/dev/null 2>&1; then echo "CACHE:readable"; else echo "CACHE:denied"; fi`,
					'  if cat /etc/hostname >/dev/null 2>&1; then echo "ETC:readable"; else echo "ETC:denied"; fi',
					'  if echo x > "$PWD/planted" 2>/dev/null; then echo "SOURCE:writable"; else echo "SOURCE:denied"; fi',
					'  printf "</svg>"',
					'} > "$out/page-1.svg"'
				].join('\n'),
				{ mode: 0o755 }
			);

			const { server } = await createWorker(
				loadConfig({
					KERNIC_WORKER_TOKEN: TOKEN,
					KERNIC_WORKER_DIR: workDir,
					KERNIC_WORKER_SANDBOX: sandbox,
					KERNIC_TYPST_BIN: intruder
				})
			);
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			const harness: Harness = {
				baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
				workDir,
				close: async () => {
					await new Promise((resolve) => server.close(resolve));
					await rm(workDir, { recursive: true, force: true });
				}
			};
			try {
				const { body } = await compile(harness, { 'main.typ': 'anything' });
				assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
				return Buffer.from(body.artifacts[0].data, 'base64').toString('utf8');
			} finally {
				await harness.close();
			}
		}

		test('a compiler process cannot reach the cache, system files or its own sources', async () => {
			const report = await runIntruder('landlock');
			assert.match(report, /CACHE:denied/);
			assert.match(report, /ETC:denied/);
			assert.match(report, /SOURCE:denied/);
		});

		test('the same process without the sandbox can, which is what the sandbox is for', async () => {
			const report = await runIntruder('none');
			assert.match(report, /CACHE:readable/);
			assert.match(report, /ETC:readable/);
		});

		test('real documents compile under Landlock, with fonts and packages', async () => {
			const harness = await startWorker({ KERNIC_WORKER_SANDBOX: 'landlock' });
			try {
				const { body } = await compile(
					harness,
					{
						'main.typ':
							'#import "@preview/greeting:0.1.0": greet\n#set text(font: "DejaVu Sans Mono")\n= Title\n#greet("x") $x^2$'
					},
					{
						packages: [
							{
								namespace: 'preview',
								name: 'greeting',
								version: '0.1.0',
								files: {
									'typst.toml':
										'[package]\nname = "greeting"\nversion = "0.1.0"\nentrypoint = "lib.typ"\n',
									'lib.typ': '#let greet(name) = [Hello #name]'
								}
							}
						]
					}
				);
				assert.equal(body.ok, true, JSON.stringify(body.diagnostics));
				assert.deepEqual(body.diagnostics, []);
			} finally {
				await harness.close();
			}
		});
	}
);

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
