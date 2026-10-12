<script lang="ts" module>
	export interface TemplateOption {
		id: string;
		name: string;
		category: string;
		description: string;
		files: string[];
	}
</script>

<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import Icon from './Icon.svelte';

	let {
		open = $bindable(false),
		templates,
		categories,
		workspaces,
		error = null,
		initialName = '',
		initialTemplateId,
		initialWorkspaceId
	}: {
		open: boolean;
		templates: TemplateOption[];
		categories: string[];
		workspaces: { id: string; name: string }[];
		/** Message from a failed create, shown above the Create button. */
		error?: string | null;
		initialName?: string;
		initialTemplateId?: string;
		/** The workspace offered first, when the picker was opened from one. */
		initialWorkspaceId?: string | null;
	} = $props();

	let dialog: HTMLDialogElement;
	let query = $state('');
	let category = $state<string | null>(null);
	let selectedId = $state(untrack(() => initialTemplateId ?? templates[0]?.id ?? ''));
	let submitting = $state(false);

	const visible = $derived(
		templates.filter((template) => {
			if (category && template.category !== category) return false;
			const needle = query.trim().toLowerCase();
			return (
				needle === '' ||
				template.name.toLowerCase().includes(needle) ||
				template.description.toLowerCase().includes(needle)
			);
		})
	);
	const selected = $derived(templates.find((template) => template.id === selectedId));
	// Only categories that have templates are offered as filters.
	const usedCategories = $derived(
		categories.filter((name) => templates.some((template) => template.category === name))
	);

	$effect(() => {
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-labelledby="template-picker-title">
	<form
		method="POST"
		action="/?/create"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		}}
	>
		<header>
			<h2 id="template-picker-title">Start from a template</h2>
			<button
				class="button quiet small"
				type="button"
				aria-label="Close"
				onclick={() => (open = false)}
			>
				<Icon name="close" size={18} />
			</button>
		</header>

		<div class="filters">
			<label class="search">
				<span class="visually-hidden">Search templates</span>
				<Icon name="search" size={16} />
				<!-- svelte-ignore a11y_autofocus -->
				<input type="search" placeholder="Search templates" bind:value={query} autofocus />
			</label>
			<div class="categories" role="group" aria-label="Category">
				<button
					type="button"
					class="chip"
					aria-pressed={category === null}
					onclick={() => (category = null)}
				>
					All
				</button>
				{#each usedCategories as name (name)}
					<button
						type="button"
						class="chip"
						aria-pressed={category === name}
						onclick={() => (category = name)}
					>
						{name}
					</button>
				{/each}
			</div>
		</div>

		<div class="content">
			<div class="gallery">
				{#each visible as template (template.id)}
					<label class="option">
						<input type="radio" name="template" value={template.id} bind:group={selectedId} />
						<span class="thumb">
							<img src="/template-previews/{template.id}.svg" alt="" loading="lazy" />
						</span>
						<span class="option-name">{template.name}</span>
						<span class="option-category">{template.category}</span>
					</label>
				{:else}
					<p class="no-match">
						No template matches{query.trim() ? ` “${query.trim()}”` : ''}{category
							? ` in ${category}`
							: ''}.
						<button
							class="button small"
							type="button"
							onclick={() => {
								query = '';
								category = null;
							}}
						>
							Show all templates
						</button>
					</p>
				{/each}
			</div>

			<aside class="details" aria-live="polite">
				{#if selected}
					{#key selected.id}
						<div class="arrive">
							<div class="preview">
								<img
									src="/template-previews/{selected.id}.svg"
									alt="First page of the {selected.name} template"
								/>
							</div>
							<h3>{selected.name}</h3>
							<p>{selected.description}</p>
							<p class="files">
								{selected.files.length === 1 ? '1 file' : `${selected.files.length} files`}:
								{selected.files.join(', ')}
							</p>
						</div>
					{/key}
				{/if}
			</aside>
		</div>

		<footer>
			{#if error}
				<p class="form-error" role="alert">{error}</p>
			{/if}
			<div class="create">
				<div class="field">
					<label for="template-project-name">Project name</label>
					<input
						class="input"
						id="template-project-name"
						name="name"
						required
						maxlength="120"
						autocomplete="off"
						value={initialName}
					/>
				</div>
				{#if workspaces.length > 1}
					<div class="field">
						<label for="template-workspace">Workspace</label>
						<select class="input" id="template-workspace" name="workspace">
							{#each workspaces as workspace (workspace.id)}
								<option value={workspace.id} selected={workspace.id === initialWorkspaceId}>
									{workspace.name}
								</option>
							{/each}
						</select>
					</div>
				{:else}
					<input type="hidden" name="workspace" value={workspaces[0]?.id} />
				{/if}
				<button class="button primary" disabled={submitting || !selected}>
					{submitting ? 'Creating…' : 'Create project'}
				</button>
			</div>
		</footer>
	</form>
</dialog>

<style>
	dialog {
		width: min(58rem, calc(100vw - 2rem));
		height: min(42rem, calc(100dvh - 2rem));
		max-width: none;
		max-height: none;
		padding: 0;
		border: 1px solid var(--rule);
		border-radius: var(--radius-float);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-float);
	}

	dialog::backdrop {
		background: var(--scrim);
	}

	form {
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr) auto;
		height: 100%;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--s-3) var(--s-3) var(--s-3) var(--s-4);
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-4);
		padding: 0 var(--s-4) var(--s-3);
		border-bottom: 1px solid var(--rule);
	}

	.search {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex: 1 1 14rem;
		max-width: 20rem;
		min-height: var(--control-height);
		padding: 0 var(--s-2);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
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

	.categories {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
	}

	.chip {
		min-height: 1.75rem;
		padding: 0 var(--s-3);
		border: 1px solid var(--rule);
		border-radius: 1rem;
		background: var(--surface);
		color: var(--ink-2);
		font: inherit;
		font-size: var(--t-ui);
		cursor: pointer;
	}

	.chip {
		transition:
			background-color var(--fast) var(--ease-out),
			border-color var(--fast) var(--ease-out),
			color var(--fast) var(--ease-out);
	}

	.chip:hover {
		border-color: var(--control-border);
		color: var(--ink);
	}

	.chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 500;
	}

	.content {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 18rem;
		min-height: 0;
	}

	.gallery {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
		align-content: start;
		gap: var(--s-4) var(--s-3);
		padding: var(--s-4);
		overflow-y: auto;
	}

	.option {
		display: grid;
		gap: 2px;
		cursor: pointer;
	}

	.option input {
		position: absolute;
		opacity: 0;
	}

	.thumb,
	.preview {
		display: block;
		background: var(--paper);
		filter: var(--page-filter);
		box-shadow: var(--shadow-sheet);
		overflow: hidden;
	}

	.thumb {
		transition:
			box-shadow var(--medium) var(--ease-out),
			translate var(--medium) var(--ease-out);
	}

	/* The preview of the chosen template fades in when the choice changes. */
	@keyframes arrive {
		from {
			opacity: 0;
			translate: 0 4px;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.arrive {
			animation: arrive var(--medium) var(--ease-out);
		}
	}

	.thumb {
		margin-bottom: var(--s-1);
		border-radius: var(--radius);
	}

	.thumb img,
	.preview img {
		display: block;
		width: 100%;
		height: auto;
		aspect-ratio: 210 / 297;
		object-fit: cover;
		object-position: top;
	}

	.option:hover .thumb {
		box-shadow: var(--shadow-sheet-raised);
		translate: 0 -2px;
	}

	.option input:checked + .thumb {
		box-shadow:
			0 0 0 2px var(--accent),
			var(--shadow-sheet);
	}

	.option input:focus-visible + .thumb {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.option-name {
		font-size: var(--t-ui);
		font-weight: 500;
	}

	.option-category {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.no-match {
		grid-column: 1 / -1;
		display: grid;
		gap: var(--s-2);
		justify-items: start;
		color: var(--ink-2);
	}

	.details .arrive {
		display: grid;
		align-content: start;
		gap: var(--s-2);
	}

	.details {
		display: grid;
		align-content: start;
		gap: var(--s-2);
		padding: var(--s-4);
		border-left: 1px solid var(--rule);
		background: var(--ground);
		overflow-y: auto;
	}

	.details h3 {
		margin: var(--s-2) 0 0;
		font-size: var(--t-body);
		font-weight: 600;
	}

	.details p {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.details .files {
		font-size: var(--t-meta);
		overflow-wrap: anywhere;
	}

	footer {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3) var(--s-4);
		border-top: 1px solid var(--rule);
	}

	.create {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--s-3);
	}

	.create .field {
		flex: 1 1 12rem;
		max-width: 22rem;
	}

	.create .button {
		margin-left: auto;
		padding: 0 var(--s-4);
	}

	@media (max-width: 720px) {
		dialog {
			width: 100vw;
			height: 100dvh;
			border: 0;
			border-radius: 0;
		}

		.content {
			grid-template-columns: minmax(0, 1fr);
		}

		/* The gallery thumbnails already show the page; drop the separate preview. */
		.details {
			display: none;
		}
	}
</style>
