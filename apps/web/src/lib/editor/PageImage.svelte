<script lang="ts">
	import { untrack } from 'svelte';

	/**
	 * One rendered page. When the page changes, the new rendering fades in over
	 * the old one, which stays until the new one has loaded — the page never
	 * flashes empty while you type.
	 */
	let { url, alt }: { url: string; alt: string } = $props();

	interface Layer {
		id: number;
		url: string;
		loaded: boolean;
	}

	let nextId = 0;
	let layers = $state<Layer[]>([]);

	$effect(() => {
		const current = url;
		untrack(() => {
			if (layers.at(-1)?.url !== current)
				layers.push({ id: nextId++, url: current, loaded: false });
		});
	});

	function onLoaded(layer: Layer) {
		return (image: HTMLImageElement) => {
			const settle = () => {
				layer.loaded = true;
				// Once the new rendering covers the old ones, they can go.
				setTimeout(() => {
					const index = layers.findIndex((candidate) => candidate.id === layer.id);
					if (index > 0) layers.splice(0, index);
				}, 250);
			};
			if (image.complete && image.naturalWidth > 0) settle();
			else image.addEventListener('load', settle, { once: true });
			return () => image.removeEventListener('load', settle);
		};
	}
</script>

{#each layers as layer, index (layer.id)}
	<img
		{@attach onLoaded(layer)}
		class:loaded={layer.loaded}
		src={layer.url}
		alt={index === layers.length - 1 ? alt : ''}
		decoding="async"
	/>
{/each}

<style>
	img {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		opacity: 0;
		transition: opacity 180ms var(--ease-out);
	}

	img.loaded {
		opacity: 1;
	}
</style>
