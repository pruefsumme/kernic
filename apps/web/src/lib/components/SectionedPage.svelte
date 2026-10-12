<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { PageSection } from './sections.ts';

	/**
	 * A page of settings: its sections are listed at the side (across the top on
	 * a narrow screen) and one of them is shown at a time. With a single section
	 * there is nothing to choose and the list is left out.
	 */
	let {
		heading,
		lede,
		actions,
		sections,
		active,
		children
	}: {
		heading: string;
		lede?: Snippet;
		/** Buttons or links beside the heading. */
		actions?: Snippet;
		sections: readonly PageSection[];
		active: string;
		children: Snippet;
	} = $props();

	const choice = $derived(sections.length > 1);
</script>

<div class="page" class:choice>
	<header>
		<div>
			<h1>{heading}</h1>
			{#if lede}<p class="lede">{@render lede()}</p>{/if}
		</div>
		{#if actions}<div class="actions">{@render actions()}</div>{/if}
	</header>

	{#if choice}
		<nav aria-label="Sections">
			{#each sections as section (section.id)}
				<!-- A change of section is not a new page: no scrolling up, no step in the history. -->
				<a
					href="?section={section.id}"
					aria-current={section.id === active ? 'page' : undefined}
					data-sveltekit-noscroll
					data-sveltekit-replacestate
					data-sveltekit-keepfocus
				>
					<Icon name={section.icon} size={18} />
					<span>{section.label}</span>
				</a>
			{/each}
		</nav>
	{/if}

	<div class="content">
		{@render children()}
	</div>
</div>

<style>
	.page {
		display: grid;
		gap: var(--s-5);
		max-width: 44rem;
		margin: 0 auto;
		padding: var(--s-5) var(--s-5) var(--s-7);
	}

	.page.choice {
		grid-template-columns: 12.5rem minmax(0, 1fr);
		column-gap: var(--s-6);
		max-width: 62rem;
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		justify-content: space-between;
		gap: var(--s-3);
		grid-column: 1 / -1;
		padding-bottom: var(--s-4);
		border-bottom: 1px solid var(--rule);
	}

	header > div:first-child {
		min-width: 0;
	}

	.lede {
		margin-top: var(--s-1);
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	nav {
		position: sticky;
		top: var(--s-4);
		display: grid;
		align-content: start;
		align-self: start;
		gap: 2px;
	}

	nav a {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 2.25rem;
		padding: 0 var(--s-3);
		border-radius: var(--radius);
		color: var(--ink-2);
		font-size: var(--t-ui);
		font-weight: 500;
		text-decoration: none;
		transition:
			background-color var(--fast) var(--ease-out),
			color var(--fast) var(--ease-out);
	}

	nav a:hover {
		background: var(--sunken);
		color: var(--ink);
	}

	nav a[aria-current='page'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.content {
		display: grid;
		align-content: start;
		gap: var(--s-4);
		min-width: 0;
	}

	@media (max-width: 800px) {
		.page,
		.page.choice {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--s-4);
			padding: var(--s-4) var(--s-3) var(--s-6);
		}

		/* The sections become a row that scrolls sideways within itself. */
		nav {
			position: static;
			display: flex;
			gap: var(--s-1);
			margin: 0 calc(-1 * var(--s-3));
			padding: 0 var(--s-3) var(--s-1);
			overflow-x: auto;
			scrollbar-width: none;
		}

		nav a {
			flex: none;
			border: 1px solid var(--rule);
			border-radius: 2rem;
		}

		nav a[aria-current='page'] {
			border-color: transparent;
		}
	}
</style>
