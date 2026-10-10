<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import Icon from '#lib/components/Icon.svelte';
	import Menu from '#lib/components/Menu.svelte';
	import PromptDialog from '#lib/components/PromptDialog.svelte';
	import type { TreeEntry, UploadResult } from './api.ts';
	import type { EditorSession } from './session.svelte.ts';
	import SidePanel from './SidePanel.svelte';

	let {
		session,
		onopen,
		onclose
	}: { session: EditorSession; onopen: (path: string) => void; onclose: () => void } = $props();

	interface Row {
		entry: TreeEntry;
		name: string;
		depth: number;
	}

	const collapsed = new SvelteSet<string>();
	let uploadInput: HTMLInputElement;
	let uploadDirectory = '';
	let uploadResults = $state<UploadResult[] | null>(null);
	let uploadError = $state<string | null>(null);

	type Prompt =
		| { kind: 'new-file'; directory: string }
		| { kind: 'new-folder'; directory: string }
		| { kind: 'rename'; entry: TreeEntry }
		| { kind: 'delete'; entry: TreeEntry };
	let prompt = $state<Prompt | null>(null);
	let promptOpen = $state(false);

	/** Visible rows: folders before files at each level, collapsed folders skipped. */
	const rows = $derived.by(() => {
		const parentOf = (entry: TreeEntry) =>
			entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
		const children = Object.groupBy(session.entries, parentOf);

		const result: Row[] = [];
		const walk = (parent: string, depth: number) => {
			const entries = (children[parent] ?? []).toSorted(
				(a, b) =>
					Number(b.type === 'directory') - Number(a.type === 'directory') ||
					a.path.localeCompare(b.path, undefined, { numeric: true })
			);
			for (const entry of entries) {
				result.push({ entry, name: entry.path.slice(parent ? parent.length + 1 : 0), depth });
				if (entry.type === 'directory' && !collapsed.has(entry.path)) walk(entry.path, depth + 1);
			}
		};
		walk('', 0);
		return result;
	});

	function toggle(path: string) {
		if (!collapsed.delete(path)) collapsed.add(path);
	}

	function ask(next: Prompt) {
		prompt = next;
		promptOpen = true;
	}

	function chooseFiles(directory: string) {
		uploadDirectory = directory;
		uploadInput.click();
	}

	async function upload() {
		const files = [...(uploadInput.files ?? [])];
		uploadInput.value = '';
		if (files.length === 0) return;
		uploadError = null;
		uploadResults = null;
		try {
			uploadResults = await session.upload(uploadDirectory, files);
		} catch (error) {
			uploadError = error instanceof Error ? error.message : 'The upload failed.';
		}
	}

	const inDirectory = (directory: string, name: string) =>
		directory ? `${directory}/${name}` : name;

	async function submitPrompt(value: string) {
		const request = prompt;
		if (!request) return;
		if (request.kind === 'new-file') {
			await session.createFile(inDirectory(request.directory, value));
			onopen(inDirectory(request.directory, value));
		} else if (request.kind === 'new-folder') {
			await session.createFolder(inDirectory(request.directory, value));
		} else {
			if (request.kind === 'rename') await session.move(request.entry.path, value);
			else await session.remove(request.entry.path);
			// The open file may have moved or been replaced; keep the address bar in step.
			if (session.file) onopen(session.file.path);
		}
	}

	const stored = $derived(uploadResults?.filter((result) => result.stored) ?? []);
	const skipped = $derived(uploadResults?.filter((result) => !result.stored) ?? []);
</script>

<SidePanel title="Files" {onclose}>
	{#if session.canWrite}
		<div class="toolbar">
			<button
				class="button small"
				type="button"
				onclick={() => ask({ kind: 'new-file', directory: '' })}
			>
				<Icon name="plus" size={14} /> File
			</button>
			<button
				class="button small"
				type="button"
				onclick={() => ask({ kind: 'new-folder', directory: '' })}
			>
				<Icon name="plus" size={14} /> Folder
			</button>
			<button class="button small" type="button" onclick={() => chooseFiles('')}>
				<Icon name="upload" size={14} /> Upload
			</button>
		</div>
	{/if}

	{#if uploadError}
		<p class="report error" role="alert">{uploadError}</p>
	{:else if uploadResults}
		<div class="report" class:error={skipped.length > 0} role="status">
			{#if stored.length > 0}
				<p>{stored.length === 1 ? '1 file uploaded.' : `${stored.length} files uploaded.`}</p>
			{/if}
			{#each skipped as result (result.name)}
				<p><strong>{result.name}</strong> was not uploaded. {result.message}</p>
			{/each}
			<button class="button quiet small" type="button" onclick={() => (uploadResults = null)}>
				Dismiss
			</button>
		</div>
	{/if}

	{#if rows.length === 0}
		<p class="empty">
			This project has no files.
			{#if session.canWrite}Create a file named <span class="file-name">main.typ</span> to start writing.{/if}
		</p>
	{:else}
		<ul class="tree">
			{#each rows as { entry, name, depth } (entry.path)}
				{@const isOpen = session.file?.path === entry.path}
				<li class:active={isOpen} style:--depth={depth}>
					{#if entry.type === 'directory'}
						<button
							class="row"
							type="button"
							aria-expanded={!collapsed.has(entry.path)}
							onclick={() => toggle(entry.path)}
						>
							<span class="chevron" class:open={!collapsed.has(entry.path)}>
								<Icon name="chevronRight" size={14} />
							</span>
							<Icon name="folder" size={16} />
							<span class="name">{name}</span>
						</button>
					{:else}
						<button
							class="row"
							type="button"
							aria-current={isOpen ? 'true' : undefined}
							onclick={() => onopen(entry.path)}
						>
							<span class="chevron"></span>
							<Icon
								name={/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name) ? 'image' : 'file'}
								size={16}
							/>
							<span class="name">{name}</span>
							{#if entry.path === session.entryPath}
								<span class="tag" title="This file is compiled into the document">main</span>
							{/if}
						</button>
					{/if}

					<Menu label="Actions for {name}" align="end" triggerClass="more">
						{#snippet trigger()}<Icon name="more" size={16} />{/snippet}
						{#if entry.type === 'directory' && session.canWrite}
							<button
								role="menuitem"
								onclick={() => ask({ kind: 'new-file', directory: entry.path })}
							>
								New file here
							</button>
							<button
								role="menuitem"
								onclick={() => ask({ kind: 'new-folder', directory: entry.path })}
							>
								New folder here
							</button>
							<button role="menuitem" onclick={() => chooseFiles(entry.path)}>Upload here</button>
							<hr />
						{/if}
						{#if entry.type === 'file'}
							<a role="menuitem" href={session.api.fileUrl(entry.path)} download={name}>Download</a>
						{/if}
						{#if session.canWrite}
							<button role="menuitem" onclick={() => ask({ kind: 'rename', entry })}>
								Rename or move
							</button>
							<button role="menuitem" class="danger" onclick={() => ask({ kind: 'delete', entry })}>
								Delete
							</button>
						{/if}
					</Menu>
				</li>
			{/each}
		</ul>
	{/if}

	<input bind:this={uploadInput} type="file" multiple hidden onchange={upload} />
</SidePanel>

{#if prompt?.kind === 'new-file'}
	<PromptDialog
		bind:open={promptOpen}
		title="New file"
		description={prompt.directory ? `In ${prompt.directory}/` : undefined}
		label="File name"
		initialValue="untitled.typ"
		confirmLabel="Create file"
		onsubmit={submitPrompt}
	/>
{:else if prompt?.kind === 'new-folder'}
	<PromptDialog
		bind:open={promptOpen}
		title="New folder"
		description={prompt.directory ? `In ${prompt.directory}/` : undefined}
		label="Folder name"
		confirmLabel="Create folder"
		onsubmit={submitPrompt}
	/>
{:else if prompt?.kind === 'rename'}
	<PromptDialog
		bind:open={promptOpen}
		title="Rename or move"
		description="Use “/” to move it into a folder. Other files that import it are not updated."
		label="Path"
		initialValue={prompt.entry.path}
		confirmLabel="Rename"
		onsubmit={submitPrompt}
	/>
{:else if prompt?.kind === 'delete'}
	<PromptDialog
		bind:open={promptOpen}
		title={prompt.entry.type === 'directory' ? 'Delete folder?' : 'Delete file?'}
		description={prompt.entry.type === 'directory'
			? `“${prompt.entry.path}” and everything inside it will be deleted. This cannot be undone.`
			: `“${prompt.entry.path}” will be deleted. This cannot be undone.`}
		confirmLabel="Delete"
		danger
		onsubmit={submitPrompt}
	/>
{/if}

<style>
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-1);
		padding: 0 var(--s-3) var(--s-2);
	}

	.report {
		display: grid;
		gap: var(--s-1);
		justify-items: start;
		margin: 0 var(--s-3) var(--s-2);
		padding: var(--s-2);
		border-left: 3px solid var(--control-border);
		background: var(--surface);
		font-size: var(--t-meta);
		overflow-wrap: anywhere;
	}

	.report.error {
		border-left-color: var(--error);
	}

	.empty {
		padding: var(--s-2) var(--s-3);
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.tree {
		margin: 0;
		padding: 0 var(--s-1) var(--s-4);
		list-style: none;
	}

	li {
		display: flex;
		align-items: center;
		border-radius: var(--radius);
	}

	li {
		transition: background-color var(--fast) var(--ease-out);
	}

	li:hover,
	li:focus-within {
		background: var(--sunken);
	}

	li.active {
		background: var(--accent-soft);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		flex: 1;
		min-width: 0;
		min-height: 1.875rem;
		padding: 0 var(--s-1) 0 calc(var(--s-1) + var(--depth) * 0.875rem);
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: var(--t-ui);
		text-align: left;
		cursor: pointer;
	}

	li.active .row {
		color: var(--accent);
		font-weight: 500;
	}

	.chevron {
		display: grid;
		flex: none;
		width: 0.875rem;
		color: var(--ink-3);
	}

	.chevron {
		transition: rotate var(--fast) var(--ease-out);
	}

	.chevron.open {
		rotate: 90deg;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tag {
		flex: none;
		margin-left: auto;
		padding: 0 0.375rem;
		border: 1px solid currentColor;
		border-radius: 1rem;
		color: var(--ink-2);
		font-size: 0.6875rem;
		font-weight: 500;
		line-height: 1.5;
	}

	li :global(.more) {
		display: grid;
		place-items: center;
		flex: none;
		width: 1.75rem;
		height: 1.75rem;
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--ink-2);
		cursor: pointer;
		opacity: 0;
		transition:
			opacity var(--fast) var(--ease-out),
			background-color var(--fast) var(--ease-out);
	}

	li:hover :global(.more),
	li:focus-within :global(.more),
	li :global(.more[aria-expanded='true']) {
		opacity: 1;
	}

	li :global(.more:hover) {
		background: var(--rule);
		color: var(--ink);
	}

	/* Touch screens have no hover: keep the row actions visible. */
	@media (hover: none) {
		li :global(.more) {
			opacity: 1;
		}
	}
</style>
