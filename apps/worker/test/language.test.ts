import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { auth, startWorker, uploadAll, type Harness, type PackageSource } from './harness.ts';

/**
 * The language servers that assist while writing. Beyond "it answers", these
 * tests are about what an editor must not be able to do through one: reach the
 * server's export commands, name files outside the project, or learn where the
 * project lies on the worker.
 */

type Files = Record<string, string>;
type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: any };

const hasTinymist = (() => {
	try {
		execFileSync('tinymist', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();

// Skipping is for machines without Tinymist; a pipeline has to have it.
if (!hasTinymist && process.env.CI) throw new Error('Tinymist is not installed on this runner.');

/** A minimal editor: starts a language server and speaks the protocol with it over the worker. */
class Editor {
	readonly received: Message[] = [];
	/** Everything the worker sent, as text, to search for things that must not be in it. */
	transcript = '';
	ended = false;
	readonly #harness: Harness;
	readonly #name: string;
	readonly #waiting = new Map<number, (message: Message) => void>();
	#nextId = 0;
	#abort = new AbortController();

	constructor(harness: Harness, name: string) {
		this.#harness = harness;
		this.#name = name;
	}

	get #base() {
		return `${this.#harness.baseUrl}/lsp/${this.#name}`;
	}

	/** Sends the project to the worker; starts the server on the first call, updates it later. */
	async project(files: Files, options: { entry?: string; packages?: PackageSource[] } = {}) {
		const packages = [];
		for (const item of options.packages ?? []) {
			packages.push({ ...item, files: await uploadAll(this.#harness, item.files) });
		}
		return fetch(this.#base, {
			method: 'POST',
			headers: { ...auth, 'content-type': 'application/json' },
			body: JSON.stringify({
				entry: options.entry ?? 'main.typ',
				files: await uploadAll(this.#harness, files),
				packages
			})
		});
	}

	async listen() {
		const response = await fetch(`${this.#base}/stream`, {
			headers: auth,
			signal: this.#abort.signal
		});
		assert.equal(response.status, 200);
		void (async () => {
			let pending = '';
			try {
				for await (const chunk of response.body!) {
					pending += Buffer.from(chunk).toString('utf8');
					for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
						const line = pending.slice(0, end);
						pending = pending.slice(end + 1);
						this.transcript += `${line}\n`;
						const message = JSON.parse(line) as Message;
						this.received.push(message);
						if (typeof message.id === 'number' && message.method === undefined) {
							this.#waiting.get(message.id)?.(message);
						}
					}
				}
			} catch {
				// aborted by close()
			}
			this.ended = true;
		})();
	}

	async send(...messages: object[]) {
		const response = await fetch(`${this.#base}/messages`, {
			method: 'POST',
			headers: { ...auth, 'content-type': 'application/json' },
			body: JSON.stringify({
				messages: messages.map((message) => ({ jsonrpc: '2.0', ...message }))
			})
		});
		return response.status;
	}

	async request(method: string, params: unknown): Promise<Message> {
		const id = ++this.#nextId;
		const answer = new Promise<Message>((resolve, reject) => {
			this.#waiting.set(id, resolve);
			setTimeout(() => reject(new Error(`no answer to ${method}`)), 10_000).unref();
		});
		await this.send({ id, method, params });
		return answer;
	}

	notify(method: string, params: unknown) {
		return this.send({ method, params });
	}

	/** The usual opening: project, stream, handshake. */
	async start(files: Files, options: { entry?: string; packages?: PackageSource[] } = {}) {
		const started = await this.project(files, options);
		assert.equal(started.status, 200, await started.clone().text());
		assert.deepEqual(await started.json(), { ok: true, rootUri: 'file:///project' });
		await this.listen();
		const initialized = await this.request('initialize', {
			processId: 4242,
			rootUri: 'file:///somewhere/else',
			capabilities: { textDocument: { hover: { contentFormat: ['markdown'] } } },
			initializationOptions: { exportPdf: 'onSave', rootPath: '/' }
		});
		await this.notify('initialized', {});
		return initialized;
	}

	open(file: string, text: string) {
		return this.notify('textDocument/didOpen', {
			textDocument: { uri: `file:///project/${file}`, languageId: 'typst', version: 1, text }
		});
	}

	/** Labels offered at a position, once the server has caught up with the document. */
	async completions(file: string, line: number, character: number, expected?: string) {
		for (let attempt = 0; ; attempt++) {
			const answer = await this.request('textDocument/completion', {
				textDocument: { uri: `file:///project/${file}` },
				position: { line, character }
			});
			const items: { label: string }[] = answer.result?.items ?? answer.result ?? [];
			const labels = items.map((item) => item.label);
			if (expected === undefined || labels.includes(expected) || attempt === 40) return labels;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	async stop() {
		await fetch(this.#base, { method: 'DELETE', headers: auth });
	}

	close() {
		this.#abort.abort();
	}
}

function parentOf(pid: number): number {
	try {
		return Number(/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
	} catch {
		return 0;
	}
}

/** Process ids of the language servers started by workers of this test process. */
function runningServers(): number[] {
	return readdirSync('/proc')
		.filter((entry) => /^\d+$/.test(entry))
		.map(Number)
		.filter((pid) => {
			try {
				const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
				if (path.basename(command[0] ?? '') !== 'tinymist' || command[1] !== 'lsp') return false;
			} catch {
				return false;
			}
			for (let ancestor = parentOf(pid); ancestor > 1; ancestor = parentOf(ancestor)) {
				if (ancestor === process.pid) return true;
			}
			return false;
		});
}

const project: Files = {
	'main.typ':
		'#import "template.typ": report\n#show: report.with(title: "Report")\n= Results <results>\n#include "chapters/intro.typ"\n#rep\n',
	'template.typ':
		'/// Lays out a report.\n#let report(title: "", body) = {\n  set document(title: title)\n  body\n}\n',
	'chapters/intro.typ': '= Introduction <intro>\nSee @res\n'
};

const sandboxes: { mode: string; available: boolean }[] = [
	{ mode: 'bwrap', available: existsSync('/usr/bin/bwrap') },
	{
		mode: 'landlock',
		available: execFileSync('setpriv', ['--help']).toString().includes('landlock')
	},
	{ mode: 'none', available: true }
];

for (const { mode, available } of sandboxes) {
	describe(`editor assistance, sandbox ${mode}`, { skip: !available || !hasTinymist }, () => {
		const start = (env: Record<string, string> = {}) =>
			startWorker({ KERNIC_WORKER_SANDBOX: mode, ...env });

		test('completes, explains and finds definitions across the files of a project', async () => {
			const harness = await start();
			const editor = new Editor(harness, 'editor-1');
			try {
				const initialized = await editor.start(project);
				assert.equal(initialized.result.serverInfo.name, 'tinymist');

				await editor.open('main.typ', project['main.typ']!);
				// A function imported from another file.
				assert.ok((await editor.completions('main.typ', 4, 4, 'report')).includes('report'));

				const hover = await editor.request('textDocument/hover', {
					textDocument: { uri: 'file:///project/main.typ' },
					position: { line: 1, character: 8 }
				});
				assert.match(JSON.stringify(hover.result), /Lays out a report/);

				const definition = await editor.request('textDocument/definition', {
					textDocument: { uri: 'file:///project/main.typ' },
					position: { line: 1, character: 8 }
				});
				const [target] = [definition.result].flat();
				assert.equal(target.targetUri, 'file:///project/template.typ');
				// Also readable as a plain location.
				assert.equal(target.uri, 'file:///project/template.typ');
				assert.deepEqual(target.range.start, { line: 1, character: 5 });

				// In a chapter, labels of the whole document are known: it is compiled from the
				// main file (which has to compile for that, so its unfinished line goes).
				await editor.notify('textDocument/didChange', {
					textDocument: { uri: 'file:///project/main.typ', version: 2 },
					contentChanges: [{ text: project['main.typ']!.replace('#rep\n', '') }]
				});
				// Labels come from the last version that compiled, so the chapter is first
				// opened without the unfinished reference, which is then typed.
				await editor.open('chapters/intro.typ', '= Introduction <intro>\nSee \n');
				await new Promise((resolve) => setTimeout(resolve, 800));
				await editor.notify('textDocument/didChange', {
					textDocument: { uri: 'file:///project/chapters/intro.typ', version: 2 },
					contentChanges: [{ text: project['chapters/intro.typ'] }]
				});
				const labels = await editor.completions('chapters/intro.typ', 1, 8, 'results');
				assert.ok(labels.includes('results'), 'a label defined in the main file');
				assert.ok(labels.includes('intro'));

				const format = () =>
					editor.request('textDocument/formatting', {
						textDocument: { uri: 'file:///project/template.typ' },
						options: { tabSize: 2, insertSpaces: true }
					});
				// A file that is not open cannot be formatted; the refusal names it as the author does.
				assert.equal((await format()).error?.message, 'file missing "template.typ"');
				await editor.open('template.typ', '#let   report(title: "", body)={body}\n');
				const [edit] = (await format()).result;
				assert.match(edit.newText, /=/);

				// Nothing the editor received says where the project lies on the worker.
				assert.doesNotMatch(editor.transcript, /kernic-worker-test|\/job\/|\/language\//);
			} finally {
				editor.close();
				await harness.close();
			}
		});

		test('follows changes to other files and to packages', async () => {
			const harness = await start();
			const editor = new Editor(harness, 'editor-2');
			try {
				await editor.start(project);
				await editor.open('main.typ', project['main.typ']!);
				assert.ok(!(await editor.completions('main.typ', 4, 4, 'report')).includes('reply'));

				const packages: PackageSource[] = [
					{
						namespace: 'preview',
						name: 'greeting',
						version: '0.1.0',
						files: {
							'typst.toml':
								'[package]\nname = "greeting"\nversion = "0.1.0"\nentrypoint = "lib.typ"',
							'lib.typ': '#let replyall(name) = [Hello, #name!]'
						}
					}
				];
				const changed = {
					...project,
					'template.typ': `${project['template.typ']}#let reply = [Thanks]\n`,
					'main.typ':
						'#import "template.typ": *\n#import "@preview/greeting:0.1.0": *\n= Results <results>\n\n#rep\n'
				};
				assert.equal((await editor.project(changed, { packages })).status, 200);
				await editor.notify('textDocument/didChange', {
					textDocument: { uri: 'file:///project/main.typ', version: 2 },
					contentChanges: [{ text: changed['main.typ'] }]
				});
				const offered = await editor.completions('main.typ', 4, 4, 'replyall');
				assert.ok(offered.includes('reply'), 'a definition added to another file');
				assert.ok(offered.includes('replyall'), 'a function from a package supplied later');
			} finally {
				editor.close();
				await harness.close();
			}
		});

		test('lets no request through that could write, export or leave the project', async () => {
			const harness = await start();
			const editor = new Editor(harness, 'editor-3');
			try {
				await editor.start({ ...project, 'main.typ': 'Text\n#read("/etc/hostname")\n' });
				await editor.open('main.typ', 'Text\n#read("/etc/hostname")\n');

				// The server's own commands, such as exporting a PDF beside the source.
				for (const command of [
					'tinymist.exportPdf',
					'tinymist.doStartPreview',
					'tinymist.pinMain'
				]) {
					const refused = await editor.request('workspace/executeCommand', {
						command,
						arguments: ['/etc/hostname']
					});
					assert.equal(refused.error?.code, -32601, command);
				}
				const [session] = await readdir(path.join(harness.workDir, 'language'));
				const written = await readdir(path.join(harness.workDir, 'language', session!), {
					recursive: true
				});
				assert.deepEqual(
					written.filter((name) => /\.(pdf|svg|png|html)$/.test(name)),
					[]
				);

				// Files outside the project cannot be named, however the path is spelled.
				for (const uri of [
					'file:///etc/hostname',
					'file:///project/../../../etc/hostname',
					'file:///project/%2e%2e/%2e%2e/etc/hostname',
					'file:///projectile/main.typ',
					'https://example.org/main.typ'
				]) {
					const answer = await editor.request('textDocument/hover', {
						textDocument: { uri },
						position: { line: 0, character: 1 }
					});
					assert.equal(answer.error?.code, -32601, uri);
				}
				await editor.notify('textDocument/didOpen', {
					textDocument: { uri: 'file:///etc/hostname', languageId: 'typst', version: 1, text: 'x' }
				});

				// The settings the editor asked for at the start were not taken either:
				// the document still cannot read outside its project.
				const hostname = readFileSync('/etc/hostname', 'utf8').trim();
				await new Promise((resolve) => setTimeout(resolve, 1500));
				const diagnostics = editor.received
					.filter((message) => message.method === 'textDocument/publishDiagnostics')
					.flatMap((message) => message.params.diagnostics as { message: string }[]);
				assert.ok(diagnostics.length > 0, 'reading outside the project is an error');
				assert.ok(!editor.transcript.includes(hostname) || hostname.length < 3);
			} finally {
				editor.close();
				await harness.close();
			}
		});

		test('is bounded in number and stopped with its editor', async () => {
			const harness = await start({ KERNIC_LANGUAGE_SESSIONS: '1' });
			const first = new Editor(harness, 'editor-a');
			const second = new Editor(harness, 'editor-b');
			try {
				await first.start(project);
				assert.equal(runningServers().length, 1);

				const refused = await second.project(project);
				assert.equal(refused.status, 503);
				assert.match(((await refused.json()) as { error: string }).error, /as many editors/);

				await first.stop();
				await new Promise((resolve) => setTimeout(resolve, 200));
				assert.equal(first.ended, true, 'the stream ends with the server');
				assert.equal(await first.notify('initialized', {}), 404);

				await second.start(project);
				assert.equal(runningServers().length, 1);
			} finally {
				first.close();
				second.close();
				await harness.close();
			}
			assert.equal(runningServers().length, 0, 'closing the worker stops its language servers');
		});
	});
}

describe('editor assistance, availability', () => {
	test('can be turned off, and says so', async () => {
		const harness = await startWorker({ KERNIC_LANGUAGE_SESSIONS: '0' });
		try {
			const health = (await (await fetch(`${harness.baseUrl}/healthz`)).json()) as any;
			assert.equal(health.editorAssistance, false);
			const refused = await new Editor(harness, 'editor-off').project(project);
			assert.equal(refused.status, 503);
		} finally {
			await harness.close();
		}
	});

	test('is off where Tinymist is not installed', async () => {
		const harness = await startWorker({ KERNIC_TINYMIST_BIN: 'no-such-tinymist' });
		try {
			const health = (await (await fetch(`${harness.baseUrl}/healthz`)).json()) as any;
			assert.equal(health.editorAssistance, false);
			assert.equal((await new Editor(harness, 'editor-none').project(project)).status, 503);
		} finally {
			await harness.close();
		}
	});

	test('needs the worker token and a plain name', async () => {
		const harness = await startWorker();
		try {
			const anonymous = await fetch(`${harness.baseUrl}/lsp/editor-x`, {
				method: 'POST',
				body: '{}'
			});
			assert.equal(anonymous.status, 401);
			const odd = await fetch(`${harness.baseUrl}/lsp/..%2Fx/stream`, { headers: auth });
			assert.equal(odd.status, 404);
			const unknown = await fetch(`${harness.baseUrl}/lsp/nobody/stream`, { headers: auth });
			assert.equal(unknown.status, 404);
		} finally {
			await harness.close();
		}
	});
});
