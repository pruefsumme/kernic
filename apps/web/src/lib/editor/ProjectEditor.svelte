<script lang="ts">
	import type { EditorView } from '@codemirror/view';
	import { onMount, tick, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppShell, { type RailItem } from '#lib/components/AppShell.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Menu from '#lib/components/Menu.svelte';
	import { helpDestination, projectsDestination } from '#lib/components/rail.ts';
	import { formatBytes } from '#lib/format.ts';
	import { createProjectApi, type Diagnostic, type TreeEntry } from './api.ts';
	import { revealPosition, type Heading } from './codemirror.ts';
	import FilesPanel from './FilesPanel.svelte';
	import FormatToolbar from './FormatToolbar.svelte';
	import IssuesPanel from './IssuesPanel.svelte';
	import OutlinePanel from './OutlinePanel.svelte';
	import PreviewPane from './PreviewPane.svelte';
	import { EditorSession, type Render } from './session.svelte.ts';
	import SourceEditor from './SourceEditor.svelte';

	let {
		userName,
		project,
		canWrite,
		entries,
		lastRender
	}: {
		userName: string;
		project: { id: string; name: string; entryPath: string; revision: number };
		canWrite: boolean;
		entries: TreeEntry[];
		lastRender: Render | null;
	} = $props();

	// This component is created once per project (the page keys it by project id).
	const session = untrack(
		() =>
			new EditorSession(createProjectApi(project.id), {
				canWrite,
				entries,
				entryPath: project.entryPath,
				revision: project.revision,
				render: lastRender
			})
	);

	type Panel = 'files' | 'outline' | 'issues';
	let openPanel = $state<Panel | null>(null);
	let pane = $state<'source' | 'preview'>('source');
	let view = $state<EditorView>();
	let headings = $state<Heading[]>([]);
	let cursor = $state<{ line: number; column: number } | null>(null);
	/** Share of the width given to the source pane, in percent. */
	let split = $state(50);
	let workspace: HTMLDivElement;

	const file = $derived(session.file);
	const fileDiagnostics = $derived(
		session.diagnostics.filter((diagnostic) => diagnostic.path === file?.path)
	);
	const isImage = $derived(file?.kind === 'binary' && file.contentType.startsWith('image/'));

	onMount(() => {
		// Wide screens start with the file list open; narrow ones keep the room for the text.
		if (window.matchMedia('(min-width: 1100px)').matches) openPanel = 'files';
		const stored = Number(localStorage.getItem('kernic.editor.split'));
		if (stored >= 20 && stored <= 80) split = stored;

		const requested = page.url.searchParams.get('file');
		const initial =
			requested && session.hasEntry(requested)
				? requested
				: session.hasEntry(session.entryPath)
					? session.entryPath
					: session.entries.find((entry) => entry.type === 'file')?.path;
		if (initial) void open(initial);
		session.requestCompile();

		return () => session.dispose();
	});

	$effect(() => {
		session.attachEditor(view ? () => view!.state.doc.toString() : null);
	});

	// Leaving for another screen must not drop edits typed within the autosave delay.
	beforeNavigate(({ shallow }) => {
		if (!shallow && session.saveState === 'unsaved') void session.save();
	});

	/** Opens a file and records it in the URL, so a reload or a shared link returns to it. */
	async function open(path: string): Promise<boolean> {
		const opened = await session.open(path);
		const current = session.file?.path;
		if (current && page.url.searchParams.get('file') !== current) {
			const url = new URL(page.url.href);
			url.searchParams.set('file', current);
			void goto(url, { shallow: true, replace: true });
		}
		if (opened) pane = 'source';
		return opened;
	}

	async function reveal(path: string, line: number, column = 0) {
		if (!(await open(path))) return;
		await tick();
		if (view) revealPosition(view, line, column);
	}

	function revealDiagnostic(diagnostic: Diagnostic) {
		if (diagnostic.path && diagnostic.line) {
			void reveal(diagnostic.path, diagnostic.line, diagnostic.column ?? 0);
		}
	}

	function toggle(next: Panel) {
		openPanel = openPanel === next ? null : next;
	}

	async function exportPdf() {
		const url = await session.exportPdf();
		if (url) location.assign(url);
		else if (session.errorCount > 0) openPanel = 'issues';
	}

	function resize(event: PointerEvent) {
		const handle = event.currentTarget as HTMLElement;
		handle.setPointerCapture(event.pointerId);
		const move = (moveEvent: PointerEvent) => {
			const bounds = workspace.getBoundingClientRect();
			split = Math.max(20, Math.min(80, ((moveEvent.clientX - bounds.left) / bounds.width) * 100));
		};
		const stop = () => {
			handle.removeEventListener('pointermove', move);
			localStorage.setItem('kernic.editor.split', String(Math.round(split)));
		};
		handle.addEventListener('pointermove', move);
		handle.addEventListener('pointerup', stop, { once: true });
		handle.addEventListener('pointercancel', stop, { once: true });
	}

	function resizeWithKeys(event: KeyboardEvent) {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		event.preventDefault();
		split = Math.max(20, Math.min(80, split + (event.key === 'ArrowLeft' ? -2 : 2)));
		localStorage.setItem('kernic.editor.split', String(Math.round(split)));
	}

	const destinations = $derived<RailItem[]>([
		projectsDestination(false),
		{
			id: 'files',
			label: 'Files',
			icon: 'files',
			active: openPanel === 'files',
			onclick: () => toggle('files')
		},
		{
			id: 'outline',
			label: 'Outline',
			icon: 'outline',
			active: openPanel === 'outline',
			onclick: () => toggle('outline')
		},
		{
			id: 'issues',
			label: 'Issues',
			icon: 'issues',
			active: openPanel === 'issues',
			onclick: () => toggle('issues'),
			badge: session.errorCount || session.warningCount,
			badgeTone: session.errorCount > 0 ? 'error' : 'warning'
		}
	]);
	const footer = $derived<RailItem[]>([
		{
			id: 'settings',
			label: 'Settings',
			icon: 'settings',
			href: `/projects/${project.id}/settings`
		},
		helpDestination
	]);
</script>

<svelte:window
	onkeydown={(event) => {
		// Save from anywhere on the screen, not only while the cursor is in the source.
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
			event.preventDefault();
			void session.save();
		}
	}}
	onbeforeunload={(event) => {
		// Ask before closing the tab while edits have not reached the server.
		if (session.saveState !== 'saved') event.preventDefault();
	}}
	ononline={() => {
		if (session.saveState === 'failed') void session.save();
		if (session.compile.status === 'unavailable') session.requestCompile();
	}}
/>

<AppShell {userName} {destinations} {footer} scroll={false}>
	{#snippet menus()}
		<Menu>
			{#snippet trigger()}File{/snippet}
			<button role="menuitem" disabled={session.exporting} onclick={exportPdf}>Export PDF</button>
			<a role="menuitem" href={session.api.archiveUrl} download>Download all files (ZIP)</a>
			<hr />
			<a role="menuitem" href="/projects/{project.id}/settings">Project settings</a>
			<a role="menuitem" href="/">All projects</a>
		</Menu>
	{/snippet}

	{#snippet title()}
		<span class="project-name">{project.name}</span>
		{#if file}
			<span class="file-path">{file.path}</span>
		{/if}
		{#if !canWrite}
			<span class="save">Read only</span>
		{:else if file?.kind === 'text'}
			{#if session.saveState === 'saved'}
				<span class="save"><Icon name="check" size={14} /> Saved</span>
			{:else if session.saveState === 'saving'}
				<span class="save">Saving…</span>
			{:else if session.saveState === 'unsaved'}
				<span class="save"><span class="dot"></span> Unsaved changes</span>
			{:else if session.saveState === 'failed'}
				<span class="save bad" title={session.saveError}>
					Not saved
					<button class="button small" type="button" onclick={() => session.save()}>Retry</button>
				</span>
			{:else}
				<span class="save bad">Conflict</span>
			{/if}
		{/if}
	{/snippet}

	{#snippet actions()}
		<Menu align="end" triggerClass="button primary small">
			{#snippet trigger()}
				{session.exporting ? 'Exporting…' : 'Export'}
				<Icon name="chevronDown" size={14} />
			{/snippet}
			<button role="menuitem" disabled={session.exporting} onclick={exportPdf}>
				<Icon name="download" size={16} /> PDF
			</button>
			<a role="menuitem" href={session.api.archiveUrl} download>
				<Icon name="download" size={16} /> All files (ZIP)
			</a>
		</Menu>
	{/snippet}

	{#snippet panel()}
		{#if openPanel === 'files'}
			<FilesPanel {session} onopen={(path) => void open(path)} onclose={() => (openPanel = null)} />
		{:else if openPanel === 'outline'}
			<OutlinePanel
				{headings}
				fileName={file?.path ?? null}
				available={file?.kind === 'text'}
				onreveal={(line) => file && void reveal(file.path, line)}
				onclose={() => (openPanel = null)}
			/>
		{:else if openPanel === 'issues'}
			<IssuesPanel {session} onreveal={revealDiagnostic} onclose={() => (openPanel = null)} />
		{/if}
	{/snippet}

	<div class="frame">
		{#if session.exportError}
			<div class="banner" role="alert">
				<span>{session.exportError}</span>
				<button class="button small" type="button" onclick={() => (session.exportError = null)}>
					Dismiss
				</button>
			</div>
		{/if}

		<div class="tabs" role="group" aria-label="Show">
			<button type="button" aria-pressed={pane === 'source'} onclick={() => (pane = 'source')}>
				Source
			</button>
			<button
				type="button"
				aria-pressed={pane === 'preview'}
				aria-label={session.errorCount > 0 ? `Preview (${session.errorCount} errors)` : undefined}
				onclick={() => (pane = 'preview')}
			>
				Preview
				{#if session.errorCount > 0}<span class="tab-flag">{session.errorCount}</span>{/if}
			</button>
		</div>

		<div class="workspace" bind:this={workspace} style:--split="{split}%" data-pane={pane}>
			<section class="source" aria-label="Source">
				<FormatToolbar {view} disabled={!canWrite || file?.kind !== 'text'} {cursor} />

				{#if session.saveState === 'conflict'}
					<div class="banner" role="alert">
						<span>
							<strong>{file?.path}</strong> was changed somewhere else after you opened it. Your edits
							are not saved yet.
						</span>
						<span class="banner-actions">
							<button class="button small" type="button" onclick={() => session.reloadFromServer()}>
								Discard mine, load theirs
							</button>
							<button
								class="button small"
								type="button"
								onclick={() => session.overwriteServerVersion()}
							>
								Keep mine, overwrite
							</button>
						</span>
					</div>
				{:else if session.saveState === 'failed'}
					<div class="banner" role="alert">
						<span>
							Your changes are not saved. {session.saveError} Keep this tab open; you can keep writing.
						</span>
						<button class="button small" type="button" onclick={() => session.save()}>
							Try again
						</button>
					</div>
				{/if}

				<div class="document">
					{#if !file}
						<div class="notice">
							<h2>No file open</h2>
							<p>
								{#if session.entries.some((entry) => entry.type === 'file')}
									Choose a file under Files to edit it.
								{:else}
									This project has no files yet. Create one under Files to start writing.
								{/if}
							</p>
							<button class="button" type="button" onclick={() => (openPanel = 'files')}
								>Show files</button
							>
						</div>
					{:else if file.kind === 'loading'}
						<p class="loading">Opening {file.path}…</p>
					{:else if file.kind === 'unavailable'}
						<div class="notice">
							<h2>{file.path} could not be opened</h2>
							<p>{file.message}</p>
							<button class="button" type="button" onclick={() => void open(file.path)}>
								Try again
							</button>
						</div>
					{:else if file.kind === 'binary'}
						<div class="notice asset">
							{#if isImage}
								<img src={session.api.fileUrl(file.path)} alt={file.path} />
							{/if}
							<h2>{file.path}</h2>
							<p>
								{isImage ? 'Image' : 'This file cannot be edited as text'} · {formatBytes(
									file.size
								)}
							</p>
							<a class="button" href={session.api.fileUrl(file.path)} download>
								<Icon name="download" size={16} /> Download
							</a>
						</div>
					{:else}
						{#key session.loadCount}
							<SourceEditor
								bind:view
								text={file.text}
								readOnly={!canWrite}
								diagnostics={fileDiagnostics}
								onchange={() => session.noteEdit()}
								onsave={() => void session.save()}
								oncursor={(line, column) => (cursor = { line, column })}
								onheadings={(next) => (headings = next)}
							/>
						{/key}
					{/if}
				</div>
			</section>

			<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
			<div
				class="divider"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize source and preview"
				aria-valuenow={Math.round(split)}
				aria-valuemin={20}
				aria-valuemax={80}
				tabindex="0"
				onpointerdown={resize}
				onkeydown={resizeWithKeys}
			></div>

			<div class="preview">
				<PreviewPane {session} onshowissues={() => (openPanel = 'issues')} />
			</div>
		</div>
	</div>
</AppShell>

<style>
	.project-name {
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-path {
		overflow: hidden;
		color: var(--ink-2);
		font-family: var(--font-mono);
		font-size: var(--t-meta);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.save {
		display: inline-flex;
		align-items: center;
		flex: none;
		gap: var(--s-1);
		color: var(--ink-2);
		font-size: var(--t-meta);
		white-space: nowrap;
	}

	.save.bad {
		gap: var(--s-2);
		color: var(--error);
		font-weight: 600;
	}

	.dot {
		width: 0.5rem;
		height: 0.5rem;
		border-radius: 50%;
		background: var(--ink-3);
	}

	.frame {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.workspace {
		display: grid;
		grid-template-columns: minmax(0, var(--split)) 5px minmax(0, 1fr);
		flex: 1;
		min-height: 0;
	}

	.source {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		background: var(--surface);
	}

	.document {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}

	.preview {
		min-width: 0;
		min-height: 0;
	}

	.divider {
		border-left: 1px solid var(--rule);
		background: var(--surface);
		cursor: col-resize;
		touch-action: none;
	}

	.divider:hover,
	.divider:focus-visible {
		background: var(--accent-soft);
		outline: none;
		border-left-color: var(--accent);
	}

	.banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2) var(--s-3);
		padding: var(--s-2) var(--s-3);
		border-bottom: 1px solid var(--rule);
		border-left: 3px solid var(--error);
		background: var(--error-soft);
		font-size: var(--t-ui);
	}

	.banner-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	.notice {
		display: grid;
		gap: var(--s-2);
		justify-items: start;
		max-width: 30rem;
		padding: var(--s-6) var(--s-5);
	}

	.notice p,
	.loading {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.notice h2 {
		overflow-wrap: anywhere;
	}

	.loading {
		padding: var(--s-5);
	}

	.asset img {
		max-width: 100%;
		max-height: 50vh;
		margin-bottom: var(--s-2);
		border: 1px solid var(--rule);
		background: var(--surface);
	}

	.tabs {
		display: none;
	}

	/* Narrow: one pane at a time, chosen with tabs, instead of two squeezed panes. */
	@media (max-width: 900px) {
		.tabs {
			display: flex;
			border-bottom: 1px solid var(--rule);
			background: var(--ground);
		}

		.tabs button {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: var(--s-2);
			flex: 1;
			min-height: 2.5rem;
			border: 0;
			border-bottom: 2px solid transparent;
			background: none;
			color: var(--ink-2);
			font: inherit;
			font-size: var(--t-ui);
			font-weight: 500;
			cursor: pointer;
		}

		.tabs button[aria-pressed='true'] {
			border-bottom-color: var(--accent);
			color: var(--accent);
		}

		.tab-flag {
			min-width: 1.1rem;
			padding: 0 0.3rem;
			border-radius: 1rem;
			background: var(--error);
			color: oklch(99% 0 0);
			font-size: 0.6875rem;
			line-height: 1.1rem;
		}

		.workspace {
			grid-template-columns: minmax(0, 1fr);
		}

		.divider,
		.workspace[data-pane='source'] .preview,
		.workspace[data-pane='preview'] .source {
			display: none;
		}

		.file-path {
			display: none;
		}
	}
</style>
