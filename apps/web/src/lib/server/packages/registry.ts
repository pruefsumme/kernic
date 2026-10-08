import { KERNIC_PACKAGE_REGISTRY } from '$app/env/private';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { packagesDir } from '../config';
import { scanTypstSource } from '../imports/scan';
import { isValidProjectPath } from '../projects/paths';
import { listTree } from '../projects/tree';

/**
 * Typst packages (`#import "@preview/name:1.2.3"`).
 *
 * Documents are compiled without network access, so the app fetches packages
 * itself — only from the configured registry, only the `preview` namespace —
 * unpacks them with the same distrust as any upload, and hands the files to the
 * worker with the compile request. A downloaded version is kept and never
 * fetched again, so what a document compiles against does not change under it.
 */

export interface PackageFile {
	path: string;
	sha256: string;
	size: number;
}

export interface InstalledPackage {
	/** `@preview/name:1.2.3` */
	spec: string;
	namespace: string;
	name: string;
	version: string;
	/** Directory holding the unpacked files. */
	directory: string;
	files: PackageFile[];
	/** Packages this one imports. */
	dependencies: string[];
}

export interface PackageFailure {
	spec: string;
	/** Why it cannot be provided, phrased for the person writing the document. */
	reason: string;
}

interface Manifest {
	archiveSha256: string;
	fetchedAt: string;
	files: PackageFile[];
	dependencies: string[];
}

class PackageUnavailableError extends Error {
	/** How long the failure is remembered before the registry is asked again. */
	readonly retryAfterMs: number;

	constructor(reason: string, retryAfterMs: number) {
		super(reason);
		this.retryAfterMs = retryAfterMs;
	}
}

const MiB = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * MiB;
const MAX_UNPACKED_BYTES = 256 * MiB;
const MAX_FILES = 5000;
/** A document and its packages may pull in at most this many packages in total. */
const MAX_PACKAGES_PER_DOCUMENT = 100;
const DOWNLOAD_TIMEOUT_MS = 60_000;

const SPEC = /^@([a-z0-9][a-z0-9-]{0,63})\/([a-z0-9][a-z0-9-]{0,63}):(\d{1,6}\.\d{1,6}\.\d{1,6})$/;

export function parsePackageSpec(
	spec: string
): { namespace: string; name: string; version: string } | null {
	const match = SPEC.exec(spec);
	return match ? { namespace: match[1]!, name: match[2]!, version: match[3]! } : null;
}

const packageDirectory = (namespace: string, name: string, version: string) =>
	path.join(packagesDir, namespace, name, version);
// Written last: a package counts as installed only once its manifest exists.
const manifestPath = (namespace: string, name: string, version: string) =>
	path.join(packagesDir, namespace, name, `${version}.json`);

const installed = new Map<string, InstalledPackage>();
const inFlight = new Map<string, Promise<InstalledPackage>>();
const recentFailures = new Map<string, { reason: string; until: number }>();

/** Returns the package, downloading it on first use. Throws `PackageUnavailableError`. */
async function ensurePackage(spec: string): Promise<InstalledPackage> {
	const known = installed.get(spec);
	if (known) return known;

	const failure = recentFailures.get(spec);
	if (failure && failure.until > Date.now()) throw new PackageUnavailableError(failure.reason, 0);

	// Compiles of several projects may ask for the same package at once.
	let pending = inFlight.get(spec);
	if (!pending) {
		pending = install(spec).finally(() => inFlight.delete(spec));
		inFlight.set(spec, pending);
	}

	try {
		const result = await pending;
		installed.set(spec, result);
		return result;
	} catch (cause) {
		if (cause instanceof PackageUnavailableError && cause.retryAfterMs > 0) {
			recentFailures.set(spec, { reason: cause.message, until: Date.now() + cause.retryAfterMs });
		}
		throw cause;
	}
}

async function install(spec: string): Promise<InstalledPackage> {
	const parsed = parsePackageSpec(spec);
	if (!parsed) {
		throw new PackageUnavailableError('this is not a valid package name and version.', 0);
	}
	const { namespace, name, version } = parsed;
	if (namespace !== 'preview') {
		throw new PackageUnavailableError(
			`only packages from Typst Universe (@preview) are available on this server, not @${namespace}.`,
			0
		);
	}

	const directory = packageDirectory(namespace, name, version);
	const describe = (manifest: Manifest): InstalledPackage => ({
		spec,
		namespace,
		name,
		version,
		directory,
		files: manifest.files,
		dependencies: manifest.dependencies
	});

	try {
		const stored = await fs.readFile(manifestPath(namespace, name, version), 'utf8');
		return describe(JSON.parse(stored) as Manifest);
	} catch {
		// not installed yet
	}

	if (!KERNIC_PACKAGE_REGISTRY) {
		throw new PackageUnavailableError('package downloads are turned off on this server.', 0);
	}

	const manifest = await download(
		`${KERNIC_PACKAGE_REGISTRY}/${namespace}/${name}-${version}.tar.gz`,
		directory
	);
	await fs.writeFile(manifestPath(namespace, name, version), JSON.stringify(manifest));
	console.log(`Installed Typst package ${spec} (sha256 ${manifest.archiveSha256})`);
	return describe(manifest);
}

/** Downloads and unpacks a package archive into `directory`. */
async function download(url: string, directory: string): Promise<Manifest> {
	let response: Response;
	try {
		// The registry serves archives directly; a redirect would lead somewhere unvetted.
		response = await fetch(url, {
			redirect: 'error',
			signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
		});
	} catch {
		throw new PackageUnavailableError(
			'the package registry could not be reached from this server. Try again in a moment.',
			30_000
		);
	}
	if (response.status === 404) {
		await response.body?.cancel();
		throw new PackageUnavailableError(
			'this package or version does not exist on Typst Universe. Check the name and version.',
			10 * 60_000
		);
	}
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new PackageUnavailableError(
			`the package registry answered with an error (${response.status}). Try again later.`,
			60_000
		);
	}

	const staging = `${directory}.${randomUUID()}.tmp`;
	await fs.mkdir(staging, { recursive: true });

	const tooLarge = () =>
		new PackageUnavailableError('this package is larger than this server accepts.', 10 * 60_000);
	const archiveHash = createHash('sha256');
	let archiveBytes = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			archiveBytes += chunk.length;
			archiveHash.update(chunk);
			callback(archiveBytes > MAX_ARCHIVE_BYTES ? tooLarge() : null, chunk);
		}
	});

	let unpackedBytes = 0;
	let entryCount = 0;
	const unpack = tar.x({
		cwd: staging,
		// Never restore owners, permissions or timestamps from the archive.
		preserveOwner: false,
		noChmod: true,
		noMtime: true,
		filter: (entryPath, entry) => {
			// Regular files and directories only: no links, devices or other special entries.
			const type = 'type' in entry ? entry.type : null;
			if (type !== 'File' && type !== 'Directory') return false;
			const normalized = entryPath.replace(/^\.\/+/, '').replace(/\/+$/, '');
			if (normalized !== '' && normalized !== '.' && !isValidProjectPath(normalized)) return false;

			entryCount++;
			unpackedBytes += entry.size ?? 0;
			if (entryCount > MAX_FILES || unpackedBytes > MAX_UNPACKED_BYTES) {
				unpack.abort(tooLarge());
				return false;
			}
			return true;
		}
	});

	try {
		await pipeline(Readable.fromWeb(response.body as never), meter, unpack);

		const files: PackageFile[] = [];
		const dependencies = new Set<string>();
		for (const entry of await listTree(staging)) {
			if (entry.type !== 'file') continue;
			const content = await fs.readFile(path.join(staging, ...entry.path.split('/')));
			files.push({
				path: entry.path,
				sha256: createHash('sha256').update(content).digest('hex'),
				size: content.byteLength
			});
			if (entry.path.toLowerCase().endsWith('.typ')) {
				for (const spec of scanTypstSource(content.toString('utf8')).packages)
					dependencies.add(spec);
			}
		}
		if (!files.some((file) => file.path === 'typst.toml')) {
			throw new PackageUnavailableError(
				'the downloaded archive is not a Typst package.',
				10 * 60_000
			);
		}

		await fs.rm(directory, { recursive: true, force: true });
		await fs.rename(staging, directory);
		return {
			archiveSha256: archiveHash.digest('hex'),
			fetchedAt: new Date().toISOString(),
			files,
			dependencies: [...dependencies]
		};
	} catch (cause) {
		await fs.rm(staging, { recursive: true, force: true });
		if (cause instanceof PackageUnavailableError) throw cause;
		console.error(`Typst package download failed: ${url}`, cause);
		throw new PackageUnavailableError(
			'the package could not be downloaded or unpacked. Try again in a moment.',
			30_000
		);
	}
}

/**
 * Provides the given packages and everything they import in turn. Packages that
 * cannot be provided are returned as failures; the compile still runs and
 * reports the import that needs them.
 */
export async function resolvePackages(
	specs: Iterable<string>
): Promise<{ packages: InstalledPackage[]; failures: PackageFailure[] }> {
	const packages = new Map<string, InstalledPackage>();
	const failures = new Map<string, string>();
	const queue = [...new Set(specs)];

	while (queue.length > 0) {
		const spec = queue.shift()!;
		if (packages.has(spec) || failures.has(spec)) continue;
		if (packages.size >= MAX_PACKAGES_PER_DOCUMENT) {
			failures.set(spec, `a document can use at most ${MAX_PACKAGES_PER_DOCUMENT} packages.`);
			continue;
		}

		try {
			const item = await ensurePackage(spec);
			packages.set(spec, item);
			queue.push(...item.dependencies);
		} catch (cause) {
			if (!(cause instanceof PackageUnavailableError)) throw cause;
			failures.set(spec, cause.message);
		}
	}

	return {
		packages: [...packages.values()],
		failures: [...failures].map(([spec, reason]) => ({ spec, reason }))
	};
}
