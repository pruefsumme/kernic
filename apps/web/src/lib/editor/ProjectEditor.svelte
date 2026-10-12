<script lang="ts">
	import type { EditorView } from '@codemirror/view';
	import { onMount, tick, untrack } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppShell, { type RailItem } from '#lib/components/AppShell.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Menu from '#lib/components/Menu.svelte';
	import QuickOpen, { type QuickItem } from '#lib/components/QuickOpen.svelte';
	import { helpDestination, projectsDestination } from '#lib/components/rail.ts';
	import { formatBytes } from '#lib/format.ts';
	import { formatDocument, jumpToDefinition, renameSymbol } from '@codemirror/lsp-client';
	import { createProjectApi, type Diagnostic, type TreeEntry } from './api.ts';
	import { Assistance } from './assistance.svelte.ts';
	import { revealPosition, type Heading } from './codemirror.ts';
	import FilesPanel from './FilesPanel.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import { insertImages } from './formatting.ts';
	import FormatToolbar from './FormatToolbar.svelte';
	import HistoryPanel from './HistoryPanel.svelte';
	import IssuesPanel from './IssuesPanel.svelte';
	import { placesNearby } from './jump.ts';
	import OutlinePanel from './OutlinePanel.svelte';
	import PreviewPane from './PreviewPane.svelte';
	import SearchPanel from './SearchPanel.svelte';
	import { EditorSession, type Render } from './session.svelte.ts';
	import SourceEditor from './SourceEditor.svelte';

	let {
		project,
		canWrite,
		entries,
		lastRender
	}: {
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

	// Completion, documentation and navigation from the language server, when there is one.
	const assistance = untrack(
		() =>
			new Assistance(session.api, async (path) => {
				if (!(await open(path))) return null;
				await tick();
				return view ?? null;
			})
	);

	type Panel = 'files' | 'search' | 'outline' | 'issues' | 'history';
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
	const assisted = $derived(file?.kind === 'text' ? assistance.extensionFor(file.path) : null);
	// The language server works on a copy of the project, which follows what is saved.
	$effect(() => {
		void session.revision;
		untrack(() => assistance.projectChanged());
	});

	let preview = $state<PreviewPane>();
	/** A short remark after a jump that led nowhere; it clears itself. */
	let jumpNote = $state<string | null>(null);
	let jumpNoteTimer: ReturnType<typeof setTimeout> | undefined;
	function remark(text: string) {
		jumpNote = text;
		clearTimeout(jumpNoteTimer);
		jumpNoteTimer = setTimeout(() => (jumpNote = null), 3500);
	}

	/** A click on a page: opens the place in the source that produced what is there. */
	async function goToSource(page: number, x: number, y: number) {
		const source = await assistance.sourceOf(page, x, y);
		if (!source) {
			remark('Nothing to go to at that spot');
			return;
		}
		jumpNote = null;
		await reveal(source.path, source.line + 1, source.character);
	}

	/** The place last shown in the preview, to go on to its next appearance when asked again. */
	let located: { key: string; index: number } | null = null;
	/** One question at a time: a key held down asks once. */
	let locating = false;

	/**
	 * Scrolls the preview to where the cursor's place in the source is printed.
	 * A heading is also printed in the table of contents, a caption in a list of
	 * figures: the appearance nearest to what the preview shows comes first, and
	 * asking again for the same place goes on to the next.
	 */
	async function showInPreview() {
		if (!file || !cursor || locating) return;
		locating = true;
		try {
			await locate(file.path, cursor);
		} finally {
			locating = false;
		}
	}

	async function locate(path: string, cursor: { line: number; column: number }) {
		const key = `${path}:${cursor.line}:${cursor.column}`;
		const at = { line: cursor.line - 1, character: cursor.column - 1 };
		const text = view?.state.doc;
		const lineAt = (line: number) => (text && line < text.lines ? text.line(line + 1).text : '');
		const places = await assistance.pageOf(path, at, placesNearby(lineAt, at));
		if (places.length === 0 || !preview) {
			located = null;
			remark('This place is not on a page');
			return;
		}
		pane = 'preview';
		await tick();
		const index =
			located?.key === key ? (located.index + 1) % places.length : preview.nearest(places);
		located = { key, index };
		const place = places[index]!;
		preview.show(place.page, place.x, place.y);
		if (places.length > 1) {
			remark(`Place ${index + 1} of ${places.length} · press again for the next`);
		} else {
			jumpNote = null;
		}
	}

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
		// Only used for completion, so the editor does not wait for it or mind if it fails.
		void assistance.connect();
		void session.api.fonts().then(
			(families) => (session.fonts = families),
			() => {}
		);

		// Files may be dropped anywhere on this screen, the file list included.
		// Listening on the window, before the editor does, also keeps the browser
		// from opening a dropped file in place of the app.
		const dragEvents = { dragenter: dragEnter, dragleave: dragLeave, dragover: dragOver, drop };
		for (const [type, listener] of Object.entries(dragEvents)) {
			window.addEventListener(type, listener as EventListener, true);
		}

		return () => {
			for (const [type, listener] of Object.entries(dragEvents)) {
				window.removeEventListener(type, listener as EventListener, true);
			}
			assistance.dispose();
			session.dispose();
		};
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

	const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg)$/i;
	/** Nested elements under the pointer while files are dragged over the editor. */
	let dragDepth = $state(0);

	const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
	/** Whether images can be placed into the open file: a Typst source that may be edited. */
	const acceptsImages = () => canWrite && file?.kind === 'text' && /\.typ$/i.test(file.path);

	function dragEnter(event: DragEvent) {
		if (carriesFiles(event)) dragDepth++;
	}

	function dragLeave(event: DragEvent) {
		if (carriesFiles(event)) dragDepth = Math.max(0, dragDepth - 1);
	}

	function dragOver(event: DragEvent) {
		if (!carriesFiles(event)) return;
		// Without this the browser would open the dropped file in place of the app.
		event.preventDefault();
		event.dataTransfer!.dropEffect = canWrite ? 'copy' : 'none';
	}

	function drop(event: DragEvent) {
		if (!carriesFiles(event)) return;
		event.preventDefault();
		// The editor would otherwise insert the content of dropped text files.
		event.stopPropagation();
		dragDepth = 0;
		if (!canWrite) return;

		const files = [...event.dataTransfer!.items]
			.filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
			.map((item) => item.getAsFile())
			.filter((dropped): dropped is File => dropped !== null);
		const onSource = event.target instanceof Element && event.target.closest('.source') !== null;
		void addFiles(files, onSource);
	}

	function paste(event: ClipboardEvent) {
		const clipboard = event.clipboardData;
		// Text copied from an office program often comes with a picture of itself; text wins.
		if (!clipboard || clipboard.types.includes('text/plain') || !acceptsImages()) return;
		const images = [...clipboard.files].filter((pasted) => pasted.type.startsWith('image/'));
		if (images.length === 0) return;
		event.preventDefault();
		event.stopPropagation();

		// A screenshot arrives as "image.png" every time; give each one its own name.
		const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
		const named = images.map((image, index) =>
			image.name === 'image.png'
				? new File([image], `pasted-${stamp}${index > 0 ? `-${index + 1}` : ''}.png`, {
						type: image.type
					})
				: image
		);
		void addFiles(named, true);
	}

	/**
	 * Uploads files that were dropped or pasted. Images placed on a Typst source
	 * go beside that file and are inserted at the cursor; everything else goes to
	 * the top folder of the project.
	 */
	async function addFiles(files: File[], onSource: boolean) {
		if (files.length === 0) return;
		const target = file;
		const place =
			onSource && acceptsImages() && files.every((added) => IMAGE_FILE.test(added.name));
		const directory = place && target ? target.path.split('/').slice(0, -1).join('/') : '';

		const stored = await session.upload(directory, files);
		if (place && stored.length > 0 && view && session.file?.path === target?.path) {
			insertImages(
				view,
				stored.map((result) => result.name)
			);
		}
		// Show where the files went, and any that were refused, unless all of them
		// are now visible in the source.
		if (place && stored.length === files.length) session.uploadReport = null;
		else openPanel = 'files';
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
			id: 'search',
			label: 'Search',
			icon: 'search',
			active: openPanel === 'search',
			onclick: () => toggle('search'),
			// On a phone it is under File, Search in all files.
			wideOnly: true
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
		},
		{
			id: 'history',
			label: 'History',
			icon: 'history',
			active: openPanel === 'history',
			onclick: () => toggle('history')
		}
	]);
	let quickOpen = $state(false);
	let exportOptions = $state(false);
	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	const quickOpenKeys = isMac ? '⌘K' : 'Ctrl+K';

	/** Opens a file from the palette and puts the cursor into it. */
	async function jumpTo(path: string) {
		if (!(await open(path))) return;
		await tick();
		view?.focus();
	}

	/** Everything the palette can reach: files, headings of the open file, and actions. */
	const quickItems = $derived.by<QuickItem[]>(() => {
		const show = (next: Panel) => () => (openPanel = next);
		const files = session.entries
			.filter((entry) => entry.type === 'file')
			.map<QuickItem>((entry) => ({
				id: `file:${entry.path}`,
				label: entry.path,
				kind: entry.path === file?.path ? 'Open file' : 'File',
				icon: /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(entry.path) ? 'image' : 'file',
				run: () => void jumpTo(entry.path)
			}));
		const current = file?.kind === 'text' ? file.path : null;
		const sections = current
			? headings.map<QuickItem>((heading) => ({
					id: `heading:${heading.line}`,
					label: heading.text,
					kind: `Heading, line ${heading.line}`,
					icon: 'outline',
					run: () => void reveal(current, heading.line)
				}))
			: [];
		const actions: QuickItem[] = [
			{
				id: 'export',
				label: 'Export PDF',
				kind: 'Action',
				icon: 'download',
				run: () => void exportPdf()
			},
			{
				id: 'export-options',
				label: 'Export PDF with options (PDF/A, pages)',
				kind: 'Action',
				icon: 'download',
				run: () => (exportOptions = true)
			},
			{
				id: 'zip',
				label: 'Download all files (ZIP)',
				kind: 'Action',
				icon: 'download',
				run: () => location.assign(session.api.archiveUrl)
			},
			{
				id: 'search',
				label: 'Search in all files',
				kind: 'Action',
				icon: 'search',
				run: show('search')
			},
			{ id: 'files', label: 'Show files', kind: 'Action', icon: 'files', run: show('files') },
			{
				id: 'outline',
				label: 'Show outline',
				kind: 'Action',
				icon: 'outline',
				run: show('outline')
			},
			{ id: 'issues', label: 'Show issues', kind: 'Action', icon: 'issues', run: show('issues') },
			{
				id: 'history',
				label: 'Show history and checkpoints',
				kind: 'Action',
				icon: 'history',
				run: show('history')
			},
			{
				id: 'settings',
				label: 'Project settings',
				kind: 'Action',
				icon: 'settings',
				run: () => void goto(`/projects/${project.id}/settings`)
			},
			{
				id: 'projects',
				label: 'All projects',
				kind: 'Action',
				icon: 'projects',
				run: () => void goto('/')
			}
		];
		// Offered while the language server assists the open file.
		const editor = view;
		const assistedActions: QuickItem[] =
			assisted && editor
				? [
						{
							id: 'format',
							label: 'Format this file',
							kind: 'Action',
							icon: 'code',
							run: () => void formatDocument(editor)
						},
						{
							id: 'rename',
							label: 'Rename the symbol at the cursor',
							kind: 'Action',
							icon: 'code',
							run: () => void renameSymbol(editor)
						},
						...(assistance.canJump
							? [
									{
										id: 'locate',
										label: 'Show the place of the cursor in the preview',
										kind: 'Action',
										icon: 'locate' as const,
										run: () => void showInPreview()
									}
								]
							: []),
						{
							id: 'definition',
							label: 'Go to the definition of the symbol at the cursor',
							kind: 'Action',
							icon: 'code',
							run: () => void jumpToDefinition(editor)
						}
					]
				: [];
		return [...files, ...sections, ...assistedActions, ...actions];
	});

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
		if (
			(event.ctrlKey || event.metaKey) &&
			!event.shiftKey &&
			event.key.toLowerCase() === 'j' &&
			assisted &&
			assistance.canJump
		) {
			event.preventDefault();
			void showInPreview();
		}
		if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
			event.preventDefault();
			openPanel = 'search';
		}
		if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			quickOpen = !quickOpen;
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

<QuickOpen
	bind:open={quickOpen}
	items={quickItems}
	label="Go to a file or heading, or run an action"
/>

<ExportDialog
	bind:open={exportOptions}
	{session}
	projectId={project.id}
	ondownload={(url) => location.assign(url)}
/>

<AppShell {destinations} {footer} scroll={false}>
	{#snippet menus()}
		<Menu>
			{#snippet trigger()}File{/snippet}
			<button role="menuitem" onclick={() => (quickOpen = true)}>
				Go to file or heading… <span class="keys">{quickOpenKeys}</span>
			</button>
			<button role="menuitem" onclick={() => (openPanel = 'search')}>
				Search in all files… <span class="keys">{isMac ? '⇧⌘F' : 'Ctrl+Shift+F'}</span>
			</button>
			<hr />
			<button role="menuitem" disabled={session.exporting} onclick={exportPdf}>Export PDF</button>
			<button role="menuitem" onclick={() => (exportOptions = true)}>
				Export PDF with options…
			</button>
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
				<span class="save settled"><Icon name="check" size={14} /> Saved</span>
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
			<button role="menuitem" onclick={() => (exportOptions = true)}>
				<Icon name="settings" size={16} /> PDF with options…
			</button>
			<a role="menuitem" href={session.api.archiveUrl} download>
				<Icon name="download" size={16} /> All files (ZIP)
			</a>
		</Menu>
	{/snippet}

	{#snippet panel()}
		{#if openPanel === 'files'}
			<FilesPanel {session} onopen={(path) => void open(path)} onclose={() => (openPanel = null)} />
		{:else if openPanel === 'search'}
			<SearchPanel
				{session}
				onreveal={(path, line, column) => void reveal(path, line, column)}
				onclose={() => (openPanel = null)}
			/>
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
		{:else if openPanel === 'history'}
			<HistoryPanel {session} onclose={() => (openPanel = null)} />
		{/if}
	{/snippet}

	<div class="frame" onpastecapture={paste}>
		{#if dragDepth > 0}
			<div class="drop" class:refused={!canWrite} aria-hidden="true">
				<div class="drop-card">
					<Icon name="upload" size={22} />
					{#if canWrite}
						<strong>Drop to add to “{project.name}”</strong>
						<span>
							{acceptsImages()
								? 'Images dropped on the source are also inserted at the cursor.'
								: 'The files go to the top folder of the project.'}
						</span>
					{:else}
						<strong>This project is read-only</strong>
						<span>You cannot add files to it.</span>
					{/if}
				</div>
			</div>
		{/if}
		{#if session.uploading > 0}
			<p class="pill" role="status">
				Uploading {session.uploading === 1 ? '1 file' : `${session.uploading} files`}…
			</p>
		{:else if jumpNote}
			<p class="pill" role="status">{jumpNote}</p>
		{/if}

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
				<FormatToolbar
					{view}
					disabled={!canWrite || file?.kind !== 'text'}
					{cursor}
					note={assistance.status === 'unavailable' && file?.kind === 'text'
						? { label: 'No assistance', detail: assistance.reason ?? '' }
						: null}
				/>

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
								fonts={assisted ? [] : session.fonts}
								assistance={assisted}
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
				<PreviewPane
					bind:this={preview}
					{session}
					onshowissues={() => (openPanel = 'issues')}
					onpick={assistance.canJump ? goToSource : null}
					onlocate={assisted && assistance.canJump ? () => void showInPreview() : null}
				/>
			</div>
		</div>
	</div>
</AppShell>

<style>
	.keys {
		margin-left: auto;
		padding-left: var(--s-4);
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.project-name {
		overflow: hidden;
		font-weight: 600;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-path {
		overflow: hidden;
		color: var(--ink-2);
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

	.drop {
		position: absolute;
		z-index: 5;
		inset: 0;
		display: grid;
		place-items: center;
		padding: var(--s-4);
		border: 2px dashed var(--accent);
		background: color-mix(in oklch, var(--accent-soft) 70%, transparent);
		pointer-events: none;
	}

	.drop.refused {
		border-color: var(--control-border);
		background: color-mix(in oklch, var(--ground) 90%, transparent);
	}

	.drop-card {
		display: grid;
		justify-items: center;
		gap: var(--s-1);
		max-width: 26rem;
		padding: var(--s-5) var(--s-6);
		border-radius: var(--radius-float);
		background: var(--surface);
		box-shadow: var(--shadow-float);
		color: var(--accent);
		text-align: center;
	}

	.drop.refused .drop-card {
		color: var(--ink-2);
	}

	.drop-card strong {
		color: var(--ink);
		font-size: var(--t-heading);
	}

	.drop-card span {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.pill {
		position: absolute;
		z-index: 6;
		bottom: var(--s-4);
		left: 50%;
		margin: 0;
		padding: var(--s-2) var(--s-4);
		border-radius: 2rem;
		background: var(--ink);
		box-shadow: var(--shadow-float);
		color: var(--surface);
		font-size: var(--t-ui);
		translate: -50% 0;
	}

	@media (prefers-reduced-motion: no-preference) {
		.drop {
			animation: drop-in var(--fast) var(--ease-out);
		}

		@keyframes drop-in {
			from {
				opacity: 0;
			}
		}
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

	.divider {
		transition:
			background-color var(--fast) var(--ease-out),
			border-color var(--fast) var(--ease-out);
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

	@keyframes banner-in {
		from {
			opacity: 0;
			translate: 0 -6px;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.banner {
			animation: banner-in var(--medium) var(--ease-out);
		}
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

		.tabs button {
			transition:
				color var(--fast) var(--ease-out),
				border-color var(--medium) var(--ease-out);
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
			color: var(--on-error);
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
