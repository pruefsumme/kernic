import { describe, expect, it } from 'vitest';
import { rank, segments } from './fuzzy.ts';

const files = [
	'main.typ',
	'chapters/introduction.typ',
	'chapters/methods.typ',
	'images/main-figure.png',
	'template.typ',
	'references.bib'
];
const found = (query: string) => rank(query, files, (file) => file).map((match) => match.item);

describe('rank', () => {
	it('returns everything in order for an empty query', () => {
		expect(found('')).toEqual(files);
		expect(found('   ')).toEqual(files);
	});

	it('prefers a match at the start of the file name', () => {
		expect(found('main')[0]).toBe('main.typ');
		expect(found('main')).toContain('images/main-figure.png');
		expect(found('intro')[0]).toBe('chapters/introduction.typ');
	});

	it('finds letters in order when there is no direct match', () => {
		expect(found('mtyp')[0]).toBe('main.typ');
		expect(found('chmeth')).toEqual(['chapters/methods.typ']);
	});

	it('ignores case and spaces, and leaves out what does not match', () => {
		expect(found('REF')).toEqual(['references.bib']);
		expect(found('main typ')[0]).toBe('main.typ');
		expect(found('xyz')).toEqual([]);
	});

	it('ranks direct matches above scattered ones', () => {
		const ranked = found('typ');
		expect(ranked.slice(0, 4).every((file) => file.endsWith('.typ'))).toBe(true);
	});

	it('reports which characters matched', () => {
		const [match] = rank('mtyp', ['main.typ'], (file) => file);
		expect(match!.positions).toEqual([0, 5, 6, 7]);
	});
});

describe('segments', () => {
	it('splits a text into matched and unmatched runs', () => {
		expect(segments('main.typ', [0, 5, 6, 7])).toEqual([
			{ text: 'm', matched: true },
			{ text: 'ain.', matched: false },
			{ text: 'typ', matched: true }
		]);
		expect(segments('plain', [])).toEqual([{ text: 'plain', matched: false }]);
	});
});
