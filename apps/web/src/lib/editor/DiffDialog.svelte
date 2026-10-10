<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { FileDiff } from './api.ts';

	/** Shows what changed, file by file, as a unified diff. */
	let {
		open = $bindable(false),
		title,
		load
	}: {
		open: boolean;
		title: string;
		/** Fetches the diff when the dialog opens. */
		load: () => Promise<FileDiff[]>;
	} = $props();

	let dialog: HTMLDialogElement;
	let files = $state<FileDiff[] | null>(null);
	let error = $state<string | null>(null);

	$effect(() => {
		if (open && !dialog.open) {
			files = null;
			error = null;
			dialog.showModal();
			load()
				.then((result) => (files = result))
				.catch(
					(cause) =>
						(error = cause instanceof Error ? cause.message : 'Could not load the changes.')
				);
		}
		if (!open && dialog.open) dialog.close();
	});

	const kindLabel = { added: 'Added', modified: 'Changed', deleted: 'Deleted', renamed: 'Renamed' };
	const marker = { added: '+', removed: '−', context: ' ', hunk: '' };
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-labelledby="diff-title">
	<header>
		<h2 id="diff-title">{title}</h2>
		<button
			class="button quiet small"
			type="button"
			aria-label="Close"
			onclick={() => (open = false)}
		>
			<Icon name="close" size={18} />
		</button>
	</header>

	<div class="body">
		{#if error}
			<p class="form-error" role="alert">{error}</p>
		{:else if files === null}
			<p class="note" role="status">Loading changes…</p>
		{:else if files.length === 0}
			<p class="note">No files were changed.</p>
		{:else}
			{#each files as file (file.path)}
				<section>
					<h3>
						<span class="kind {file.kind}">{kindLabel[file.kind]}</span>
						<span class="path">
							{#if file.previousPath}{file.previousPath} →
							{/if}{file.path}
						</span>
					</h3>
					{#if file.binary}
						<p class="note">This is not a text file; its content is not shown.</p>
					{:else if file.lines.length === 0}
						<p class="note">
							{file.kind === 'renamed' ? 'Moved without changes.' : 'No text changes.'}
						</p>
					{:else}
						<div class="lines" role="group" aria-label="Changes in {file.path}">
							{#each file.lines as line, index (index)}
								<div class="line {line.kind}">
									<span class="marker" aria-hidden="true">{marker[line.kind]}</span>
									<span class="visually-hidden">
										{line.kind === 'added' ? 'Added: ' : line.kind === 'removed' ? 'Removed: ' : ''}
									</span>
									<span class="text">{line.kind === 'hunk' ? '⋯' : line.text}</span>
								</div>
							{/each}
						</div>
						{#if file.truncated}
							<p class="note">This file has more changes than are shown here.</p>
						{/if}
					{/if}
				</section>
			{/each}
		{/if}
	</div>
</dialog>

<style>
	dialog {
		width: min(60rem, calc(100vw - 2rem));
		height: min(46rem, calc(100dvh - 2rem));
		max-width: none;
		max-height: none;
		padding: 0;
		border: 1px solid var(--rule);
		border-radius: var(--radius-float);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-float);
	}

	dialog[open] {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
	}

	dialog::backdrop {
		background: oklch(23% 0.02 250 / 0.35);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-3) var(--s-3) var(--s-4);
		border-bottom: 1px solid var(--rule);
	}

	header h2 {
		overflow-wrap: anywhere;
	}

	.body {
		padding: var(--s-4);
		overflow: auto;
	}

	section + section {
		margin-top: var(--s-5);
	}

	h3 {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--s-2);
		margin: 0 0 var(--s-2);
		font-size: var(--t-ui);
		font-weight: 500;
	}

	.path {
		overflow-wrap: anywhere;
	}

	.kind {
		padding: 0 0.4rem;
		border: 1px solid currentColor;
		border-radius: 1rem;
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.kind.deleted {
		color: var(--error);
	}

	.note {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.lines {
		border: 1px solid var(--rule);
		border-radius: var(--radius);
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.6;
		overflow-x: auto;
	}

	.line {
		display: flex;
		min-width: max-content;
	}

	.marker {
		flex: none;
		width: 1.75rem;
		color: var(--ink-3);
		text-align: center;
		user-select: none;
	}

	.text {
		padding-right: var(--s-3);
		white-space: pre;
	}

	/* Colour supports the +/− markers; it is not the only signal. */
	.line.added {
		background: oklch(95% 0.045 150);
	}

	.line.removed {
		background: var(--error-soft);
	}

	.line.hunk {
		background: var(--ground);
		color: var(--ink-3);
	}

	@media (max-width: 720px) {
		dialog {
			width: 100vw;
			height: 100dvh;
			border: 0;
			border-radius: 0;
		}
	}
</style>
