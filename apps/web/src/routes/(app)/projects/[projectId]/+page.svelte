<script lang="ts">
	import ProjectEditor from '#lib/editor/ProjectEditor.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.project.name} · Kernic</title>
</svelte:head>

<!-- A fresh editor per project: its session state must not leak between projects. -->
{#key data.project.id}
	<ProjectEditor
		project={data.project}
		canWrite={data.canWrite}
		entries={data.entries}
		lastRender={data.lastRender}
	/>
{/key}
