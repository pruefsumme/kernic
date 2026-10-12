<script lang="ts">
	import { page } from '$app/state';
	import BrandLockup from '#lib/components/BrandLockup.svelte';
</script>

<svelte:head>
	<title>Shared document · Kernic</title>
</svelte:head>

<main>
	<span class="brand"><BrandLockup height={26} /></span>
	<h1>{page.status === 404 ? 'This link does not show anything' : 'Not right now'}</h1>
	<p>
		{#if page.status === 404}
			It may have been withdrawn or have expired, or part of it got lost when it was copied. Ask
			whoever sent it for a new one.
		{:else}
			{page.error?.message ?? 'Something went wrong. Try again in a moment.'}
		{/if}
	</p>
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
		margin-bottom: var(--s-5);
		color: var(--ink);
	}

	p {
		color: var(--ink-2);
	}
</style>
