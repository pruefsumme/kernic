import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CompileLimits, SandboxMode } from './config.ts';
import { pdfArguments, type PdfOptions } from './pdf-options.ts';

const execFileAsync = promisify(execFile);

export interface Toolchain {
	typstPath: string;
	typstVersion: string;
	prlimitPath: string;
	bwrapPath: string | null;
	setprivPath: string | null;
}

export interface JobPaths {
	/** Materialized project snapshot; Typst may only read from here. */
	sourceDir: string;
	/** The only directory Typst may write to. */
	outputDir: string;
	/** Empty directory handed to Typst as its package download cache. */
	packageCacheDir: string;
	/** Vendored packages, or null if none are installed. */
	packageDir: string | null;
}

export interface Command {
	file: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
}

function findExecutable(name: string): string | null {
	const candidates = name.includes('/')
		? [path.resolve(name)]
		: (process.env.PATH ?? '').split(':').map((dir) => path.join(dir, name));

	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return realpathSync(candidate);
		} catch {
			// try the next PATH entry
		}
	}
	return null;
}

/** Resolves the binaries the worker needs and fails early if the configured sandbox is unavailable. */
export async function detectToolchain(typstBin: string, sandbox: SandboxMode): Promise<Toolchain> {
	const typstPath = findExecutable(typstBin);
	if (!typstPath) throw new Error(`Typst binary "${typstBin}" was not found`);

	const prlimitPath = findExecutable('prlimit');
	if (!prlimitPath) throw new Error('prlimit (util-linux) is required to bound compile resources');

	const bwrapPath = findExecutable('bwrap');
	if (sandbox === 'bwrap' && !bwrapPath) {
		// Refuse to start rather than silently compile untrusted documents unsandboxed.
		throw new Error(
			'KERNIC_WORKER_SANDBOX=bwrap but bubblewrap is not installed. Install it, or set ' +
				'KERNIC_WORKER_SANDBOX=none when the worker already runs in a locked-down container.'
		);
	}

	const setprivPath = findExecutable('setpriv');
	if (sandbox === 'landlock') {
		if (!setprivPath) throw new Error('KERNIC_WORKER_SANDBOX=landlock needs setpriv (util-linux).');
		await assertLandlockWorks(setprivPath);
	}

	const { stdout } = await execFileAsync(typstPath, ['--version'], { timeout: 10_000 });
	const typstVersion = /typst (\S+)/.exec(stdout)?.[1] ?? stdout.trim();

	return { typstPath, typstVersion, prlimitPath, bwrapPath, setprivPath };
}

const READ = 'read-file,read-dir';
const READ_EXECUTE = `${READ},execute`;
const READ_WRITE = `${READ},write-file,make-reg,remove-file,truncate`;

/** Directories with programs, libraries, fonts and font configuration. */
function systemReadRules(): string[] {
	const rules: string[] = [];
	for (const directory of ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
		// Symlinked directories (merged /usr) are covered by the rule for their target.
		if (existsSync(directory) && !lstatSync(directory).isSymbolicLink()) {
			rules.push('--landlock-rule', `path-beneath:${READ_EXECUTE}:${directory}`);
		}
	}
	for (const directory of ['/etc/fonts', '/var/cache/fontconfig']) {
		if (existsSync(directory)) rules.push('--landlock-rule', `path-beneath:${READ}:${directory}`);
	}
	return rules;
}

/**
 * Proves at startup that Landlock is enforced: a restricted process must be
 * able to run, and must be denied a file outside its rules. Without this, a
 * kernel or util-linux without Landlock support could leave compiles
 * unconfined while the configuration claims otherwise.
 */
async function assertLandlockWorks(setprivPath: string): Promise<void> {
	const base = ['--landlock-access', 'fs', ...systemReadRules(), '--'];
	const catPath = findExecutable('cat');
	if (!catPath) throw new Error('cat is required for the Landlock self-test');

	try {
		await execFileAsync(setprivPath, [...base, catPath, '/usr/lib/os-release'], {
			timeout: 10_000
		});
	} catch (error) {
		throw new Error(
			'KERNIC_WORKER_SANDBOX=landlock, but a Landlock-restricted process cannot run here. ' +
				'It needs Linux 5.13 or newer and util-linux 2.40 or newer. ' +
				`(${(error as Error).message.split('\n')[0]})`
		);
	}

	const denied = await execFileAsync(setprivPath, [...base, catPath, '/proc/self/environ'], {
		timeout: 10_000
	}).then(
		() => false,
		() => true
	);
	if (!denied) {
		throw new Error('Landlock is not enforced: a restricted process could read outside its rules.');
	}
}

/**
 * Where the compiler sees a job's files, which is what its messages mention.
 * These are internal places that mean nothing to the author of a document.
 */
export function compilerView(sandbox: SandboxMode, paths: JobPaths): JobPaths {
	return sandbox === 'bwrap' ? INSIDE_BWRAP : paths;
}

const INSIDE_BWRAP: JobPaths = {
	sourceDir: '/job/src',
	outputDir: '/job/out',
	packageCacheDir: '/job/package-cache',
	packageDir: '/job/packages'
};

/** Name of the file, in the output directory, that a watching compiler writes after each compile. */
export const DEPENDENCIES_FILE = 'deps.json';

/**
 * `compile` runs once and exits. `watch` keeps the compiler running: it
 * compiles again when a source file changes and reuses what it computed before.
 */
export type CompilerMode = 'compile' | 'watch';

/** How much more processor time a watching compiler may use in its life than one compile. */
const WATCH_CPU_FACTOR = 20;

/** Typst arguments, with paths as seen from inside the (possibly remapped) job. */
function typstArgs(
	mode: CompilerMode,
	format: 'svg' | 'pdf',
	entry: string,
	paths: JobPaths,
	limits: CompileLimits,
	pdf: PdfOptions | null
): string[] {
	const output =
		format === 'svg'
			? path.join(paths.outputDir, 'page-{0p}.svg')
			: path.join(paths.outputDir, 'output.pdf');

	const args = [
		mode,
		'--root',
		paths.sourceDir,
		// Fonts uploaded into the project are picked up from anywhere in its tree.
		'--font-path',
		paths.sourceDir,
		'--package-cache-path',
		paths.packageCacheDir,
		'--diagnostic-format',
		'short',
		'--jobs',
		String(limits.typstJobs),
		'--format',
		format
	];
	if (paths.packageDir) args.push('--package-path', paths.packageDir);
	if (format === 'pdf' && pdf) args.push(...pdfArguments(pdf));
	if (mode === 'watch') {
		// Written last in every compile, which tells the worker that one has finished.
		args.push('--deps', path.join(paths.outputDir, DEPENDENCIES_FILE), '--deps-format', 'json');
	}
	args.push(path.join(paths.sourceDir, entry), output);
	return args;
}

function rlimitArgs(limits: CompileLimits, mode: CompilerMode): string[] {
	// A watching compiler serves many compiles; the worker times each of them,
	// and this bounds what the process may use over its whole life.
	const cpuSeconds =
		Math.ceil(limits.timeoutMs / 1000) *
		limits.typstJobs *
		(mode === 'watch' ? WATCH_CPU_FACTOR : 1);
	return [
		`--as=${limits.memoryBytes}`,
		`--fsize=${limits.outputBytes}`,
		`--cpu=${cpuSeconds}`,
		'--nofile=512',
		'--core=0'
	];
}

/**
 * Mount arguments that expose the host's system directories read-only. `/bin`,
 * `/lib` and friends are symlinks into `/usr` on merged-usr distributions and
 * real directories elsewhere, so mirror whichever layout the host has.
 */
function systemMounts(): string[] {
	const args = ['--ro-bind', '/usr', '/usr'];
	for (const dir of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
		if (!existsSync(dir)) continue;
		if (lstatSync(dir).isSymbolicLink()) args.push('--symlink', readlinkSync(dir), dir);
		else args.push('--ro-bind', dir, dir);
	}
	// Fontconfig configuration; the font files themselves live under /usr.
	if (existsSync('/etc/fonts')) args.push('--ro-bind', '/etc/fonts', '/etc/fonts');
	return args;
}

/**
 * Builds the command that compiles one job, or that keeps compiling it (`watch`).
 *
 * `prlimit` always applies per-process resource limits. With the `bwrap`
 * sandbox the compiler additionally runs in fresh namespaces: no network, an
 * empty environment, and a filesystem that only contains system libraries, the
 * read-only snapshot and the writable output directory. With `landlock` it
 * keeps the worker's view but may only open those same places.
 */
export function buildCompileCommand(
	toolchain: Toolchain,
	sandbox: SandboxMode,
	format: 'svg' | 'pdf',
	entry: string,
	paths: JobPaths,
	limits: CompileLimits,
	mode: CompilerMode = 'compile',
	pdf: PdfOptions | null = null
): Command {
	const limitsPrefix = [...rlimitArgs(limits, mode), '--'];
	// A long-lived compiler must not outlive a worker that crashed. bubblewrap
	// has its own switch for this; elsewhere setpriv arranges it.
	const dieWithWorker = mode === 'watch' ? ['--pdeathsig', 'KILL'] : [];

	if (sandbox === 'none') {
		const wrapper =
			toolchain.setprivPath && dieWithWorker.length > 0
				? [toolchain.setprivPath, ...dieWithWorker, '--']
				: [];
		return {
			file: toolchain.prlimitPath,
			args: [
				...limitsPrefix,
				...wrapper,
				toolchain.typstPath,
				...typstArgs(mode, format, entry, paths, limits, pdf)
			],
			cwd: paths.sourceDir,
			env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.packageCacheDir }
		};
	}

	if (sandbox === 'landlock') {
		if (!toolchain.setprivPath) throw new Error('setpriv is not available');
		// The compiler keeps its real paths but can reach nothing beyond these rules:
		// in particular not the files of other jobs or the worker's cache.
		const rules = [
			...systemReadRules(),
			// The compiler itself, in case it is installed outside the system directories.
			'--landlock-rule',
			`path-beneath:read-file,execute:${toolchain.typstPath}`,
			'--landlock-rule',
			`path-beneath:${READ}:${paths.sourceDir}`,
			'--landlock-rule',
			`path-beneath:${READ}:${paths.packageCacheDir}`,
			'--landlock-rule',
			`path-beneath:${READ_WRITE}:${paths.outputDir}`
		];
		if (paths.packageDir) rules.push('--landlock-rule', `path-beneath:${READ}:${paths.packageDir}`);

		return {
			file: toolchain.prlimitPath,
			args: [
				...limitsPrefix,
				toolchain.setprivPath,
				...dieWithWorker,
				'--landlock-access',
				'fs',
				...rules,
				'--',
				toolchain.typstPath,
				...typstArgs(mode, format, entry, paths, limits, pdf)
			],
			cwd: paths.sourceDir,
			env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.packageCacheDir }
		};
	}

	if (!toolchain.bwrapPath) throw new Error('bubblewrap is not available');

	const inside: JobPaths = {
		...INSIDE_BWRAP,
		packageDir: paths.packageDir ? INSIDE_BWRAP.packageDir : null
	};

	const bwrapArgs = [
		'--unshare-all',
		'--die-with-parent',
		'--new-session',
		'--clearenv',
		'--setenv',
		'PATH',
		'/usr/bin:/bin',
		'--setenv',
		'HOME',
		'/tmp',
		...systemMounts(),
		'--proc',
		'/proc',
		'--dev',
		'/dev',
		'--tmpfs',
		'/tmp',
		'--ro-bind',
		toolchain.typstPath,
		'/kernic/typst',
		'--ro-bind',
		paths.sourceDir,
		inside.sourceDir,
		'--bind',
		paths.outputDir,
		inside.outputDir,
		'--ro-bind',
		paths.packageCacheDir,
		inside.packageCacheDir
	];
	if (paths.packageDir && inside.packageDir) {
		bwrapArgs.push('--ro-bind', paths.packageDir, inside.packageDir);
	}
	bwrapArgs.push('--chdir', inside.sourceDir, '--', '/kernic/typst');

	return {
		file: toolchain.prlimitPath,
		args: [
			...limitsPrefix,
			toolchain.bwrapPath,
			...bwrapArgs,
			...typstArgs(mode, format, entry, inside, limits, pdf)
		],
		cwd: paths.sourceDir,
		env: {}
	};
}
