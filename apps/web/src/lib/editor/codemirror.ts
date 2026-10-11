import {
	autocompletion,
	closeBrackets,
	closeBracketsKeymap,
	completionKeymap,
	type CompletionSource
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
	HighlightStyle,
	bracketMatching,
	foldGutter,
	foldKeymap,
	indentOnInput,
	indentUnit,
	syntaxHighlighting,
	syntaxTree
} from '@codemirror/language';
import {
	linter,
	lintGutter,
	lintKeymap,
	type Diagnostic as EditorDiagnostic
} from '@codemirror/lint';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
	Compartment,
	EditorState,
	StateEffect,
	StateField,
	type Extension
} from '@codemirror/state';
import {
	EditorView,
	drawSelection,
	highlightActiveLine,
	highlightActiveLineGutter,
	highlightSpecialChars,
	keymap,
	lineNumbers
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import {
	typstLezerFoldService,
	typstLezerIndentService,
	typstLezerListKeymap,
	typstTags,
	typst_lezer
} from 'codemirror-lang-typst/lezer';
import type { Diagnostic } from './api.ts';
import { toggleWrap } from './formatting.ts';

/**
 * CodeMirror configuration for Typst source. Everything editor-specific lives
 * here, so components only deal with an `EditorView` and plain data. Language
 * features come from the syntax tree today; a language server can later feed
 * the same diagnostics field and completion sources.
 */

const highlightStyle = HighlightStyle.define([
	{ tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
	{ tag: tags.heading, color: 'var(--ink)', fontWeight: '600' },
	{ tag: tags.strong, fontWeight: '600' },
	{ tag: tags.emphasis, fontStyle: 'italic' },
	{ tag: tags.link, color: 'var(--syn-keyword)', textDecoration: 'underline' },
	{ tag: tags.monospace, color: 'var(--syn-markup)' },
	{ tag: [tags.keyword, tags.bool], color: 'var(--syn-keyword)' },
	{ tag: tags.function(tags.variableName), color: 'var(--syn-function)' },
	{ tag: typstTags.interpolated, color: 'var(--syn-function)' },
	{ tag: tags.propertyName, color: 'var(--syn-function)' },
	{ tag: tags.string, color: 'var(--syn-string)' },
	{ tag: tags.number, color: 'var(--syn-number)' },
	{ tag: typstTags.mathDelimiter, color: 'var(--syn-number)' },
	{ tag: tags.escape, color: 'var(--syn-reference)' },
	{ tag: typstTags.listMarker, color: 'var(--syn-keyword)', fontWeight: '500' },
	{ tag: [tags.punctuation, tags.operator, tags.paren], color: 'var(--syn-markup)' },
	{ tag: tags.invalid, color: 'var(--error)' }
]);

const theme = EditorView.theme({
	'&': {
		height: '100%',
		backgroundColor: 'var(--surface)',
		color: 'var(--ink)',
		fontSize: '0.875rem'
	},
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': {
		fontFamily: 'var(--font-mono)',
		lineHeight: '1.65',
		overflow: 'auto'
	},
	'.cm-content': { padding: '0.75rem 0 40vh', caretColor: 'var(--ink)' },
	'.cm-line': { padding: '0 1rem 0 0.5rem' },
	'.cm-gutters': {
		backgroundColor: 'var(--surface)',
		color: 'var(--ink-3)',
		border: 'none'
	},
	// Line numbers step back behind the text; the current line's number stays dark.
	'.cm-lineNumbers .cm-gutterElement': {
		padding: '0 0.5rem 0 0.75rem',
		minWidth: '2.5rem',
		color: 'oklch(62% 0.012 250)'
	},
	'.cm-activeLine': { backgroundColor: 'oklch(97% 0.006 255)' },
	'.cm-lineNumbers .cm-activeLineGutter': { color: 'var(--ink)' },
	'.cm-activeLineGutter': { backgroundColor: 'oklch(97% 0.006 255)' },
	'&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
		{ backgroundColor: 'var(--accent-soft)' },
	'.cm-cursor': { borderLeftColor: 'var(--ink)', borderLeftWidth: '1.5px' },
	'.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
	'.cm-selectionMatch': { backgroundColor: 'oklch(93% 0.03 95)' },
	'.cm-foldGutter .cm-gutterElement': { color: 'var(--ink-3)', cursor: 'pointer' },
	'.cm-tooltip': {
		border: '1px solid var(--rule)',
		borderRadius: 'var(--radius-float)',
		backgroundColor: 'var(--surface)',
		color: 'var(--ink)',
		boxShadow: 'var(--shadow-float)',
		fontFamily: 'var(--font-ui)',
		fontSize: 'var(--t-ui)'
	},
	'.cm-tooltip-autocomplete ul li[aria-selected]': {
		backgroundColor: 'var(--accent)',
		color: 'var(--accent-ink)'
	},
	'.cm-tooltip-autocomplete ul': { fontFamily: 'var(--font-mono)' },
	// Documentation from the language server: prose in the interface font, code as code.
	'.cm-lsp-documentation': {
		maxWidth: 'min(34rem, 80vw)',
		maxHeight: '18rem',
		padding: '0.375rem 0.625rem',
		overflow: 'auto',
		lineHeight: '1.45'
	},
	'.cm-lsp-documentation code, .cm-lsp-documentation pre': {
		fontFamily: 'var(--font-mono)',
		fontSize: '0.92em'
	},
	'.cm-lsp-documentation pre': { margin: '0.25rem 0', whiteSpace: 'pre-wrap' },
	'.cm-lsp-documentation h1, .cm-lsp-documentation h2, .cm-lsp-documentation h3': {
		margin: '0.5rem 0 0.125rem',
		fontSize: 'var(--t-meta)',
		fontWeight: '600',
		color: 'var(--ink-2)'
	},
	'.cm-lsp-documentation hr': {
		border: '0',
		borderTop: '1px solid var(--rule)',
		margin: '0.375rem 0'
	},
	'.cm-lsp-signature-tooltip .cm-lsp-signature, .cm-lsp-signature-tooltip .cm-lsp-signature-num': {
		fontFamily: 'var(--font-mono)'
	},
	'.cm-diagnostic': { padding: '0.375rem 0.625rem', borderLeftWidth: '3px' },
	'.cm-diagnostic-error': { borderLeftColor: 'var(--error)' },
	'.cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
	'.cm-panels': {
		backgroundColor: 'var(--ground)',
		color: 'var(--ink)',
		borderColor: 'var(--rule)',
		fontFamily: 'var(--font-ui)'
	},
	'.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--rule)' },
	'.cm-search': { padding: '0.5rem 0.75rem', fontSize: 'var(--t-ui)' },
	'.cm-textfield': {
		border: '1px solid var(--control-border)',
		borderRadius: 'var(--radius)',
		backgroundColor: 'var(--surface)',
		fontSize: 'var(--t-ui)'
	},
	'.cm-button': {
		border: '1px solid var(--control-border)',
		borderRadius: 'var(--radius)',
		backgroundImage: 'none',
		backgroundColor: 'var(--surface)',
		fontSize: 'var(--t-ui)'
	}
});

/** Replaces the compiler diagnostics shown in the editor. */
export const setCompileDiagnostics = StateEffect.define<readonly EditorDiagnostic[]>();

// Diagnostics arrive after a save and a compile. Until the next result they are
// kept attached to the text they were reported on by mapping them through edits.
const compileDiagnostics = StateField.define<readonly EditorDiagnostic[]>({
	create: () => [],
	update(diagnostics, transaction) {
		for (const effect of transaction.effects) {
			if (effect.is(setCompileDiagnostics)) return effect.value;
		}
		if (!transaction.docChanged) return diagnostics;
		return diagnostics.map((diagnostic) => {
			const from = transaction.changes.mapPos(diagnostic.from, 1);
			return {
				...diagnostic,
				from,
				to: Math.max(from, transaction.changes.mapPos(diagnostic.to, -1))
			};
		});
	}
});

/** Converts compiler diagnostics for the open file to editor ranges. */
export function toEditorDiagnostics(
	state: EditorState,
	diagnostics: Diagnostic[]
): EditorDiagnostic[] {
	const result: EditorDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		if (diagnostic.line === null || diagnostic.line < 1 || diagnostic.line > state.doc.lines) {
			continue;
		}
		const line = state.doc.line(diagnostic.line);
		const from = Math.min(line.from + (diagnostic.column ?? 0), line.to);

		// Typst reports where a problem starts. Underline the syntax node there,
		// or a single character when the node spans more than its line.
		const node = syntaxTree(state).resolveInner(from, 1);
		let to = node.from === from && node.to <= line.to ? node.to : Math.min(from + 1, line.to);
		let start = from;
		if (to === start) {
			if (start > line.from) start--;
			else to = Math.min(start + 1, state.doc.length);
		}

		result.push({ from: start, to, severity: diagnostic.severity, message: diagnostic.message });
	}
	return result;
}

/**
 * Completes font families inside `font: "…"` (also within a list of fallbacks),
 * from the fonts installed on the server.
 */
function fontCompletions(families: () => string[]): CompletionSource {
	return (context) => {
		const line = context.state.doc.lineAt(context.pos);
		const before = line.text.slice(0, context.pos - line.from);
		const typed = /\bfont:\s*\(?\s*(?:"[^"]*"\s*,\s*)*"([^"]*)$/.exec(before)?.[1];
		if (typed === undefined) return null;

		const options = families().map((label) => ({ label, type: 'text' }));
		if (options.length === 0) return null;
		return { from: context.pos - typed.length, options, validFor: /^[^"]*$/ };
	};
}

/** Holds what connects an editor to the language server; empty while there is none. */
const assistance = new Compartment();

/** Connects an editor to the language server, or disconnects it with `null`. */
export function setAssistance(view: EditorView, extension: Extension | null): void {
	view.dispatch({ effects: assistance.reconfigure(extension ?? []) });
}

export function editorExtensions(options: {
	/** Connection to the language server for this file, if there is one already. */
	assistance: Extension | null;
	/** Font families to offer; read whenever completion starts, so a late list is picked up. */
	fonts: () => string[];
	readOnly: boolean;
	onChange: () => void;
	onCursor: (line: number, column: number) => void;
	onSave: () => void;
}): Extension {
	// One object for the life of the editor: completion restarts whenever it is
	// handed a source it has not seen before.
	const completionData = [{ autocomplete: fontCompletions(options.fonts) }];

	return [
		lineNumbers(),
		highlightActiveLineGutter(),
		highlightSpecialChars(),
		history(),
		foldGutter(),
		drawSelection(),
		EditorState.allowMultipleSelections.of(true),
		indentOnInput(),
		indentUnit.of('  '),
		bracketMatching(),
		closeBrackets(),
		autocompletion(),
		highlightActiveLine(),
		highlightSelectionMatches(),
		EditorView.lineWrapping,

		EditorState.languageData.of(() => completionData),
		assistance.of(options.assistance ?? []),
		typst_lezer().language,
		typstLezerIndentService,
		typstLezerListKeymap,
		typstLezerFoldService,
		syntaxHighlighting(highlightStyle),

		compileDiagnostics,
		linter((view) => view.state.field(compileDiagnostics), {
			delay: 50,
			needsRefresh: (update) =>
				update.transactions.some((transaction) =>
					transaction.effects.some((effect) => effect.is(setCompileDiagnostics))
				)
		}),
		lintGutter(),

		keymap.of([
			{
				key: 'Mod-s',
				preventDefault: true,
				run: () => {
					options.onSave();
					return true;
				}
			},
			{ key: 'Mod-b', run: (view) => (toggleWrap(view, '*'), true) },
			{ key: 'Mod-i', run: (view) => (toggleWrap(view, '_'), true) },
			...closeBracketsKeymap,
			...defaultKeymap,
			...searchKeymap,
			...historyKeymap,
			...foldKeymap,
			...completionKeymap,
			...lintKeymap,
			// Tab indents, as writers expect. Escape then Tab moves focus out of the editor.
			indentWithTab
		]),

		EditorState.readOnly.of(options.readOnly),
		EditorView.editable.of(!options.readOnly),
		EditorView.contentAttributes.of({
			'aria-label': 'Typst source. Press Escape, then Tab, to leave the editor.'
		}),
		EditorView.updateListener.of((update) => {
			if (update.docChanged) options.onChange();
			if (update.docChanged || update.selectionSet) {
				const head = update.state.selection.main.head;
				const line = update.state.doc.lineAt(head);
				options.onCursor(line.number, head - line.from + 1);
			}
		}),
		theme
	];
}

/** Moves the cursor to a 1-based line and 0-based column and scrolls it into view. */
export function revealPosition(view: EditorView, lineNumber: number, column = 0): void {
	const line = view.state.doc.line(Math.max(1, Math.min(lineNumber, view.state.doc.lines)));
	const position = Math.min(line.from + column, line.to);
	view.dispatch({
		selection: { anchor: position },
		effects: EditorView.scrollIntoView(position, { y: 'center' })
	});
	view.focus();
}

export interface Heading {
	level: number;
	text: string;
	line: number;
}

/** Headings of the document, for the outline. */
export function extractHeadings(state: EditorState): Heading[] {
	const headings: Heading[] = [];
	syntaxTree(state).iterate({
		enter(node) {
			if (node.name !== 'Heading') return;
			const source = state.doc.sliceString(node.from, Math.min(node.to, node.from + 300));
			const match = /^(=+)\s*(.*)/.exec(source.split('\n')[0] ?? '');
			if (match) {
				headings.push({
					level: match[1].length,
					text: match[2].trim() || 'Untitled heading',
					line: state.doc.lineAt(node.from).number
				});
			}
			return false;
		}
	});
	return headings;
}
