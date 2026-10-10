import { describe, expect, it } from 'vitest';
import { normalizePages, parsePdfOptions, PdfOptionsError } from './pdf-options.ts';

describe('normalizePages', () => {
	it('accepts pages and ranges the way people type them', () => {
		expect(normalizePages('1-3, 5, 8-')).toBe('1-3,5,8-');
		expect(normalizePages(' 2 ')).toBe('2');
		expect(normalizePages('3–7')).toBe('3-7');
		expect(normalizePages('')).toBeNull();
		expect(normalizePages('   ')).toBeNull();
	});

	it('rejects what the compiler would not understand, with a reason', () => {
		for (const input of ['0', '-2', '3-1', 'a', '1,,2', '1;2', '--root=/', '1 --help']) {
			expect(() => normalizePages(input), input).toThrow(PdfOptionsError);
		}
		expect(() => normalizePages('3-1')).toThrow(/ends before it starts/);
	});
});

describe('parsePdfOptions', () => {
	it('fills in defaults', () => {
		expect(parsePdfOptions({})).toEqual({ standard: null, pages: null, tagged: true });
		expect(parsePdfOptions({ standard: 'a-2b', pages: '1 - 2', tagged: false })).toEqual({
			standard: 'a-2b',
			pages: '1-2',
			tagged: false
		});
	});

	it('rejects unknown standards and wrong types', () => {
		for (const value of [
			null,
			'a-2b',
			{ standard: 'a-2b --root /' },
			{ standard: 3 },
			{ pages: 5 },
			{ tagged: 'yes' }
		]) {
			expect(() => parsePdfOptions(value), JSON.stringify(value)).toThrow(PdfOptionsError);
		}
	});

	it('does not combine an accessibility standard with a page selection or missing tags', () => {
		expect(() => parsePdfOptions({ standard: 'ua-1', pages: '1' })).toThrow(
			/needs accessibility tags/
		);
		expect(() => parsePdfOptions({ standard: 'a-2a', tagged: false })).toThrow(PdfOptionsError);
		expect(parsePdfOptions({ standard: 'ua-1' }).tagged).toBe(true);
	});
});
