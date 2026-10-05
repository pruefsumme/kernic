import path from 'node:path';
import { Readable } from 'node:stream';
import yazl from 'yazl';
import { listTree } from './tree';

/**
 * Streams the project tree as a ZIP archive with paths exactly as in the
 * project, so the archive can be unpacked and compiled anywhere with
 * `typst compile <main file>`.
 */
export async function zipTree(root: string): Promise<ReadableStream<Uint8Array>> {
	const zip = new yazl.ZipFile();
	for (const entry of await listTree(root)) {
		if (entry.type === 'directory') zip.addEmptyDirectory(entry.path);
		else zip.addFile(path.join(root, ...entry.path.split('/')), entry.path);
	}
	zip.end();
	return Readable.toWeb(Readable.from(zip.outputStream)) as ReadableStream<Uint8Array>;
}
