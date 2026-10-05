<script lang="ts">
	import type { Heading } from './codemirror.ts';
	import SidePanel from './SidePanel.svelte';

	let {
		headings,
		fileName,
		available,
		onreveal,
		onclose
	}: {
		headings: Heading[];
		/** Name of the open file, shown so it is clear whose outline this is. */
		fileName: string | null;
		/** False when the open file is not editable text. */
		available: boolean;
		onreveal: (line: number) => void;
		onclose: () => void;
	} = $props();

	// Indent relative to the shallowest heading, so a file of only `==` headings is not indented.
	const baseLevel = $derived(Math.min(...headings.map((heading) => heading.level), 6));
</script>

<SidePanel title="Outline" {onclose}>
	{#if !available}
		<p class="empty">Open a Typst file to see its headings here.</p>
	{:else if headings.length === 0}
		<p class="empty">
			{fileName ?? 'This file'} has no headings yet. Start a line with <code>=</code> to add one.
		</p>
	{:else}
		{#if fileName}<p class="file">{fileName}</p>{/if}
		<ul>
			{#each headings as heading (heading.line)}
				<li style:--depth={heading.level - baseLevel}>
					<button
						type="button"
						class:top={heading.level === baseLevel}
						onclick={() => onreveal(heading.line)}
					>
						{heading.text}
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</SidePanel>

<style>
	.empty,
	.file {
		padding: var(--s-1) var(--s-3);
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.file {
		font-size: var(--t-meta);
		overflow-wrap: anywhere;
	}

	ul {
		margin: 0;
		padding: 0 var(--s-1) var(--s-4);
		list-style: none;
	}

	button {
		display: block;
		width: 100%;
		padding: 0.3rem var(--s-2) 0.3rem calc(var(--s-2) + var(--depth) * 0.875rem);
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--ink-2);
		font: inherit;
		font-size: var(--t-ui);
		line-height: 1.35;
		text-align: left;
		overflow-wrap: anywhere;
		cursor: pointer;
	}

	button.top {
		color: var(--ink);
		font-weight: 500;
	}

	button:hover {
		background: var(--sunken);
		color: var(--ink);
	}
</style>
