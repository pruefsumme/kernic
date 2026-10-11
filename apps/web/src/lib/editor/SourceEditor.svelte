<script lang="ts">
	import { untrack } from 'svelte';
	import { EditorState, type Extension } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import type { Diagnostic } from './api.ts';
	import {
		editorExtensions,
		extractHeadings,
		setAssistance,
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
		assistance,
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
		/** Connects this file to the language server; null while there is none. */
		assistance: Extension | null;
		view?: EditorView;
		onchange: () => void;
		onsave: () => void;
		oncursor: (line: number, column: number) => void;
		onheadings: (headings: Heading[]) => void;
	} = $props();

	let outlineTimer: ReturnType<typeof setTimeout> | undefined;

	/** What the editor is currently connected with, to change it only when it changes. */
	let connected: Extension | null = untrack(() => assistance);

	// The language server may become available, or go away, while a file is open.
	$effect(() => {
		const wanted = assistance;
		if (!view || wanted === connected) return;
		connected = wanted;
		setAssistance(view, wanted);
	});

	function mount(parent: HTMLElement) {
		const created = new EditorView({
			parent,
			state: EditorState.create({
				doc: text,
				extensions: editorExtensions({
					assistance: connected,
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
