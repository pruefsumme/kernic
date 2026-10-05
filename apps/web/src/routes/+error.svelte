<script lang="ts">
	import { page } from '$app/state';
	import BrandLockup from '#lib/components/BrandLockup.svelte';
</script>

<svelte:head>
	<title>{page.status} · Kernic</title>
</svelte:head>

<main>
	<a class="brand" href="/" aria-label="Kernic, back to projects"><BrandLockup height={26} /></a>
	<h1>{page.status === 404 ? 'This page does not exist' : 'Something went wrong'}</h1>
	<p>
		{#if page.status === 404}
			The link may be outdated, or the project was deleted or is not shared with you.
		{:else}
			{page.error?.message ?? 'An unexpected error occurred.'}
		{/if}
	</p>
	<p><a class="button primary" href="/">Go to your projects</a></p>
</main>

<style>
	main {
		display: grid;
		gap: var(--s-4);
		justify-items: start;
		max-width: 32rem;
		margin: 0 auto;
		padding: var(--s-7) var(--s-4);
	}

	.brand {
		color: var(--ink);
		margin-bottom: var(--s-5);
	}

	p {
		color: var(--ink-2);
	}
</style>
