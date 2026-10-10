import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/** Editing commands behind the formatting toolbar. All of them edit the Typst source. */

/**
 * Wraps each selection in a marker (`*bold*`, `_emphasis_`, `$math$`, …), or
 * removes the markers if the selection is already wrapped.
 */
export function toggleWrap(view: EditorView, open: string, close = open): void {
	const { state } = view;
	const transaction = state.changeByRange((range) => {
		const before = state.sliceDoc(range.from - open.length, range.from);
		const after = state.sliceDoc(range.to, range.to + close.length);

		if (before === open && after === close) {
			return {
				changes: [
					{ from: range.from - open.length, to: range.from },
					{ from: range.to, to: range.to + close.length }
				],
				range: EditorSelection.range(range.from - open.length, range.to - open.length)
			};
		}
		return {
			changes: [
				{ from: range.from, insert: open },
				{ from: range.to, insert: close }
			],
			range: EditorSelection.range(range.from + open.length, range.to + open.length)
		};
	});
	view.dispatch(state.update(transaction, { scrollIntoView: true, userEvent: 'input' }));
	view.focus();
}

/** Typst block markers this module knows how to replace. */
const BLOCK_PREFIX = /^(\s*)(=+ |- |\+ )?/;

/**
 * Sets the block marker of every selected line: `= ` to `=== ` for headings,
 * `- ` and `+ ` for lists, or the empty string for body text. Applying the
 * marker a line already has removes it.
 */
export function setLinePrefix(view: EditorView, prefix: string): void {
	const { state } = view;
	const changes = [];
	const seen = new Set<number>();

	for (const range of state.selection.ranges) {
		for (let position = range.from; ;) {
			const line = state.doc.lineAt(position);
			if (!seen.has(line.number)) {
				seen.add(line.number);
				const [, indent = '', current = ''] = BLOCK_PREFIX.exec(line.text) ?? [];
				const from = line.from + indent.length;
				changes.push({
					from,
					to: from + current.length,
					insert: current === prefix ? '' : prefix
				});
			}
			if (line.to >= range.to) break;
			position = line.to + 1;
		}
	}

	view.dispatch({ changes, scrollIntoView: true, userEvent: 'input' });
	view.focus();
}

/** Inserts a link around the selection and selects the URL placeholder. */
export function insertLink(view: EditorView): void {
	const { state } = view;
	const range = state.selection.main;
	const label = state.sliceDoc(range.from, range.to) || 'link text';
	const url = 'https://';
	const insert = `#link("${url}")[${label}]`;
	const urlStart = range.from + '#link("'.length;

	view.dispatch({
		changes: { from: range.from, to: range.to, insert },
		selection: EditorSelection.range(urlStart, urlStart + url.length),
		scrollIntoView: true,
		userEvent: 'input'
	});
	view.focus();
}

/** Inserts `#image("…")` for each path at the cursor, one per line. */
export function insertImages(view: EditorView, paths: string[]): void {
	const quoted = (path: string) => path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
	view.dispatch(
		view.state.replaceSelection(paths.map((path) => `#image("${quoted(path)}")`).join('\n')),
		{ scrollIntoView: true, userEvent: 'input.paste' }
	);
	view.focus();
}
