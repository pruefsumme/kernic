<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { PullConflict } from './api.ts';

	/**
	 * Settles files that both the project and its repository changed: one choice
	 * for each, none preselected. Nothing has been applied while this is open.
	 */
	let {
		open = $bindable(false),
		conflicts,
		recorded,
		onsubmit
	}: {
		open: boolean;
		conflicts: PullConflict[];
		/** Whether the current files were recorded as a checkpoint to get here. */
		recorded: boolean;
		/** May throw; its message is shown and the dialog stays open. */
		onsubmit: (choices: Record<string, 'ours' | 'theirs'>) => Promise<void>;
	} = $props();

	let dialog: HTMLDialogElement;
	let choices = $state<Record<string, 'ours' | 'theirs'>>({});
	let error = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (open && !dialog.open) {
			choices = {};
			error = null;
			dialog.showModal();
		}
		if (!open && dialog.open) dialog.close();
	});

	const what = {
		'both-changed': 'Changed here and in the repository',
		'both-added': 'Added in both places, with different content',
		'deleted-there': 'Changed here, deleted in the repository',
		'deleted-here': 'Deleted here, changed in the repository'
	};
	/** What each side means for this kind of conflict. */
	const sides = {
		'both-changed': { ours: 'Keep mine', theirs: 'Take the repository’s' },
		'both-added': { ours: 'Keep mine', theirs: 'Take the repository’s' },
		'deleted-there': { ours: 'Keep mine', theirs: 'Delete it, as the repository did' },
		'deleted-here': { ours: 'Keep it deleted', theirs: 'Take the repository’s' }
	};
	const settled = $derived(conflicts.every((conflict) => choices[conflict.path] !== undefined));

	function all(side: 'ours' | 'theirs') {
		choices = Object.fromEntries(conflicts.map((conflict) => [conflict.path, side]));
	}

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			await onsubmit(choices);
			open = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-labelledby="pull-title">
	<form onsubmit={submit}>
		<header>
			<h2 id="pull-title">
				{conflicts.length === 1
					? 'One file was changed in both places'
					: `${conflicts.length} files were changed in both places`}
			</h2>
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
			<p class="note">
				Nothing has been taken over yet. Choose for each file which version stays; the rest of the
				repository's changes come in either way.
				{#if recorded}
					Your files were recorded as a checkpoint first, so you can return to them.
				{/if}
			</p>
			<div class="quick">
				<button class="button small" type="button" onclick={() => all('ours')}
					>Keep mine for all</button
				>
				<button class="button small" type="button" onclick={() => all('theirs')}>
					Take the repository’s for all
				</button>
			</div>

			{#each conflicts as conflict (conflict.path)}
				<fieldset>
					<legend>
						<span class="path">{conflict.path}</span>
						<span class="kind">{what[conflict.kind]}</span>
					</legend>
					{#each ['ours', 'theirs'] as const as side (side)}
						<label>
							<input
								type="radio"
								name={conflict.path}
								value={side}
								checked={choices[conflict.path] === side}
								onchange={() => (choices[conflict.path] = side)}
							/>
							<span>{sides[conflict.kind][side]}</span>
						</label>
					{/each}
				</fieldset>
			{/each}
		</div>

		<footer>
			{#if error}<p class="form-error" role="alert">{error}</p>{/if}
			<div class="actions">
				<button class="button" type="button" onclick={() => (open = false)}>Cancel</button>
				<button class="button primary" disabled={!settled || busy}>
					{busy ? 'Taking over…' : 'Take over the changes'}
				</button>
			</div>
		</footer>
	</form>
</dialog>

<style>
	dialog {
		width: min(38rem, calc(100vw - 2rem));
		max-width: none;
		max-height: calc(100dvh - 2rem);
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
		grid-template-rows: auto minmax(0, 1fr) auto;
		max-height: calc(100dvh - 2rem);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-3) var(--s-3) var(--s-4);
		border-bottom: 1px solid var(--rule);
	}

	.body {
		display: grid;
		align-content: start;
		gap: var(--s-3);
		padding: var(--s-4);
		overflow: auto;
	}

	.note {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.quick {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	fieldset {
		display: grid;
		gap: var(--s-1);
		min-width: 0;
		margin: 0;
		padding: var(--s-3);
		border: 1px solid var(--rule);
		border-radius: var(--radius);
	}

	legend {
		display: grid;
		gap: 2px;
		padding: 0 var(--s-1);
		font-size: var(--t-ui);
	}

	.path {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.kind {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	label {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 1.75rem;
		font-size: var(--t-ui);
	}

	footer {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-3) var(--s-4);
		border-top: 1px solid var(--rule);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
	}

	@media (max-width: 720px) {
		dialog {
			width: 100vw;
			height: 100dvh;
			max-height: none;
			border: 0;
			border-radius: 0;
		}

		form {
			height: 100dvh;
			max-height: none;
		}
	}
</style>
