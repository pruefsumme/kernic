import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore } from './blobs.ts';
import { MissingBlobsError, type PackageFiles, type SnapshotFile } from './compile.ts';

/**
 * Keeps a directory equal to a snapshot between two requests, touching only
 * the files that differ. Used by the processes that stay running: they hold a
 * copy of one project each.
 */

/** The files of all packages as paths below a package directory: `namespace/name/version/…`. */
export function packagePaths(packages: PackageFiles[]): SnapshotFile[] {
	return packages.flatMap((item) =>
		item.files.map((file) => ({
			path: path.join(item.namespace, item.name, item.version, file.path),
			sha256: file.sha256
		}))
	);
}

/**
 * Makes the files below `root` match `wanted` and returns the new state.
 *
 * With `atomic`, each file is written beside its place and moved into it, for
 * a reader that is running meanwhile and must never see half a file.
 */
export async function syncTree(
	blobs: BlobStore,
	root: string,
	current: Map<string, string>,
	wanted: SnapshotFile[],
	options: { atomic?: boolean } = {}
): Promise<Map<string, string>> {
	const next = new Map(wanted.map((file) => [file.path, file.sha256]));

	for (const stale of current.keys()) {
		if (next.has(stale)) continue;
		await rm(path.join(root, stale), { force: true });
		// Remove folders this emptied, so that a file can take a folder's name.
		let folder = path.dirname(stale);
		while (folder !== '.') {
			const removed = await rmdir(path.join(root, folder)).then(
				() => true,
				() => false
			);
			if (!removed) break;
			folder = path.dirname(folder);
		}
	}

	const missing: string[] = [];
	for (const file of wanted) {
		if (current.get(file.path) === file.sha256) continue;
		const destination = path.join(root, file.path);
		await mkdir(path.dirname(destination), { recursive: true });
		const target = options.atomic ? `${destination}.${randomUUID()}.part` : destination;
		if (!(await blobs.copyTo(file.sha256, target))) {
			missing.push(file.sha256);
			continue;
		}
		if (options.atomic) await rename(target, destination);
	}
	if (missing.length > 0) throw new MissingBlobsError(missing);
	return next;
}
