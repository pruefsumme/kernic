<script lang="ts" module>
	// Line icons on a 20px grid, 1.5px stroke. Each is a list of path data.
	const paths = {
		projects: ['M3 5.5h5l1.5 2H17v8.5H3z'],
		files: ['M5.5 2.5h6l3.5 3.5v11.5h-9.5z', 'M11.5 2.5V6H15'],
		outline: ['M3 5h14', 'M6 10h11', 'M6 15h11', 'M3 10h.01', 'M3 15h.01'],
		issues: ['M10 3 2.5 16.5h15z', 'M10 8.5v3.5', 'M10 14.2v.3'],
		settings: ['M3 6h8', 'M15 6h2', 'M3 14h2', 'M9 14h8', 'M13 4v4', 'M7 12v4'],
		help: [
			'M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z',
			'M7.8 7.8a2.3 2.3 0 1 1 3.3 2.1c-.7.4-1.1.9-1.1 1.7',
			'M10 14.2v.3'
		],
		plus: ['M10 4v12', 'M4 10h12'],
		minus: ['M4 10h12'],
		close: ['M5 5l10 10', 'M15 5 5 15'],
		search: ['M9 15.5A6.5 6.5 0 1 0 9 2.5a6.5 6.5 0 0 0 0 13z', 'M13.8 13.8 17.5 17.5'],
		chevronDown: ['M5 7.5l5 5 5-5'],
		chevronRight: ['M7.5 5l5 5-5 5'],
		file: ['M5.5 2.5h6l3.5 3.5v11.5h-9.5z', 'M11.5 2.5V6H15'],
		folder: ['M3 5.5h5l1.5 2H17v8.5H3z'],
		image: ['M3 4h14v12H3z', 'M3 13l4-4 4 4 2.5-2.5L17 14', 'M13 7.5h.01'],
		upload: ['M10 13V3.5', 'M6 7l4-4 4 4', 'M3.5 13v3.5h13V13'],
		download: ['M10 3.5V13', 'M6 9.5l4 4 4-4', 'M3.5 13v3.5h13V13'],
		// Three dots drawn as small circles, so they stay visible at the 1.5px stroke.
		more: [
			'M3.9 10a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0',
			'M9.4 10a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0',
			'M14.9 10a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0'
		],
		grid: [
			'M3.5 3.5h5.5v5.5H3.5z',
			'M11 3.5h5.5v5.5H11z',
			'M3.5 11h5.5v5.5H3.5z',
			'M11 11h5.5v5.5H11z'
		],
		list: ['M3 5h14', 'M3 10h14', 'M3 15h14'],
		undo: ['M7 4 3.5 7.5 7 11', 'M3.5 7.5H12a4.5 4.5 0 0 1 0 9H8'],
		redo: ['M13 4l3.5 3.5L13 11', 'M16.5 7.5H8a4.5 4.5 0 0 0 0 9h4'],
		bulletList: [
			'M7.5 5H17',
			'M7.5 10H17',
			'M7.5 15H17',
			'M3.5 5h.01',
			'M3.5 10h.01',
			'M3.5 15h.01'
		],
		numberList: [
			'M8 5h9',
			'M8 10h9',
			'M8 15h9',
			'M3 4l1.2-.8V7',
			'M3 12.2c0-1.3 2.2-1.3 2.2 0 0 1-2.2 1.6-2.2 2.8h2.4'
		],
		code: ['M7 6l-4 4 4 4', 'M13 6l4 4-4 4'],
		link: [
			'M8.5 11.5a3 3 0 0 0 4.2 0l3-3a3 3 0 0 0-4.2-4.2l-1 1',
			'M11.5 8.5a3 3 0 0 0-4.2 0l-3 3a3 3 0 0 0 4.2 4.2l1-1'
		],
		check: ['M4 10.5l4 4 8-9'],
		history: ['M3.5 10a6.5 6.5 0 1 0 2-4.7', 'M3 3.5v3h3', 'M10 6.5V10l2.5 1.5'],
		signOut: ['M8 3.5H4v13h4', 'M12.5 6.5 16 10l-3.5 3.5', 'M16 10H8']
	} as const;

	export type IconName = keyof typeof paths;
</script>

<script lang="ts">
	let { name, size = 20 }: { name: IconName; size?: number } = $props();
</script>

<svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
	{#each paths[name] as d (d)}
		<path {d} />
	{/each}
</svg>

<style>
	svg {
		flex: none;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
