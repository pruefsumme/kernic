import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDiagnostics } from '../src/diagnostics.ts';
import { isSafeRelativePath } from '../src/paths.ts';

test('parses located errors and warnings', () => {
	const diagnostics = parseDiagnostics(
		[
			'sub/part.typ:2:17: error: expected expression',
			'main.typ:3:16: warning: unknown font family: nonexistent font',
			''
		].join('\n')
	);

	assert.deepEqual(diagnostics, [
		{
			severity: 'error',
			message: 'expected expression',
			path: 'sub/part.typ',
			line: 2,
			column: 17
		},
		{
			severity: 'warning',
			message: 'unknown font family: nonexistent font',
			path: 'main.typ',
			line: 3,
			column: 16
		}
	]);
});

test('keeps the version in package paths', () => {
	const [diagnostic] = parseDiagnostics('@preview/cetz:0.3.1/src/lib.typ:10:2: error: boom');
	assert.equal(diagnostic?.path, '@preview/cetz:0.3.1/src/lib.typ');
	assert.equal(diagnostic?.line, 10);
});

test('parses diagnostics without a source location', () => {
	assert.deepEqual(parseDiagnostics('error: input file not found'), [
		{ severity: 'error', message: 'input file not found', path: null, line: null, column: null }
	]);
});

test('ignores unrelated output', () => {
	assert.deepEqual(parseDiagnostics('downloading @preview/example:0.1.0\n'), []);
});

test('accepts plain relative paths and rejects everything else', () => {
	for (const good of ['main.typ', 'chapters/01 intro.typ', 'assets/Übersicht.png', '.hidden']) {
		assert.equal(isSafeRelativePath(good), true, good);
	}
	for (const bad of ['', '/abs', '..', 'a/..', './a', 'a//b', 'a/', 'a\\b', 'a\u0000b', 42, null]) {
		assert.equal(isSafeRelativePath(bad), false, String(bad));
	}
});
