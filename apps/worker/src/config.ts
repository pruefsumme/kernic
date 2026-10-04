import { tmpdir } from 'node:os';
import path from 'node:path';

export type SandboxMode = 'bwrap' | 'none';

export interface WorkerConfig {
	host: string;
	port: number;
	/** Shared secret presented by the app. It only guards this worker; it is not an app secret. */
	token: string;
	workDir: string;
	typstBin: string;
	sandbox: SandboxMode;
	/** Optional read-only directory with vendored Typst packages (`--package-path`). */
	packageDir: string | null;
	limits: CompileLimits;
}

export interface CompileLimits {
	timeoutMs: number;
	/** Address-space cap for one compile (RLIMIT_AS). */
	memoryBytes: number;
	/** Largest single output file (RLIMIT_FSIZE) and cap on the total output of one job. */
	outputBytes: number;
	maxPages: number;
	maxSnapshotFiles: number;
	maxSnapshotBytes: number;
	maxBlobBytes: number;
	blobCacheBytes: number;
	maxConcurrent: number;
	maxQueued: number;
	/** Threads Typst may use for one compile. */
	typstJobs: number;
}

const MiB = 1024 * 1024;

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1): number {
	const raw = env[name];
	if (raw === undefined || raw === '') return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min) {
		throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
	}
	return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
	const token = env.KERN_WORKER_TOKEN ?? '';
	if (token.length < 24) {
		throw new Error('KERN_WORKER_TOKEN must be set to a random string of at least 24 characters');
	}

	const sandbox = env.KERN_WORKER_SANDBOX ?? 'bwrap';
	if (sandbox !== 'bwrap' && sandbox !== 'none') {
		throw new Error(`KERN_WORKER_SANDBOX must be "bwrap" or "none", got "${sandbox}"`);
	}

	return {
		host: env.KERN_WORKER_HOST ?? '127.0.0.1',
		port: integer(env, 'KERN_WORKER_PORT', 3101),
		token,
		workDir: path.resolve(env.KERN_WORKER_DIR ?? path.join(tmpdir(), 'kern-worker')),
		typstBin: env.KERN_TYPST_BIN ?? 'typst',
		sandbox,
		packageDir: env.KERN_WORKER_PACKAGE_DIR ? path.resolve(env.KERN_WORKER_PACKAGE_DIR) : null,
		limits: {
			timeoutMs: integer(env, 'KERN_COMPILE_TIMEOUT_MS', 20_000),
			memoryBytes: integer(env, 'KERN_COMPILE_MEMORY_MB', 4096) * MiB,
			outputBytes: integer(env, 'KERN_COMPILE_OUTPUT_MB', 48) * MiB,
			maxPages: integer(env, 'KERN_COMPILE_MAX_PAGES', 1000),
			maxSnapshotFiles: integer(env, 'KERN_SNAPSHOT_MAX_FILES', 5000),
			maxSnapshotBytes: integer(env, 'KERN_SNAPSHOT_MAX_MB', 256) * MiB,
			maxBlobBytes: integer(env, 'KERN_BLOB_MAX_MB', 32) * MiB,
			blobCacheBytes: integer(env, 'KERN_BLOB_CACHE_MB', 1024) * MiB,
			maxConcurrent: integer(env, 'KERN_WORKER_CONCURRENCY', 2),
			maxQueued: integer(env, 'KERN_WORKER_QUEUE', 16, 0),
			typstJobs: integer(env, 'KERN_TYPST_JOBS', 2)
		}
	};
}
