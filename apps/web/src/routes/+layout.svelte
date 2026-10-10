<script lang="ts">
	import '@fontsource-variable/ibm-plex-sans/wght.css';
	import '@fontsource/ibm-plex-mono/400.css';
	import '@fontsource/ibm-plex-mono/400-italic.css';
	import '@fontsource/ibm-plex-mono/500.css';
	import '../app.css';
	import { onNavigate } from '$app/navigation';
	import favicon from '#lib/assets/favicon.svg';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	// Cross-fade between screens where the browser supports it. Changes within a
	// screen (opening a file, a dialog in the address) are not transitions.
	onNavigate((navigation) => {
		if (
			!document.startViewTransition ||
			navigation.shallow ||
			navigation.from?.route.id === navigation.to?.route.id ||
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			return;
		}
		return new Promise((resolve) => {
			document.startViewTransition(async () => {
				resolve();
				await navigation.complete;
			});
		});
	});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}
