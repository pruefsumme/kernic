import { looksLikeText } from './content-types';
import { listTree, readTreeFile, TreeError } from './tree';

/**
 * Finds a piece of text in the files of a project. The query is taken
 * literally and compared without regard to case; it is never a pattern.
 */

export interface SearchMatch {
	path: string;
	/** 1-based line and 0-based column of the match, as the editor counts them. */
	line: number;
	column: number;
	/** The line, or the part of a long line around the match. */
	preview: string;
	/** Where the match begins in `preview`, and how long it is. */
	start: number;
	length: number;
}

export interface SearchResult {
	matches: SearchMatch[];
	/** More matches exist than are listed. */
	truncated: boolean;
}

const MAX_MATCHES = 300;
const MAX_MATCHES_PER_FILE = 60;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const PREVIEW_LENGTH = 160;
/** Text shown before a match that is far into its line; the panel that lists matches is narrow. */
const PREVIEW_LEAD = 24;

export const MAX_QUERY_LENGTH = 200;

function previewOf(line: string, column: number): { preview: string; start: number } {
	if (column <= PREVIEW_LEAD && line.length <= PREVIEW_LENGTH)
		return { preview: line, start: column };
	const from = Math.max(0, column - PREVIEW_LEAD);
	const cut = line.slice(from, from + PREVIEW_LENGTH);
	return {
		preview: (from > 0 ? '…' : '') + cut + (from + PREVIEW_LENGTH < line.length ? '…' : ''),
		start: column - from + (from > 0 ? 1 : 0)
	};
}

export async function searchTree(root: string, query: string): Promise<SearchResult> {
	// Escaped, so every character stands for itself; matching positions refer to
	// the text as written, which a lower-cased copy would not guarantee.
	const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
	const matches: SearchMatch[] = [];
	let truncated = false;

	for (const entry of await listTree(root)) {
		if (entry.type !== 'file' || entry.size > MAX_FILE_BYTES) continue;

		let content: Buffer;
		try {
			content = await readTreeFile(root, entry.path);
		} catch (error) {
			// Deleted since the listing.
			if (error instanceof TreeError) continue;
			throw error;
		}
		if (!looksLikeText(content)) continue;

		// One match past a limit is looked for, to be able to say that there are more.
		let inFile = 0;
		let full = false;
		const lines = content.toString('utf8').split('\n');
		for (let index = 0; index < lines.length && !full; index++) {
			const line = lines[index]!.replace(/\r$/, '');
			literal.lastIndex = 0;
			for (let found = literal.exec(line); found; found = literal.exec(line)) {
				if (matches.length >= MAX_MATCHES || inFile >= MAX_MATCHES_PER_FILE) {
					truncated = true;
					full = true;
					break;
				}
				matches.push({
					path: entry.path,
					line: index + 1,
					column: found.index,
					...previewOf(line, found.index),
					length: found[0].length
				});
				inFile++;
			}
		}
		if (matches.length >= MAX_MATCHES && truncated) break;
	}

	return { matches, truncated };
}
