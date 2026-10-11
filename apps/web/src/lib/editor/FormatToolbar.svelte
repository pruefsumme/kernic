<script lang="ts">
	import { redo, undo } from '@codemirror/commands';
	import type { EditorView } from '@codemirror/view';
	import Icon from '#lib/components/Icon.svelte';
	import Menu from '#lib/components/Menu.svelte';
	import { insertLink, setLinePrefix, toggleWrap } from './formatting.ts';

	/** Formatting shortcuts above the source editor. Each one edits the Typst markup. */
	let {
		view,
		disabled,
		cursor,
		note = null
	}: {
		view: EditorView | undefined;
		disabled: boolean;
		cursor: { line: number; column: number } | null;
		/** A short remark about the editor's state, with the reason as its tooltip. */
		note?: { label: string; detail: string } | null;
	} = $props();

	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	const mod = isMac ? '⌘' : 'Ctrl+';

	function run(command: (view: EditorView) => void) {
		if (view) command(view);
	}
</script>

<div class="toolbar" role="toolbar" aria-label="Formatting">
	<button
		type="button"
		{disabled}
		title="Undo ({mod}Z)"
		aria-label="Undo"
		onclick={() => run(undo)}
	>
		<Icon name="undo" size={18} />
	</button>
	<button
		type="button"
		{disabled}
		title="Redo ({mod}{isMac ? '⇧Z' : 'Y'})"
		aria-label="Redo"
		onclick={() => run(redo)}
	>
		<Icon name="redo" size={18} />
	</button>

	<span class="divider"></span>

	<Menu triggerClass="tool text">
		{#snippet trigger()}Heading <Icon name="chevronDown" size={14} />{/snippet}
		<button role="menuitem" {disabled} onclick={() => run((v) => setLinePrefix(v, '= '))}>
			Heading 1 <code>=</code>
		</button>
		<button role="menuitem" {disabled} onclick={() => run((v) => setLinePrefix(v, '== '))}>
			Heading 2 <code>==</code>
		</button>
		<button role="menuitem" {disabled} onclick={() => run((v) => setLinePrefix(v, '=== '))}>
			Heading 3 <code>===</code>
		</button>
		<button role="menuitem" {disabled} onclick={() => run((v) => setLinePrefix(v, ''))}>
			Body text
		</button>
	</Menu>

	<button
		type="button"
		class="glyph bold"
		{disabled}
		title="Bold ({mod}B)"
		aria-label="Bold"
		onclick={() => run((v) => toggleWrap(v, '*'))}
	>
		B
	</button>
	<button
		type="button"
		class="glyph italic"
		{disabled}
		title="Italic ({mod}I)"
		aria-label="Italic"
		onclick={() => run((v) => toggleWrap(v, '_'))}
	>
		I
	</button>

	<span class="divider"></span>

	<button
		type="button"
		{disabled}
		title="Bulleted list"
		aria-label="Bulleted list"
		onclick={() => run((v) => setLinePrefix(v, '- '))}
	>
		<Icon name="bulletList" size={18} />
	</button>
	<button
		type="button"
		{disabled}
		title="Numbered list"
		aria-label="Numbered list"
		onclick={() => run((v) => setLinePrefix(v, '+ '))}
	>
		<Icon name="numberList" size={18} />
	</button>

	<span class="divider"></span>

	<button type="button" {disabled} title="Link" aria-label="Link" onclick={() => run(insertLink)}>
		<Icon name="link" size={18} />
	</button>
	<button
		type="button"
		class="glyph math"
		{disabled}
		title="Inline math"
		aria-label="Inline math"
		onclick={() => run((v) => toggleWrap(v, '$'))}
	>
		∑
	</button>
	<button
		type="button"
		{disabled}
		title="Inline code"
		aria-label="Inline code"
		onclick={() => run((v) => toggleWrap(v, '`'))}
	>
		<Icon name="code" size={18} />
	</button>

	{#if note}
		<span class="note" title={note.detail}>{note.label}</span>
	{/if}
	{#if cursor}
		<span class="cursor">Ln {cursor.line}, Col {cursor.column}</span>
	{/if}
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		min-height: 2.5rem;
		padding: 0 var(--s-2);
		border-bottom: 1px solid var(--rule);
		background: var(--surface);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.toolbar > button,
	.toolbar :global(.tool) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--s-1);
		flex: none;
		min-width: 2rem;
		height: 2rem;
		padding: 0 var(--s-1);
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--ink-2);
		font: inherit;
		font-size: var(--t-ui);
		cursor: pointer;
		transition:
			background-color var(--fast) var(--ease-out),
			color var(--fast) var(--ease-out),
			scale var(--fast) var(--ease-out);
	}

	.toolbar > button:active:not(:disabled) {
		scale: 0.92;
	}

	.toolbar :global(.tool.text) {
		padding: 0 var(--s-2);
	}

	.toolbar > button:hover:not(:disabled),
	.toolbar :global(.tool:hover) {
		background: var(--sunken);
		color: var(--ink);
	}

	.toolbar > button:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}

	.glyph {
		font-size: 1rem !important;
	}

	.bold {
		font-weight: 700 !important;
	}

	.italic {
		font-family: Georgia, 'Times New Roman', serif !important;
		font-style: italic;
	}

	.divider {
		flex: none;
		width: 1px;
		height: 1.25rem;
		margin: 0 var(--s-1);
		background: var(--rule);
	}

	.note {
		flex: none;
		margin-left: auto;
		padding-left: var(--s-3);
		color: var(--ink-2);
		font-size: var(--t-meta);
		white-space: nowrap;
		cursor: help;
	}

	.note + .cursor {
		margin-left: 0;
	}

	.cursor {
		flex: none;
		margin-left: auto;
		padding-left: var(--s-3);
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.toolbar :global([role='menuitem'] code) {
		margin-left: auto;
		color: var(--ink-3);
	}
</style>
