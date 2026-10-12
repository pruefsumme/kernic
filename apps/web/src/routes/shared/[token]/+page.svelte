<script lang="ts">
	import BrandMark from '#lib/components/BrandMark.svelte';
	import { formatExact, formatWhen } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const pages = $derived(data.document.pages);
</script>

<svelte:head>
	<title>{data.document.name} · Kernic</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<div class="shared">
	<header>
		<span class="brand"><BrandMark size={22} /></span>
		<h1>{data.document.name}</h1>
		<p>
			Shared for reading
			{#if data.document.renderedAt}
				· {pages.length === 1 ? '1 page' : `${pages.length} pages`} · as of
				<time
					datetime={data.document.renderedAt.toISOString()}
					title={formatExact(data.document.renderedAt)}>{formatWhen(data.document.renderedAt)}</time
				>
			{/if}
		</p>
	</header>

	<main>
		{#if pages.length === 0}
			<div class="empty">
				<h2>Nothing to show yet</h2>
				<p>
					This document has not been rendered. Ask whoever sent you the link, or try again later.
				</p>
			</div>
		{:else}
			{#each pages as page, index (index)}
				<img
					class="sheet"
					src="/shared/{data.token}/pages/{page.hash}"
					alt="Page {index + 1} of {pages.length}"
					width={page.width}
					height={page.height}
					loading={index < 2 ? 'eager' : 'lazy'}
					decoding="async"
				/>
			{/each}
		{/if}
	</main>
</div>

<style>
	.shared {
		display: grid;
		grid-template-rows: auto 1fr;
		min-height: 100dvh;
		background: var(--desk);
	}

	header {
		position: sticky;
		z-index: 1;
		top: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--s-1) var(--s-3);
		padding: var(--s-2) var(--s-4);
		border-bottom: 1px solid var(--rule);
		background: var(--ground);
	}

	.brand {
		align-self: center;
	}

	h1 {
		font-size: var(--t-ui);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	header p {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	main {
		display: grid;
		justify-items: center;
		gap: var(--s-4);
		padding: var(--s-5) var(--s-4) var(--s-7);
	}

	.sheet {
		display: block;
		width: min(100%, 56rem);
		height: auto;
		background: var(--paper);
		filter: var(--page-filter);
		box-shadow: var(--shadow-sheet);
	}

	.empty {
		display: grid;
		gap: var(--s-2);
		max-width: 28rem;
		padding: var(--s-7) 0;
		text-align: center;
	}

	.empty h2 {
		font-size: var(--t-heading);
	}

	.empty p {
		color: var(--ink-2);
	}
</style>
