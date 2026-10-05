<script lang="ts">
	import BrandLockup from '#lib/components/BrandLockup.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<div class="auth">
	<header><BrandLockup height={30} /></header>
	<main>{@render children()}</main>
</div>

<style>
	.auth {
		display: grid;
		align-content: start;
		gap: var(--s-6);
		max-width: 26rem;
		margin: 0 auto;
		padding: clamp(var(--s-5), 12vh, 7rem) var(--s-4) var(--s-6);
	}

	main {
		display: grid;
		gap: var(--s-5);
	}

	main :global(form) {
		display: grid;
		gap: var(--s-4);
	}

	main :global(.lede) {
		color: var(--ink-2);
		margin-top: var(--s-2);
	}

	main :global(.button.primary) {
		justify-self: start;
		padding: 0 var(--s-4);
	}
</style>
