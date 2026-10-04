import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CompileLimits, SandboxMode } from './config.ts';

const execFileAsync = promisify(execFile);

export interface Toolchain {
	typstPath: string;
	typstVersion: string;
	prlimitPath: string;
	bwrapPath: string | null;
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
			'KERN_WORKER_SANDBOX=bwrap but bubblewrap is not installed. Install it, or set ' +
				'KERN_WORKER_SANDBOX=none when the worker already runs in a locked-down container.'
		);
	}

	const { stdout } = await execFileAsync(typstPath, ['--version'], { timeout: 10_000 });
	const typstVersion = /typst (\S+)/.exec(stdout)?.[1] ?? stdout.trim();

	return { typstPath, typstVersion, prlimitPath, bwrapPath };
}

/** Typst arguments, with paths as seen from inside the (possibly remapped) job. */
function typstArgs(
	format: 'svg' | 'pdf',
	entry: string,
	paths: JobPaths,
	limits: CompileLimits
): string[] {
	const output =
		format === 'svg'
			? path.join(paths.outputDir, 'page-{0p}.svg')
			: path.join(paths.outputDir, 'output.pdf');

	const args = [
		'compile',
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
	args.push(path.join(paths.sourceDir, entry), output);
	return args;
}

function rlimitArgs(limits: CompileLimits): string[] {
	const cpuSeconds = Math.ceil(limits.timeoutMs / 1000) * limits.typstJobs;
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
 * Builds the command that compiles one job.
 *
 * `prlimit` always applies per-process resource limits. With the `bwrap`
 * sandbox the compiler additionally runs in fresh namespaces: no network, an
 * empty environment, and a filesystem that only contains system libraries, the
 * read-only snapshot and the writable output directory.
 */
export function buildCompileCommand(
	toolchain: Toolchain,
	sandbox: SandboxMode,
	format: 'svg' | 'pdf',
	entry: string,
	paths: JobPaths,
	limits: CompileLimits
): Command {
	const limitsPrefix = [...rlimitArgs(limits), '--'];

	if (sandbox === 'none') {
		return {
			file: toolchain.prlimitPath,
			args: [...limitsPrefix, toolchain.typstPath, ...typstArgs(format, entry, paths, limits)],
			cwd: paths.sourceDir,
			env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: paths.packageCacheDir }
		};
	}

	if (!toolchain.bwrapPath) throw new Error('bubblewrap is not available');

	const inside: JobPaths = {
		sourceDir: '/job/src',
		outputDir: '/job/out',
		packageCacheDir: '/job/package-cache',
		packageDir: paths.packageDir ? '/job/packages' : null
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
		'/kern/typst',
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
	bwrapArgs.push('--chdir', inside.sourceDir, '--', '/kern/typst');

	return {
		file: toolchain.prlimitPath,
		args: [
			...limitsPrefix,
			toolchain.bwrapPath,
			...bwrapArgs,
			...typstArgs(format, entry, inside, limits)
		],
		cwd: paths.sourceDir,
		env: {}
	};
}
