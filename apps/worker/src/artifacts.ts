import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CompileLimits } from './config.ts';

export type OutputFormat = 'svg' | 'pdf';

export interface Artifact {
	name: string;
	size: number;
	/** SHA-256 of the file content. */
	sha256: string;
	/**
	 * Base64-encoded file content, or null for a page the caller said it already
	 * has (see `knownPages`), which then only needs its hash.
	 */
	data: string | null;
	/** Page size in points, for SVG pages. */
	width?: number;
	height?: number;
}

/** What is known about an output file, to avoid reading an unchanged one again. */
interface KnownOutput {
	modified: bigint;
	size: number;
	sha256: string;
	width?: number;
	height?: number;
}

/** Remembers output files of a long-lived compiler between two compiles, by name. */
export type OutputCache = Map<string, KnownOutput>;

const SVG_SIZE = /<svg[^>]*\swidth="([\d.]+)pt"\s+height="([\d.]+)pt"/;
const OUTPUT_NAME = { svg: /^page-\d+\.svg$/, pdf: /^output\.pdf$/ };

export function isOutputName(name: string, format: OutputFormat): boolean {
	return OUTPUT_NAME[format].test(name);
}

/**
 * Reads the named output files. Returns an error message for the document's
 * author when the output breaks one of the server's limits.
 */
export async function collectArtifacts(
	outputDir: string,
	names: string[],
	format: OutputFormat,
	knownPages: Set<string>,
	limits: CompileLimits,
	cache?: OutputCache
): Promise<Artifact[] | string> {
	if (names.length === 0) return 'The compiler finished without producing any output.';
	if (names.length > limits.maxPages) {
		return `The document has more than ${limits.maxPages} pages, which is the limit for this server.`;
	}

	const sorted = [...names].sort();
	const stats = await Promise.all(
		sorted.map((name) => stat(path.join(outputDir, name), { bigint: true }))
	);
	const totalBytes = stats.reduce((sum, info) => sum + Number(info.size), 0);
	if (totalBytes > limits.outputBytes) {
		const megabytes = Math.round(limits.outputBytes / (1024 * 1024));
		return `The rendered output is larger than ${megabytes} MB, which is the limit for this server.`;
	}

	const artifacts: Artifact[] = [];
	for (const [index, name] of sorted.entries()) {
		const info = stats[index]!;
		const size = Number(info.size);
		let known = cache?.get(name);
		let content: Buffer | null = null;

		if (!known || known.modified !== info.mtimeNs || known.size !== size) {
			content = await readFile(path.join(outputDir, name));
			known = {
				modified: info.mtimeNs,
				size,
				sha256: createHash('sha256').update(content).digest('hex')
			};
			if (format === 'svg') {
				const dimensions = SVG_SIZE.exec(content.subarray(0, 512).toString('latin1'));
				// A4 in points, should a future Typst change the header this is read from.
				known.width = Number(dimensions?.[1] ?? 595.28);
				known.height = Number(dimensions?.[2] ?? 841.89);
			}
			cache?.set(name, known);
		}

		const artifact: Artifact = { name, size, sha256: known.sha256, data: null };
		if (format === 'svg') {
			artifact.width = known.width;
			artifact.height = known.height;
		}
		if (format !== 'svg' || !knownPages.has(known.sha256)) {
			content ??= await readFile(path.join(outputDir, name));
			artifact.data = content.toString('base64');
		}
		artifacts.push(artifact);
	}

	if (cache) {
		const current = new Set(sorted);
		for (const name of cache.keys()) if (!current.has(name)) cache.delete(name);
	}
	return artifacts;
}
