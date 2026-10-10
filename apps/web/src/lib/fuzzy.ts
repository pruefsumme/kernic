/**
 * Matching for the quick-open palette: what someone types is found as a
 * substring where possible, and otherwise as letters in order ("mtyp" finds
 * "main.typ"). Better matches rank first.
 */

export interface Match<T> {
	item: T;
	/** Positions of the matched characters in the item's text, for highlighting. */
	positions: number[];
}

const BOUNDARY = /[\s/._-]/;

/** Scores one text against a lower-case query, or null if it does not match. */
function score(query: string, text: string): { score: number; positions: number[] } | null {
	const haystack = text.toLowerCase();

	const at = haystack.indexOf(query);
	if (at !== -1) {
		// A match that begins a word or a path segment is what people usually mean.
		const startsWord = at === 0 || BOUNDARY.test(haystack[at - 1]!);
		// Prefer the file name over its folders.
		const inName = at > haystack.lastIndexOf('/');
		return {
			score: 1000 + (startsWord ? 200 : 0) + (inName ? 100 : 0) - at - haystack.length / 100,
			positions: Array.from({ length: query.length }, (_, index) => at + index)
		};
	}

	const positions: number[] = [];
	let from = 0;
	for (const character of query) {
		const found = haystack.indexOf(character, from);
		if (found === -1) return null;
		positions.push(found);
		from = found + 1;
	}
	const spread = positions.at(-1)! - positions[0]! - (positions.length - 1);
	return { score: 500 - spread * 5 - positions[0]! - haystack.length / 100, positions };
}

/**
 * Items matching the query, best first. An empty query returns all items in
 * their given order. Spaces in the query are ignored.
 */
export function rank<T>(query: string, items: T[], textOf: (item: T) => string): Match<T>[] {
	const needle = query.toLowerCase().replace(/\s+/g, '');
	if (needle === '') return items.map((item) => ({ item, positions: [] }));

	const matches: (Match<T> & { score: number; order: number })[] = [];
	items.forEach((item, order) => {
		const result = score(needle, textOf(item));
		if (result) matches.push({ item, order, ...result });
	});
	return matches
		.sort((a, b) => b.score - a.score || a.order - b.order)
		.map(({ item, positions }) => ({ item, positions }));
}

/** Splits a text into runs of matched and unmatched characters. */
export function segments(text: string, positions: number[]): { text: string; matched: boolean }[] {
	const marked = new Set(positions);
	const runs: { text: string; matched: boolean }[] = [];
	for (let index = 0; index < text.length; index++) {
		const matched = marked.has(index);
		const last = runs.at(-1);
		if (last && last.matched === matched) last.text += text[index];
		else runs.push({ text: text[index]!, matched });
	}
	return runs;
}
