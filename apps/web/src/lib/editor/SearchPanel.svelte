<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { ApiError, type SearchMatch } from './api.ts';
	import type { EditorSession } from './session.svelte.ts';
	import SidePanel from './SidePanel.svelte';

	/** Finds text in all files of the project and jumps to a match. */
	let {
		session,
		onreveal,
		onclose
	}: {
		session: EditorSession;
		onreveal: (path: string, line: number, column: number) => void;
		onclose: () => void;
	} = $props();

	const MIN_LENGTH = 2;
	let query = $state('');
	let outcome = $state<
		| { kind: 'idle' }
		| { kind: 'searching' }
		| { kind: 'done'; query: string; matches: SearchMatch[]; truncated: boolean }
		| { kind: 'failed'; message: string }
	>({ kind: 'idle' });

	/** Matches of the finished search, one group per file, in the order of the file list. */
	const groups = $derived.by(() => {
		if (outcome.kind !== 'done') return [];
		// Matches arrive file by file, so a new path starts a new group.
		const found: { path: string; matches: SearchMatch[] }[] = [];
		for (const match of outcome.matches) {
			const last = found.at(-1);
			if (last?.path === match.path) last.matches.push(match);
			else found.push({ path: match.path, matches: [match] });
		}
		return found;
	});

	// Search a moment after the last keystroke, and again when files were saved,
	// dropping the answer to a question that has been replaced meanwhile.
	$effect(() => {
		const wanted = query;
		void session.revision;
		if (wanted.trim().length < MIN_LENGTH) {
			outcome = { kind: 'idle' };
			return;
		}

		const abort = new AbortController();
		const timer = setTimeout(async () => {
			if (untrack(() => outcome.kind) !== 'done') outcome = { kind: 'searching' };
			try {
				// The search reads saved files, so what was just typed has to be saved first.
				await untrack(() => session.flush());
				const result = await session.api.search(wanted, abort.signal);
				if (!abort.signal.aborted) outcome = { kind: 'done', query: wanted, ...result };
			} catch (error) {
				if (abort.signal.aborted) return;
				outcome = {
					kind: 'failed',
					message:
						error instanceof ApiError ? error.message : 'The search could not reach the server.'
				};
			}
		}, 250);
		return () => {
			clearTimeout(timer);
			abort.abort();
		};
	});

	function focus(input: HTMLInputElement) {
		input.focus();
	}
</script>

<SidePanel title="Search" {onclose}>
	<div class="field">
		<Icon name="search" size={16} />
		<input
			{@attach focus}
			type="search"
			aria-label="Search in all files"
			placeholder="Search in all files"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			maxlength="200"
			bind:value={query}
		/>
	</div>

	{#if outcome.kind === 'idle'}
		<p class="note">
			Finds text in every file of this project, whatever its capitalisation. Type at least two
			characters.
		</p>
	{:else if outcome.kind === 'searching'}
		<p class="note" role="status">Searching…</p>
	{:else if outcome.kind === 'failed'}
		<p class="note error" role="alert">{outcome.message}</p>
	{:else if outcome.matches.length === 0}
		<p class="note" role="status">
			Nothing found for “{outcome.query}”. Check the spelling or try a shorter piece of text.
		</p>
	{:else}
		<p class="note" role="status">
			{outcome.matches.length === 1 ? '1 match' : `${outcome.matches.length} matches`} in
			{groups.length === 1 ? '1 file' : `${groups.length} files`}{outcome.truncated
				? '; there are more. Type more to narrow it down.'
				: '.'}
		</p>
		<ul class="groups">
			{#each groups as group (group.path)}
				<li>
					<h3><Icon name="file" size={14} /> <span>{group.path}</span></h3>
					<ul>
						{#each group.matches as match, index (index)}
							<li>
								<button
									type="button"
									onclick={() => onreveal(match.path, match.line, match.column)}
								>
									<span class="line">{match.line}</span>
									<span class="preview"
										>{match.preview.slice(0, match.start)}<mark
											>{match.preview.slice(match.start, match.start + match.length)}</mark
										>{match.preview.slice(match.start + match.length)}</span
									>
								</button>
							</li>
						{/each}
					</ul>
				</li>
			{/each}
		</ul>
	{/if}
</SidePanel>

<style>
	.field {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin: 0 var(--s-3) var(--s-2);
		padding: 0 var(--s-2);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--ink-2);
		transition:
			border-color var(--fast) var(--ease-out),
			box-shadow var(--fast) var(--ease-out);
	}

	.field:focus-within {
		border-color: var(--focus);
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	input {
		flex: 1;
		min-width: 0;
		height: 2rem;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: var(--t-ui);
	}

	input:focus {
		outline: none;
	}

	input::placeholder {
		color: var(--ink-3);
	}

	.note {
		margin: 0;
		padding: var(--s-1) var(--s-3) var(--s-2);
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.note.error {
		color: var(--error);
	}

	ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.groups {
		padding-bottom: var(--s-4);
	}

	h3 {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		margin: var(--s-2) 0 0;
		padding: var(--s-1) var(--s-3);
		color: var(--ink);
		font-size: var(--t-meta);
		font-weight: 600;
	}

	h3 span {
		overflow-wrap: anywhere;
	}

	button {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr);
		gap: var(--s-2);
		width: 100%;
		padding: 0.2rem var(--s-3);
		border: 0;
		background: none;
		color: var(--ink-2);
		font: inherit;
		font-size: var(--t-meta);
		text-align: left;
		cursor: pointer;
	}

	button:hover,
	button:focus-visible {
		background: var(--sunken);
		outline: none;
	}

	button:focus-visible {
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.line {
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}

	.preview {
		overflow: hidden;
		color: var(--ink);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	mark {
		border-radius: 2px;
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 600;
	}
</style>
