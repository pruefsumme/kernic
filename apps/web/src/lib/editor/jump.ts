/** A place in a file: a line and a character, both counted from 0. */
export interface Place {
	line: number;
	character: number;
}

/** As many places as the server takes at once. */
const MAX_PLACES = 16;
const ON_THE_LINE = 6;
const PER_EARLIER_LINE = 2;
const EARLIER_LINES = 12;

/** A word of the text; not the name after `#`, `@`, `\` or inside `<…>`, which prints nothing itself. */
const WORD = /(?<![#@\\<\p{L}\p{N}_.])[\p{L}\p{N}]+/gu;

/**
 * Places to show on the page when the cursor's own place prints nothing: the
 * start of a line, a label, a function call. The words of its line, nearest
 * first, then the first words of the lines before it. Which of them really are
 * on a page only the compiler knows; the first that is answers.
 */
export function placesNearby(lineAt: (line: number) => string, cursor: Place): Place[] {
	const inWord = (line: number, match: RegExpMatchArray): Place => ({
		line,
		// Within the word, or right after it if it is a single character.
		character: match.index! + 1
	});

	const places = [...lineAt(cursor.line).matchAll(WORD)]
		.map((match) => inWord(cursor.line, match))
		.filter((place) => place.character !== cursor.character)
		.sort(
			(a, b) => Math.abs(a.character - cursor.character) - Math.abs(b.character - cursor.character)
		)
		.slice(0, ON_THE_LINE);

	const first = Math.max(0, cursor.line - EARLIER_LINES);
	for (let line = cursor.line - 1; line >= first && places.length < MAX_PLACES; line--) {
		const words = [...lineAt(line).matchAll(WORD)].slice(0, PER_EARLIER_LINE);
		places.push(...words.map((match) => inWord(line, match)));
	}
	return places.slice(0, MAX_PLACES);
}
