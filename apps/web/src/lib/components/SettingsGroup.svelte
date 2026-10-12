<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * One thing that can be set, with its name, a sentence about it and its
	 * controls, framed so that neighbouring things stay apart.
	 */
	let {
		title,
		description,
		danger = false,
		children
	}: {
		title: string;
		/** A sentence or two about what this is, as text or as markup. */
		description?: string | Snippet;
		/** For what cannot be undone. */
		danger?: boolean;
		children?: Snippet;
	} = $props();
</script>

<section class:danger>
	<div class="about">
		<h2>{title}</h2>
		{#if typeof description === 'string'}
			<p>{description}</p>
		{:else if description}
			<p>{@render description()}</p>
		{/if}
	</div>
	{#if children}
		<div class="body">{@render children()}</div>
	{/if}
</section>

<style>
	section {
		display: grid;
		gap: var(--s-4);
		padding: var(--s-4) var(--s-5) var(--s-5);
		border: 1px solid var(--rule);
		border-radius: calc(var(--radius) * 2);
		background: var(--surface);
	}

	section.danger {
		border-color: color-mix(in srgb, var(--error) 50%, var(--rule));
	}

	.about {
		display: grid;
		gap: var(--s-1);
	}

	h2 {
		font-size: var(--t-body);
		font-weight: 600;
	}

	.danger h2 {
		color: var(--error);
	}

	p {
		max-width: 38rem;
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.body {
		display: grid;
		gap: var(--s-3);
		min-width: 0;
	}

	/* Forms inside a group are laid out the same everywhere. */
	.body :global(form) {
		display: grid;
		gap: var(--s-3);
	}

	.body :global(.field) {
		max-width: 26rem;
	}

	.body :global(.row) {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-3);
	}

	.body :global(.saved),
	.body :global(.help) {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.body :global(h3) {
		font-size: var(--t-ui);
		font-weight: 600;
	}

	@media (max-width: 640px) {
		section {
			padding: var(--s-4);
		}
	}
</style>
