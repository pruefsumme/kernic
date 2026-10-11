<script lang="ts">
	import { EditorState } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import type { Diagnostic } from './api.ts';
	import {
		editorExtensions,
		extractHeadings,
		setCompileDiagnostics,
		toEditorDiagnostics,
		type Heading
	} from './codemirror.ts';

	/**
	 * The CodeMirror view for one loaded file. Create a new instance (with
	 * `{#key}`) when another file is loaded; the document is not reactive.
	 */
	let {
		text,
		readOnly,
		diagnostics,
		fonts,
		view = $bindable(),
		onchange,
		onsave,
		oncursor,
		onheadings
	}: {
		text: string;
		readOnly: boolean;
		/** Compiler diagnostics for this file. */
		diagnostics: Diagnostic[];
		/** Font families installed on the server, offered inside `font: "…"`. */
		fonts: string[];
		view?: EditorView;
		onchange: () => void;
		onsave: () => void;
		oncursor: (line: number, column: number) => void;
		onheadings: (headings: Heading[]) => void;
	} = $props();

	let outlineTimer: ReturnType<typeof setTimeout> | undefined;

	function mount(parent: HTMLElement) {
		const created = new EditorView({
			parent,
			state: EditorState.create({
				doc: text,
				extensions: editorExtensions({
					fonts: () => fonts,
					readOnly,
					onSave: onsave,
					onCursor: oncursor,
					onChange: () => {
						onchange();
						// The outline only needs to follow typing loosely.
						clearTimeout(outlineTimer);
						outlineTimer = setTimeout(() => onheadings(extractHeadings(created.state)), 300);
					}
				})
			})
		});
		view = created;
		onheadings(extractHeadings(created.state));
		oncursor(1, 1);

		return () => {
			clearTimeout(outlineTimer);
			created.destroy();
			view = undefined;
		};
	}

	$effect(() => {
		if (!view) return;
		view.dispatch({
			effects: setCompileDiagnostics.of(toEditorDiagnostics(view.state, diagnostics))
		});
	});
</script>

<div class="editor" {@attach mount}></div>

<style>
	.editor {
		height: 100%;
		min-height: 0;
		overflow: hidden;
	}
</style>
