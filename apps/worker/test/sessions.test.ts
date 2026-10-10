import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { compile, startWorker, type Harness, type PackageSource } from './harness.ts';

/**
 * A compiler that stays running between compiles must be an optimisation only:
 * whatever it returns has to be exactly what a compile from scratch returns.
 * Most tests here therefore compile every state twice and compare.
 */

type Files = Record<string, string>;

/** What a compile says about a document, without timing and transport details. */
function essence(body: any) {
	return {
		ok: body.ok,
		diagnostics: body.diagnostics,
		pages: body.artifacts.map((artifact: any) => ({
			name: artifact.name,
			sha256: artifact.sha256,
			width: artifact.width,
			height: artifact.height
		}))
	};
}

async function compileBoth(
	harness: Harness,
	files: Files,
	options: { entry?: string; packages?: PackageSource[]; session?: string } = {}
) {
	const session = options.session ?? 'project-1';
	const warm = await compile(harness, files, { ...options, session });
	const cold = await compile(harness, files, { ...options, session: undefined });
	assert.equal(warm.status, 200);
	assert.equal(cold.body.warm, false);
	assert.deepEqual(essence(warm.body), essence(cold.body));
	return warm.body;
}

function parentOf(pid: number): number {
	try {
		return Number(/^PPid:\s+(\d+)$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0);
	} catch {
		return 0;
	}
}

/**
 * Process ids of the compilers kept running by workers of this test process.
 * Found by descent, so that compilers of a development server are not counted.
 */
function runningCompilers(): number[] {
	return readdirSync('/proc')
		.filter((entry) => /^\d+$/.test(entry))
		.map(Number)
		.filter((pid) => {
			try {
				const command = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
				// Wrappers carry the same arguments; only the compiler itself is counted.
				if (path.basename(command[0] ?? '') !== 'typst' || !command.includes('watch')) return false;
			} catch {
				return false;
			}
			for (let ancestor = parentOf(pid); ancestor > 1; ancestor = parentOf(ancestor)) {
				if (ancestor === process.pid) return true;
			}
			return false;
		});
}

const sandboxes: { mode: string; available: boolean }[] = [
	{ mode: 'bwrap', available: existsSync('/usr/bin/bwrap') },
	{
		mode: 'landlock',
		available: execFileSync('setpriv', ['--help']).toString().includes('landlock')
	},
	{ mode: 'none', available: true }
];

for (const { mode, available } of sandboxes) {
	describe(`a compiler kept running, sandbox ${mode}`, { skip: !available }, () => {
		const start = (env: Record<string, string> = {}) =>
			startWorker({ KERNIC_WORKER_SANDBOX: mode, ...env });

		test('gives the same result as compiling from scratch, edit after edit', async () => {
			const harness = await start();
			try {
				const files: Files = {
					'main.typ': '#include "chapters/one.typ"\n= Main\nText\n#pagebreak()\nSecond page',
					'chapters/one.typ': '== One\nBody',
					'notes.typ': 'never included'
				};
				const first = await compileBoth(harness, files);
				assert.equal(first.ok, true, JSON.stringify(first.diagnostics));
				assert.equal(first.warm, false, 'the first compile starts the compiler');
				assert.equal(first.artifacts.length, 2);

				// A file the document includes.
				files['chapters/one.typ'] = '== One\nBody, edited';
				const second = await compileBoth(harness, files);
				assert.equal(second.warm, true);
				assert.notEqual(second.artifacts[0].sha256, first.artifacts[0].sha256);
				assert.equal(second.artifacts[1].sha256, first.artifacts[1].sha256);

				// A file the document does not use: same pages, and still an answer.
				files['notes.typ'] = 'still not included';
				const third = await compileBoth(harness, files);
				assert.equal(third.warm, true);
				assert.deepEqual(essence(third), essence(second));

				// Nothing changed at all.
				const again = await compileBoth(harness, files);
				assert.equal(again.warm, true);

				// An error, with its location, and then the fix.
				files['main.typ'] = '#include "chapters/one.typ"\n= Main\n#let broken = (\n';
				const broken = await compileBoth(harness, files);
				assert.equal(broken.warm, true);
				assert.equal(broken.ok, false);
				assert.equal(broken.diagnostics[0].path, 'main.typ');
				assert.deepEqual(broken.artifacts, []);

				files['main.typ'] =
					'#include "chapters/one.typ"\n= Main\n#set text(font: "No Such Font")\nOne page';
				const fixed = await compileBoth(harness, files);
				assert.equal(fixed.warm, true);
				assert.equal(fixed.ok, true);
				assert.equal(fixed.diagnostics[0].severity, 'warning');
				// The document became shorter: the page that is gone must not come back.
				assert.equal(fixed.artifacts.length, 1);
			} finally {
				await harness.close();
			}
		});

		test('follows files that appear, disappear and change their kind', async () => {
			const harness = await start();
			try {
				const files: Files = { 'main.typ': '#include "part.typ"\nMain' };
				const missing = await compileBoth(harness, files);
				assert.equal(missing.ok, false);
				// The message names the file as the author knows it, not where the job ran.
				assert.equal(missing.diagnostics[0].message, 'file not found (searched at part.typ)');

				files['part.typ'] = 'Part';
				assert.equal((await compileBoth(harness, files)).ok, true);

				// `part.typ` turns into a folder, and a folder into a file.
				delete files['part.typ'];
				files['part.typ/inner.typ'] = 'Inner';
				files['main.typ'] = '#include "part.typ/inner.typ"\nMain';
				assert.equal((await compileBoth(harness, files)).ok, true);

				delete files['part.typ/inner.typ'];
				files['part.typ'] = 'A file again';
				files['main.typ'] = '#include "part.typ"\nMain';
				const back = await compileBoth(harness, files);
				assert.equal(back.ok, true, JSON.stringify(back.diagnostics));
				assert.equal(back.warm, true);

				delete files['part.typ'];
				const gone = await compileBoth(harness, files);
				assert.equal(gone.ok, false);
				assert.match(gone.diagnostics[0].message, /file not found/);

				// An empty main file still compiles, to one empty page.
				files['main.typ'] = '';
				const empty = await compileBoth(harness, files);
				assert.equal(empty.ok, true);
				assert.equal(empty.warm, true);
				assert.equal((await compileBoth(harness, files)).warm, true);
			} finally {
				await harness.close();
			}
		});

		test('provides packages that are first imported later', async () => {
			const harness = await start();
			try {
				const packages: PackageSource[] = [
					{
						namespace: 'preview',
						name: 'greeting',
						version: '0.1.0',
						files: {
							'typst.toml':
								'[package]\nname = "greeting"\nversion = "0.1.0"\nentrypoint = "lib.typ"',
							'lib.typ': '#let greet(name) = [Hello, #name!]'
						}
					}
				];
				assert.equal((await compileBoth(harness, { 'main.typ': 'No package yet' })).ok, true);

				const source = { 'main.typ': '#import "@preview/greeting:0.1.0": greet\n#greet("Ada")' };
				const without = await compileBoth(harness, source);
				assert.equal(without.ok, false, 'the package was not supplied');

				const supplied = await compileBoth(harness, source, { packages });
				assert.equal(supplied.ok, true, JSON.stringify(supplied.diagnostics));
				assert.equal(supplied.warm, true);
			} finally {
				await harness.close();
			}
		});

		test('answers every one of several simultaneous requests with its own pages', async () => {
			const harness = await start();
			try {
				const versions = Array.from({ length: 6 }, (_, index) => ({
					'main.typ': `= Version ${index}\n${'word '.repeat(index + 1)}`
				}));
				const expected: ReturnType<typeof essence>[] = [];
				for (const files of versions) expected.push(essence((await compile(harness, files)).body));

				const answers = await Promise.all(
					versions.map((files) => compile(harness, files, { session: 'busy-project' }))
				);
				answers.forEach((answer, index) => {
					assert.deepEqual(essence(answer.body), expected[index]);
				});
				assert.ok(answers.some((answer) => answer.body.warm));
			} finally {
				await harness.close();
			}
		});

		test('keeps projects apart and stops the compiler used longest ago', async () => {
			const harness = await start({ KERNIC_WARM_SESSIONS: '2' });
			try {
				for (const session of ['a', 'b', 'c']) {
					const body = await compileBoth(
						harness,
						{ 'main.typ': `Project ${session}` },
						{ session }
					);
					assert.equal(body.warm, false);
				}
				assert.equal(runningCompilers().length, 2);
				assert.equal((await readdir(path.join(harness.workDir, 'sessions'))).length, 2);

				// `b` and `c` are still running, `a` had to make room.
				for (const session of ['b', 'c']) {
					const body = await compileBoth(
						harness,
						{ 'main.typ': `Project ${session}!` },
						{ session }
					);
					assert.equal(body.warm, true);
				}
				const evicted = await compileBoth(harness, { 'main.typ': 'Project a!' }, { session: 'a' });
				assert.equal(evicted.warm, false);

				// Another main file means another compiler.
				const other = await compileBoth(
					harness,
					{ 'main.typ': 'Project a!', 'other.typ': 'Other entry' },
					{ session: 'a', entry: 'other.typ' }
				);
				assert.equal(other.warm, false);
				assert.equal(runningCompilers().length, 2);
			} finally {
				await harness.close();
			}
			assert.equal(runningCompilers().length, 0, 'closing the worker stops its compilers');
		});

		test('recovers when its compiler dies, with the right result', async () => {
			const harness = await start();
			try {
				assert.equal((await compileBoth(harness, { 'main.typ': 'One' })).ok, true);
				const [pid] = runningCompilers();
				assert.ok(pid, 'a compiler is running');
				process.kill(pid, 'SIGKILL');

				const after = await compileBoth(harness, { 'main.typ': 'Two' });
				assert.equal(after.ok, true);
				assert.equal(after.warm, false);
				assert.equal((await compileBoth(harness, { 'main.typ': 'Three' })).warm, true);
			} finally {
				await harness.close();
			}
		});

		test('does not trust a compiler that compiled without being asked', async () => {
			const harness = await start();
			try {
				assert.equal((await compileBoth(harness, { 'main.typ': 'One' })).ok, true);
				// Touch the session's main file behind the worker's back.
				const [session] = await readdir(path.join(harness.workDir, 'sessions'));
				const main = path.join(harness.workDir, 'sessions', session!, 'src', 'main.typ');
				execFileSync('sh', ['-c', `printf 'Tampered' > '${main}'`]);
				await new Promise((resolve) => setTimeout(resolve, 600));

				const after = await compileBoth(harness, { 'main.typ': 'Two' });
				assert.equal(after.ok, true);
				assert.equal(after.warm, false, 'the session was replaced');
			} finally {
				await harness.close();
			}
		});

		test('a document cannot read outside its project', async () => {
			const harness = await start();
			try {
				assert.equal((await compileBoth(harness, { 'main.typ': 'Harmless' })).ok, true);
				const body = await compileBoth(harness, {
					'main.typ': '#read("/etc/hostname")\n#read("../../../../etc/hostname")'
				});
				assert.equal(body.warm, true);
				assert.equal(body.ok, false);
			} finally {
				await harness.close();
			}
		});
	});
}

describe('limits of a compiler kept running', () => {
	test('a compile that takes too long is stopped, and the project recovers', async () => {
		const harness = await startWorker({ KERNIC_COMPILE_TIMEOUT_MS: '1500' });
		try {
			const session = 'slow-project';
			assert.equal((await compile(harness, { 'main.typ': 'Quick' }, { session })).body.ok, true);

			const startedAt = Date.now();
			const { body } = await compile(
				harness,
				{
					'main.typ':
						'#{\n let x = 0\n for i in range(100000) { for j in range(100000) { x += 1 } }\n}'
				},
				{ session }
			);
			assert.equal(body.ok, false);
			assert.equal(body.timedOut, true);
			assert.match(body.diagnostics.at(-1).message, /stopped after/);
			assert.ok(Date.now() - startedAt < 4000, 'not compiled a second time from scratch');
			assert.deepEqual(runningCompilers(), []);

			const after = await compile(harness, { 'main.typ': 'Quick again' }, { session });
			assert.equal(after.body.ok, true);
		} finally {
			await harness.close();
		}
	});

	test('a compiler that grew too large is replaced before its next compile', async () => {
		const harness = await startWorker({ KERNIC_WARM_MEMORY_MB: '1' });
		try {
			const session = 'large-project';
			for (const text of ['One', 'Two', 'Three']) {
				const { body } = await compile(harness, { 'main.typ': text }, { session });
				assert.equal(body.ok, true);
				assert.equal(body.warm, false, 'every compile starts a fresh compiler');
			}
			assert.equal(runningCompilers().length, 1);
		} finally {
			await harness.close();
		}
	});

	test('can be turned off', async () => {
		const harness = await startWorker({ KERNIC_WARM_SESSIONS: '0' });
		try {
			for (const text of ['One', 'Two']) {
				const { body } = await compile(harness, { 'main.typ': text }, { session: 'p' });
				assert.equal(body.ok, true);
				assert.equal(body.warm, false);
			}
			assert.deepEqual(runningCompilers(), []);
		} finally {
			await harness.close();
		}
	});

	test('is not used for PDF export or without a session name', async () => {
		const harness = await startWorker();
		try {
			const files = { 'main.typ': 'Document' };
			await compile(harness, files, { session: 'p' });
			const pdf = await compile(harness, files, { session: 'p', format: 'pdf' });
			assert.equal(pdf.body.ok, true);
			assert.equal(pdf.body.warm, false);
			assert.equal((await compile(harness, files)).body.warm, false);
			assert.equal((await compile(harness, files, { session: 'p' })).body.warm, true);
		} finally {
			await harness.close();
		}
	});

	test('rejects session names that are not plain identifiers', async () => {
		const harness = await startWorker();
		try {
			for (const session of ['../x', 'a b', '', 'x'.repeat(65)]) {
				const { status } = await compile(harness, { 'main.typ': 'x' }, { session });
				assert.equal(status, 400, `expected "${session}" to be rejected`);
			}
		} finally {
			await harness.close();
		}
	});

	test('survives many random edits with identical results', async () => {
		const harness = await startWorker();
		try {
			// A fixed sequence, so that a failure can be reproduced.
			let seed = 20261012;
			const random = (limit: number) => {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				return seed % limit;
			};
			const files: Files = {
				'main.typ': '#include "a.typ"\n#include "b.typ"\n= Main\n',
				'a.typ': '== A\n',
				'b.typ': '== B\n'
			};
			let warmCompiles = 0;
			for (let round = 0; round < 40; round++) {
				const name = ['main.typ', 'a.typ', 'b.typ'][random(3)]!;
				const action = random(5);
				if (action === 0) files[name] += '#pagebreak()\n';
				else if (action === 1)
					files[name] = files[name]!.split('\n').slice(0, -2).join('\n') + '\n';
				else files[name] += `Sentence ${round} with ${random(1000)} words.\n`;
				if (!files['main.typ']!.includes('#include "a.typ"')) {
					files['main.typ'] = '#include "a.typ"\n#include "b.typ"\n' + files['main.typ'];
				}
				const body = await compileBoth(harness, files, { session: 'random' });
				if (body.warm) warmCompiles++;
			}
			assert.ok(warmCompiles >= 38, `only ${warmCompiles} of 40 compiles were warm`);
		} finally {
			await harness.close();
		}
	});
});
