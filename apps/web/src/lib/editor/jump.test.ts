import { describe, expect, it } from 'vitest';
import { placesNearby } from './jump.ts';

const lines = [
	'= Findings',
	'',
	'== Section 1 <first>',
	'',
	'#lorem(420)',
	'Seen in @first and #strong[here].'
];
const nearby = (line: number, character: number) =>
	placesNearby((index) => lines[index] ?? '', { line, character });

describe('placesNearby', () => {
	it('offers the words of the line, nearest to the cursor first', () => {
		// After the label of the heading: the "1", then "Section"; never the label's name.
		expect(nearby(2, 20).slice(0, 2)).toEqual([
			{ line: 2, character: 12 },
			{ line: 2, character: 4 }
		]);
		// At the start of the line it is the other way round.
		expect(nearby(2, 0).slice(0, 2)).toEqual([
			{ line: 2, character: 4 },
			{ line: 2, character: 12 }
		]);
	});

	it('goes on to the lines before when the line has nothing to print', () => {
		// "lorem" is a function's name and 420 its argument, tried first as it is on the line.
		expect(nearby(4, 11)).toEqual([
			{ line: 4, character: 8 },
			{ line: 2, character: 4 },
			{ line: 2, character: 12 },
			{ line: 0, character: 3 }
		]);
	});

	it('leaves out names that stand for something else', () => {
		const characters = nearby(5, 0)
			.filter((place) => place.line === 5)
			.map((place) => place.character);
		// "Seen", "in", "and", "here" — not "first" (a reference) nor "strong" (a function).
		expect(characters).toEqual([1, 6, 16, 28]);
	});

	it('does not repeat the place of the cursor and stays within what the server takes', () => {
		expect(nearby(2, 4)).not.toContainEqual({ line: 2, character: 4 });
		const long = Array.from({ length: 40 }, () => 'one two three four five six seven eight');
		const places = placesNearby((index) => long[index] ?? '', { line: 39, character: 0 });
		expect(places).toHaveLength(16);
		expect(places.filter((place) => place.line === 39)).toHaveLength(6);
	});
});
