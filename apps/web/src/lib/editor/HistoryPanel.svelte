<script lang="ts">
	import Menu from '#lib/components/Menu.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import PromptDialog from '#lib/components/PromptDialog.svelte';
	import { formatExact, formatWhen } from '#lib/format.ts';
	import type { Change, Checkpoint, RemoteStatus, Snapshot } from './api.ts';
	import DiffDialog from './DiffDialog.svelte';
	import type { EditorSession } from './session.svelte.ts';
	import SidePanel from './SidePanel.svelte';

	let { session, onclose }: { session: EditorSession; onclose: () => void } = $props();

	/** Something that can be compared and restored: a checkpoint or an automatic snapshot. */
	interface Version {
		id: string;
		kind: 'checkpoint' | 'snapshot';
		/** How it is named in dialogs. */
		label: string;
	}

	const SNAPSHOTS_SHOWN = 6;

	let checkpoints = $state<Checkpoint[] | null>(null);
	let snapshots = $state<Snapshot[]>([]);
	let showAllSnapshots = $state(false);
	let changes = $state<Change[]>([]);
	let error = $state<string | null>(null);
	/** The repository the checkpoints are pushed to, if the project is connected to one. */
	let remote = $state<RemoteStatus | null>(null);
	let pushing = $state(false);
	let pushError = $state<string | null>(null);
	let pushed = $state(false);

	let creating = $state(false);
	let restoring = $state<Version | null>(null);
	let restoreOpen = $state(false);
	let diffOpen = $state(false);
	let diffTarget = $state<Version | 'working'>('working');

	const ofCheckpoint = (checkpoint: Checkpoint): Version => ({
		id: checkpoint.id,
		kind: 'checkpoint',
		label: `“${checkpoint.message}”`
	});
	const ofSnapshot = (snapshot: Snapshot): Version => ({
		id: snapshot.id,
		kind: 'snapshot',
		label: `the automatic snapshot of ${formatExact(snapshot.createdAt)}`
	});

	async function refresh() {
		try {
			const history = await session.api.history();
			checkpoints = history.checkpoints;
			snapshots = history.snapshots;
			changes = history.changes;
			remote = history.remote;
			error = null;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'The history could not be loaded.';
		}
	}

	// Reload when the panel opens and whenever a save changed the project's files.
	$effect(() => {
		void session.revision;
		if (session.saveState === 'saved') void refresh();
	});

	async function createCheckpoint(message: string) {
		if (!(await session.flush())) throw new Error('Save your changes first; the last save failed.');
		await session.api.createCheckpoint(message);
		await refresh();
	}

	async function push() {
		pushing = true;
		pushError = null;
		pushed = false;
		try {
			remote = await session.api.push();
			pushed = true;
		} catch (cause) {
			pushError = cause instanceof Error ? cause.message : 'The push did not work.';
		} finally {
			pushing = false;
		}
	}

	/** A repository's address without the protocol, as people say it. */
	const spoken = (url: string) => url.replace(/^https?:\/\//, '').replace(/\.git$/, '');

	async function restore() {
		if (!restoring) return;
		if (!(await session.flush())) throw new Error('Save your changes first; the last save failed.');
		const { revision } = await session.api.restoreCheckpoint(restoring.id);
		await session.reloadFromDisk(revision);
		await refresh();
	}

	function showDiff(target: Version | 'working') {
		diffTarget = target;
		diffOpen = true;
	}

	const kindLabel = { added: 'added', modified: 'changed', deleted: 'deleted', renamed: 'renamed' };
	const shownChanges = $derived(changes.slice(0, 6));
	const shownSnapshots = $derived(
		showAllSnapshots ? snapshots : snapshots.slice(0, SNAPSHOTS_SHOWN)
	);
</script>

<SidePanel title="History" {onclose}>
	{#if error}
		<div class="block">
			<p class="form-error" role="alert">{error}</p>
			<button class="button small" type="button" onclick={refresh}>Try again</button>
		</div>
	{:else if checkpoints === null}
		<p class="block note" role="status">Loading history…</p>
	{:else}
		<section class="block current" aria-label="Since the last checkpoint">
			{#if changes.length === 0}
				<p class="note">
					{checkpoints.length === 0
						? 'No checkpoints yet. A checkpoint records all files as they are now, so you can return to this version later.'
						: 'No changes since the last checkpoint.'}
				</p>
			{:else}
				<p class="count">
					{changes.length === 1 ? '1 file' : `${changes.length} files`} changed since the last checkpoint
				</p>
				<ul class="changes">
					{#each shownChanges as change (change.path)}
						<li>
							<span class="file">{change.path}</span>
							<span class="kind">{kindLabel[change.kind]}</span>
						</li>
					{/each}
					{#if changes.length > shownChanges.length}
						<li class="more">and {changes.length - shownChanges.length} more</li>
					{/if}
				</ul>
			{/if}
			<div class="actions">
				{#if session.canWrite}
					<button
						class="button primary small"
						type="button"
						disabled={changes.length === 0 && checkpoints.length > 0}
						onclick={() => (creating = true)}
					>
						Create checkpoint
					</button>
				{/if}
				{#if changes.length > 0 && checkpoints.length > 0}
					<button class="button small" type="button" onclick={() => showDiff('working')}>
						Review changes
					</button>
				{/if}
			</div>
		</section>

		{#if remote}
			<section class="block remote" aria-label="Git repository">
				<p class="count">
					<Icon name="upload" size={16} />
					<span class="file" title="{remote.url}, branch {remote.branch}">{spoken(remote.url)}</span
					>
				</p>
				<p class="note" role="status">
					{#if pushing}
						Pushing…
					{:else if checkpoints.length === 0}
						Nothing to push before the first checkpoint.
					{:else if remote.unpushed === 0}
						{pushed ? 'Pushed.' : 'All checkpoints are pushed.'}
						{#if remote.lastPushedAt}Last push {formatWhen(remote.lastPushedAt)}.{/if}
					{:else}
						{remote.unpushed === 1 ? '1 checkpoint is' : `${remote.unpushed} checkpoints are`} not pushed
						yet.
					{/if}
				</p>
				{#if pushError}<p class="form-error" role="alert">{pushError}</p>{/if}
				{#if session.canWrite && checkpoints.length > 0 && (remote.unpushed > 0 || pushError)}
					<div class="actions">
						<button class="button small" type="button" disabled={pushing} onclick={push}>
							Push to {remote.branch}
						</button>
					</div>
				{/if}
			</section>
		{/if}

		{#if checkpoints.length > 0}
			<h3>Checkpoints</h3>
			<ol class="checkpoints">
				{#each checkpoints as checkpoint (checkpoint.id)}
					<li>
						<div class="entry">
							<span class="message">{checkpoint.message}</span>
							<span class="meta">
								{checkpoint.authorName} ·
								<time
									datetime={checkpoint.createdAt.toISOString()}
									title={formatExact(checkpoint.createdAt)}
								>
									{formatWhen(checkpoint.createdAt)}
								</time>
							</span>
						</div>
						<Menu
							label="Actions for checkpoint “{checkpoint.message}”"
							align="end"
							triggerClass="more"
						>
							{#snippet trigger()}<Icon name="more" size={16} />{/snippet}
							<button role="menuitem" onclick={() => showDiff(ofCheckpoint(checkpoint))}>
								View changes
							</button>
							<a role="menuitem" href={session.api.checkpointArchiveUrl(checkpoint.id)} download>
								Download as ZIP
							</a>
							{#if session.canWrite}
								<button
									role="menuitem"
									onclick={() => {
										restoring = ofCheckpoint(checkpoint);
										restoreOpen = true;
									}}
								>
									Restore this version
								</button>
							{/if}
						</Menu>
					</li>
				{/each}
			</ol>
		{/if}

		{#if snapshots.length > 0}
			<h3>Automatic snapshots</h3>
			<p class="block note about">
				Taken while you work, at most every 10 minutes, and before a file is deleted. Kept for 30
				days.
			</p>
			<ol class="checkpoints">
				{#each shownSnapshots as snapshot (snapshot.id)}
					<li>
						<div class="entry">
							<time
								class="message"
								datetime={snapshot.createdAt.toISOString()}
								title={formatExact(snapshot.createdAt)}
							>
								{formatExact(snapshot.createdAt)}
							</time>
							<span class="meta">{formatWhen(snapshot.createdAt)}</span>
						</div>
						<Menu
							label="Actions for the snapshot of {formatExact(snapshot.createdAt)}"
							align="end"
							triggerClass="more"
						>
							{#snippet trigger()}<Icon name="more" size={16} />{/snippet}
							<button role="menuitem" onclick={() => showDiff(ofSnapshot(snapshot))}>
								Changes since then
							</button>
							<a role="menuitem" href={session.api.checkpointArchiveUrl(snapshot.id)} download>
								Download as ZIP
							</a>
							{#if session.canWrite}
								<button
									role="menuitem"
									onclick={() => {
										restoring = ofSnapshot(snapshot);
										restoreOpen = true;
									}}
								>
									Restore this version
								</button>
							{/if}
						</Menu>
					</li>
				{/each}
			</ol>
			{#if snapshots.length > SNAPSHOTS_SHOWN}
				<div class="block">
					<button
						class="button quiet small"
						type="button"
						onclick={() => (showAllSnapshots = !showAllSnapshots)}
					>
						{showAllSnapshots ? 'Show fewer' : `Show all ${snapshots.length}`}
					</button>
				</div>
			{/if}
		{/if}
	{/if}
</SidePanel>

<PromptDialog
	bind:open={creating}
	title="Create checkpoint"
	description="Records every file of the project as it is now. Describe what this version is, so you can find it again."
	label="Description"
	initialValue="Checkpoint"
	confirmLabel="Create checkpoint"
	onsubmit={createCheckpoint}
/>

<PromptDialog
	bind:open={restoreOpen}
	title="Restore this version?"
	description={`All files go back to ${restoring?.label ?? ''}. Your current files are recorded as a checkpoint first, so you can return to them.`}
	confirmLabel="Restore"
	onsubmit={restore}
/>

<DiffDialog
	bind:open={diffOpen}
	title={diffTarget === 'working'
		? 'Changes since the last checkpoint'
		: diffTarget.kind === 'checkpoint'
			? `Changes in ${diffTarget.label}`
			: `Changes since ${diffTarget.label}`}
	load={() => session.api.diff(diffTarget === 'working' ? 'working' : diffTarget.id)}
/>

<style>
	.block {
		display: grid;
		gap: var(--s-2);
		justify-items: start;
		padding: 0 var(--s-3) var(--s-3);
	}

	.note {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.count {
		font-size: var(--t-ui);
		font-weight: 500;
	}

	/* The repository: its address on one line, cut off rather than wrapped. */
	.remote {
		padding-top: var(--s-3);
		border-top: 1px solid var(--rule);
	}

	.remote .count {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		max-width: 100%;
		min-width: 0;
		margin: 0;
	}

	.remote .note {
		margin: 0;
	}

	.changes {
		width: 100%;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--t-meta);
	}

	.changes li {
		display: flex;
		justify-content: space-between;
		gap: var(--s-2);
		padding: 1px 0;
	}

	.file {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.kind,
	.more {
		flex: none;
		color: var(--ink-2);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		margin-top: var(--s-1);
	}

	.about {
		padding-bottom: var(--s-1);
		font-size: var(--t-meta);
	}

	h3 {
		margin: 0;
		padding: var(--s-3) var(--s-3) var(--s-1);
		border-top: 1px solid var(--rule);
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-weight: 600;
	}

	.checkpoints {
		margin: 0;
		padding: 0 var(--s-1) var(--s-4);
		list-style: none;
	}

	.checkpoints li {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		padding: var(--s-2) 0 var(--s-2) var(--s-2);
		border-radius: var(--radius);
	}

	.checkpoints li {
		transition: background-color var(--fast) var(--ease-out);
	}

	.checkpoints li:hover,
	.checkpoints li:focus-within {
		background: var(--sunken);
	}

	.entry {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: 1px;
	}

	.message {
		font-size: var(--t-ui);
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.meta {
		color: var(--ink-2);
		font-size: var(--t-meta);
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
	}

	li :global(.more:hover) {
		background: var(--rule);
		color: var(--ink);
	}
</style>
