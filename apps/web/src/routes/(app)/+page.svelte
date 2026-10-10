<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppShell from '#lib/components/AppShell.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import TemplatePicker from '#lib/components/TemplatePicker.svelte';
	import { helpDestination, projectsDestination } from '#lib/components/rail.ts';
	import { formatExact, formatWhen } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	type View = 'grid' | 'list';
	type Sort = 'edited' | 'name';

	let query = $state('');
	let view = $state<View>('grid');
	let sort = $state<Sort>('edited');
	let pickerOpen = $state(false);
	let creatingEmpty = $state(false);

	// View and sort are personal preferences, remembered on this device.
	$effect(() => {
		const stored = localStorage.getItem('kernic.projects');
		if (!stored) return;
		try {
			const parsed = JSON.parse(stored);
			if (parsed.view === 'grid' || parsed.view === 'list') view = parsed.view;
			if (parsed.sort === 'edited' || parsed.sort === 'name') sort = parsed.sort;
		} catch {
			// ignore a corrupted preference
		}
	});

	function remember() {
		localStorage.setItem('kernic.projects', JSON.stringify({ view, sort }));
	}

	// The picker is addressable (/?new), so the rail's "New" works from any screen.
	$effect(() => {
		if (page.url.searchParams.has('new') || form?.message) pickerOpen = true;
	});

	$effect(() => {
		if (!pickerOpen && page.url.searchParams.has('new')) {
			void goto('/', { replace: true, reset: false });
		}
	});

	const canCreate = $derived(data.workspaces.length > 0);
	const projects = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		const matching = data.projects.filter((project) => project.name.toLowerCase().includes(needle));
		return sort === 'name'
			? matching.toSorted((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
			: matching;
	});
	const showWorkspace = $derived(
		new Set(data.projects.map((project) => project.workspaceId)).size > 1
	);
</script>

<svelte:head>
	<title>Projects · Kernic</title>
</svelte:head>

<AppShell
	userName={data.user.displayName}
	destinations={[projectsDestination(true)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">Projects</span>
	{/snippet}

	<div class="page">
		<label class="search">
			<span class="visually-hidden">Search projects</span>
			<Icon name="search" size={18} />
			<input type="search" placeholder="Search projects" bind:value={query} />
		</label>

		<section class="create" aria-label="Create a project">
			<form
				method="POST"
				action="/?/create"
				use:enhance={() => {
					creatingEmpty = true;
					return async ({ update }) => {
						await update();
						creatingEmpty = false;
					};
				}}
			>
				<input type="hidden" name="name" value="Untitled document" />
				<input type="hidden" name="template" value="blank" />
				<input type="hidden" name="workspace" value={data.workspaces[0]?.id} />
				<button class="start primary" disabled={!canCreate || creatingEmpty}>
					<Icon name="file" size={22} />
					<span>
						<strong>{creatingEmpty ? 'Creating…' : 'Empty document'}</strong>
						<small>One blank Typst file</small>
					</span>
				</button>
			</form>
			<button class="start" disabled={!canCreate} onclick={() => (pickerOpen = true)}>
				<Icon name="grid" size={22} />
				<span>
					<strong>Start from template</strong>
					<small>Article, report, letter</small>
				</span>
			</button>
			{#if canCreate}
				<a class="import" href="/import"><Icon name="upload" size={16} /> Import a ZIP archive</a>
			{/if}
		</section>
		{#if !canCreate}
			<p class="notice">
				You have read-only access to every workspace you belong to. Ask a workspace owner for edit
				access to create projects.
			</p>
		{/if}

		{#if data.projects.length === 0}
			<div class="empty">
				<h1>No projects yet</h1>
				<p>
					A project is a folder of Typst files with one main file that is compiled into your
					document. Create one above: you write the source on the left and see the pages on the
					right.
				</p>
			</div>
		{:else}
			<div class="toolbar">
				<h1>
					{query.trim() ? `Results for “${query.trim()}”` : 'All projects'}
				</h1>
				<div class="controls">
					<label class="sort">
						<span>Sort by</span>
						<select bind:value={sort} onchange={remember}>
							<option value="edited">Last edited</option>
							<option value="name">Name</option>
						</select>
					</label>
					<div class="views" role="group" aria-label="Layout">
						<button
							type="button"
							aria-pressed={view === 'grid'}
							onclick={() => {
								view = 'grid';
								remember();
							}}
						>
							<Icon name="grid" size={16} /> Grid
						</button>
						<button
							type="button"
							aria-pressed={view === 'list'}
							onclick={() => {
								view = 'list';
								remember();
							}}
						>
							<Icon name="list" size={16} /> List
						</button>
					</div>
				</div>
			</div>

			{#if projects.length === 0}
				<p class="notice">
					No project name contains “{query.trim()}”.
					<button class="button small" onclick={() => (query = '')}>Clear search</button>
				</p>
			{:else}
				<ul class="projects {view}">
					{#each projects as project (project.id)}
						<li>
							<a href="/projects/{project.id}">
								<span class="thumb" class:blank={!project.thumbnailHash} aria-hidden="true">
									{#if project.thumbnailHash}
										<img
											src="/api/projects/{project.id}/pages/{project.thumbnailHash}"
											alt=""
											loading="lazy"
										/>
									{:else}
										<!-- Not rendered yet: a sheet with a few ruled lines instead of an empty box. -->
										<span class="lines"></span>
									{/if}
								</span>
								<span class="name">{project.name}</span>
								<span class="meta">
									{#if showWorkspace}<span>{project.workspaceName}</span>{/if}
									{#if project.role === 'viewer'}<span>Read only</span>{/if}
									<time
										datetime={project.updatedAt.toISOString()}
										title={formatExact(project.updatedAt)}
									>
										Edited {formatWhen(project.updatedAt)}
									</time>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</AppShell>

<TemplatePicker
	bind:open={pickerOpen}
	templates={data.templates}
	categories={data.templateCategories}
	workspaces={data.workspaces}
	error={form?.message}
	initialName={form?.name ?? ''}
	initialTemplateId={form?.templateId || undefined}
/>

<style>
	.where {
		font-weight: 600;
	}

	.page {
		display: grid;
		gap: var(--s-5);
		max-width: 68rem;
		margin: 0 auto;
		padding: var(--s-5) var(--s-5) var(--s-7);
	}

	.search {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		max-width: 34rem;
		min-height: 2.5rem;
		padding: 0 var(--s-3);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--ink-2);
	}

	.search {
		transition:
			border-color var(--fast) var(--ease-out),
			box-shadow var(--fast) var(--ease-out);
	}

	.search:focus-within {
		border-color: var(--focus);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.search input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		outline: none;
	}

	.create {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-3);
	}

	.start {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-width: 15rem;
		min-height: 4rem;
		padding: var(--s-2) var(--s-4);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--ink);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.start {
		box-shadow: 0 1px 0 oklch(20% 0.02 250 / 0.05);
		transition:
			background-color var(--fast) var(--ease-out),
			border-color var(--fast) var(--ease-out),
			translate var(--fast) var(--ease-out);
	}

	.start:hover:not(:disabled) {
		border-color: var(--ink);
		background: var(--surface);
	}

	.start:active:not(:disabled) {
		translate: 0 1px;
	}

	.start :global(svg) {
		transition: translate var(--medium) var(--ease-out);
	}

	.start:hover:not(:disabled) :global(svg) {
		translate: 0 -1px;
	}

	.import {
		display: inline-flex;
		align-items: center;
		align-self: center;
		gap: var(--s-2);
		margin-left: var(--s-2);
		font-size: var(--t-ui);
	}

	.start.primary {
		border-color: var(--accent);
		background: var(--accent);
		color: var(--accent-ink);
	}

	.start.primary:hover:not(:disabled) {
		border-color: var(--accent-hover);
		background: var(--accent-hover);
	}

	.start:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.start span {
		display: grid;
	}

	.start strong {
		font-weight: 600;
	}

	.start small {
		font-size: var(--t-meta);
		opacity: 0.85;
	}

	.notice {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		color: var(--ink-2);
	}

	.empty {
		display: grid;
		gap: var(--s-2);
		max-width: 36rem;
		padding-top: var(--s-5);
		border-top: 1px solid var(--rule);
	}

	.empty p {
		color: var(--ink-2);
	}

	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2) var(--s-4);
		padding-top: var(--s-4);
		border-top: 1px solid var(--rule);
	}

	.toolbar h1 {
		font-size: var(--t-heading);
		overflow-wrap: anywhere;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: var(--s-4);
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.sort {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}

	.sort select {
		min-height: 1.75rem;
		padding: 0 var(--s-1);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--ink);
		font: inherit;
	}

	.views {
		display: flex;
	}

	.views button {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		min-height: 1.75rem;
		padding: 0 var(--s-2);
		border: 1px solid var(--control-border);
		background: var(--surface);
		color: var(--ink-2);
		font: inherit;
		cursor: pointer;
	}

	.views button:first-child {
		border-radius: var(--radius) 0 0 var(--radius);
	}

	.views button:last-child {
		margin-left: -1px;
		border-radius: 0 var(--radius) var(--radius) 0;
	}

	.views button,
	.sort select {
		transition:
			background-color var(--fast) var(--ease-out),
			color var(--fast) var(--ease-out),
			border-color var(--fast) var(--ease-out);
	}

	.views button:hover {
		color: var(--ink);
	}

	.views button[aria-pressed='true'] {
		position: relative;
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 500;
	}

	.projects {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.projects a {
		color: var(--ink);
		text-decoration: none;
	}

	.name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--s-3);
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.thumb {
		display: block;
		background: #fff;
		box-shadow: var(--shadow-sheet);
		overflow: hidden;
		transition:
			box-shadow var(--medium) var(--ease-out),
			translate var(--medium) var(--ease-out);
	}

	.lines {
		display: block;
		width: 46%;
		height: 28%;
		margin: 22% 0 0 14%;
		background: repeating-linear-gradient(to bottom, var(--rule) 0 2px, transparent 2px 10px);
		opacity: 0.8;
	}

	.thumb img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top;
	}

	/* Grid: the first page of each document, like sheets laid out on a table. */
	.projects.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr));
		gap: var(--s-5) var(--s-4);
	}

	.projects.grid a {
		display: grid;
		gap: 2px;
	}

	.projects.grid .thumb {
		aspect-ratio: 210 / 297;
		margin-bottom: var(--s-3);
		border-radius: 2px;
	}

	/* Hovering picks the sheet up a little. */
	.projects.grid a:hover .thumb,
	.projects.grid a:focus-visible .thumb {
		box-shadow: var(--shadow-sheet-raised);
		translate: 0 -3px;
	}

	.projects.grid a {
		border-radius: var(--radius);
		outline-offset: 6px;
	}

	.projects.grid .name {
		transition: color var(--fast) var(--ease-out);
	}

	.projects.grid a:hover .name {
		color: var(--accent);
	}

	/* List: one row per project. */
	.projects.list li {
		border-bottom: 1px solid var(--rule);
	}

	.projects.list a {
		display: grid;
		grid-template-columns: 1.75rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--s-1) var(--s-3);
		padding: var(--s-2);
	}

	.projects.list a {
		transition: background-color var(--fast) var(--ease-out);
	}

	.projects.list a:hover {
		background: var(--sunken);
	}

	.projects.list .thumb {
		width: 1.75rem;
		height: 2.375rem;
		border-radius: 2px;
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
			gap: var(--s-4);
		}

		.start {
			flex: 1 1 100%;
		}

		.create form {
			flex: 1 1 100%;
			display: grid;
		}

		.projects.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.projects.list a {
			grid-template-columns: 1.75rem minmax(0, 1fr);
		}

		.projects.list .meta {
			grid-column: 2;
		}
	}
</style>
