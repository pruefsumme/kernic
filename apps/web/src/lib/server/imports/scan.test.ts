import { describe, expect, it } from 'vitest';
import {
	analyzeSources,
	guessEntryFile,
	resolveReference,
	scanTypstSource,
	stripComments
} from './scan';

describe('stripComments', () => {
	it('removes line and nested block comments but keeps strings', () => {
		const source = 'a // gone\n#link("https://typst.app") /* x /* y */ z */ b';
		expect(stripComments(source)).toBe('a \n#link("https://typst.app")  b');
	});

	it('handles escaped quotes inside strings', () => {
		expect(stripComments('"a \\" // not a comment" // comment')).toBe('"a \\" // not a comment" ');
	});
});

describe('scanTypstSource', () => {
	it('finds packages, imports, includes and file functions', () => {
		const scan = scanTypstSource(`
			#import "@preview/cetz:0.3.1": canvas
			#import "@local/house-style:1.0.0"
			#import "template.typ": conf
			#include "chapters/intro.typ"
			#image("figures/plot.svg", width: 80%)
			#bibliography(("refs.bib", "more.yml"))
			#let data = csv( "/data/table.csv")
		`);
		expect(scan.packages).toEqual(['@preview/cetz:0.3.1', '@local/house-style:1.0.0']);
		expect(scan.references).toEqual([
			'template.typ',
			'chapters/intro.typ',
			'figures/plot.svg',
			'refs.bib',
			'/data/table.csv'
		]);
	});

	it('ignores references inside comments', () => {
		const scan = scanTypstSource('// #import "@preview/old:1.0.0"\n/* #image("gone.png") */\nText');
		expect(scan).toEqual({ packages: [], references: [] });
	});
});

describe('resolveReference', () => {
	it('resolves relative to the file, or to the project root for a leading slash', () => {
		expect(resolveReference('chapters/intro.typ', 'fig.png')).toBe('chapters/fig.png');
		expect(resolveReference('chapters/intro.typ', '../assets/fig.png')).toBe('assets/fig.png');
		expect(resolveReference('chapters/intro.typ', '/assets/fig.png')).toBe('assets/fig.png');
		expect(resolveReference('main.typ', './a/./b.typ')).toBe('a/b.typ');
	});

	it('returns null for paths that leave the project', () => {
		expect(resolveReference('main.typ', '../outside.typ')).toBeNull();
		expect(resolveReference('a/b.typ', '../../outside.typ')).toBeNull();
	});
});

describe('analyzeSources', () => {
	it('reports packages with their users and references that do not exist', () => {
		const sources = new Map([
			[
				'main.typ',
				'#import "@preview/cetz:0.3.1"\n#include "chapters/one.typ"\n#image("logo.png")'
			],
			[
				'chapters/one.typ',
				'#import "@preview/cetz:0.3.1"\n#image("../figures/a.png")\n#image("b.png")'
			]
		]);
		const paths = new Set(['main.typ', 'chapters/one.typ', 'figures/a.png']);

		const result = analyzeSources(sources, paths);
		expect(result.packages).toEqual([
			{ spec: '@preview/cetz:0.3.1', usedIn: ['main.typ', 'chapters/one.typ'] }
		]);
		expect(result.missing).toEqual([
			{ target: 'logo.png', referencedFrom: 'main.typ' },
			{ target: 'b.png', referencedFrom: 'chapters/one.typ' }
		]);
		expect([...result.referenced]).toEqual(['chapters/one.typ', 'figures/a.png']);
	});
});

describe('guessEntryFile', () => {
	it('prefers main.typ at the top level', () => {
		expect(guessEntryFile(['thesis.typ', 'main.typ', 'chapters/a.typ'], new Set())).toBe(
			'main.typ'
		);
	});

	it('otherwise picks a top-level file that nothing else includes', () => {
		const referenced = new Set(['template.typ', 'chapters/a.typ']);
		expect(guessEntryFile(['template.typ', 'thesis.typ', 'chapters/a.typ'], referenced)).toBe(
			'thesis.typ'
		);
	});

	it('falls back to a nested main.typ, then to any file', () => {
		expect(guessEntryFile(['src/main.typ', 'src/lib.typ'], new Set())).toBe('src/main.typ');
		expect(guessEntryFile(['docs/a.typ'], new Set())).toBe('docs/a.typ');
		expect(guessEntryFile([], new Set())).toBeNull();
	});
});
