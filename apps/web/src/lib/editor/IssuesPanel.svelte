<script lang="ts">
	import type { Diagnostic } from './api.ts';
	import type { EditorSession } from './session.svelte.ts';
	import SidePanel from './SidePanel.svelte';

	let {
		session,
		onreveal,
		onclose
	}: {
		session: EditorSession;
		onreveal: (diagnostic: Diagnostic) => void;
		onclose: () => void;
	} = $props();

	// Errors first; within a severity, the compiler's order.
	const sorted = $derived(
		session.diagnostics.toSorted(
			(a, b) => Number(b.severity === 'error') - Number(a.severity === 'error')
		)
	);

	const location = (diagnostic: Diagnostic) =>
		diagnostic.path
			? `${diagnostic.path}${diagnostic.line ? `, line ${diagnostic.line}` : ''}`
			: null;
	// Problems inside packages cannot be opened in this project.
	const canOpen = (diagnostic: Diagnostic) =>
		diagnostic.path !== null && session.hasEntry(diagnostic.path);
</script>

<SidePanel title="Issues" {onclose}>
	{#if session.compile.status === 'unavailable'}
		<div class="state">
			<p class="problem">The document could not be compiled.</p>
			<p>{session.compile.message}</p>
			<button class="button small" type="button" onclick={() => session.requestCompile()}>
				Try again
			</button>
		</div>
	{:else if sorted.length === 0}
		<p class="state">
			{#if session.compile.status === 'compiling'}
				Compiling…
			{:else if session.compile.status === 'idle'}
				Errors and warnings from the compiler will be listed here.
			{:else}
				No errors or warnings. The document compiled cleanly.
			{/if}
		</p>
	{:else}
		<ul>
			{#each sorted as diagnostic, index (index)}
				<li class={diagnostic.severity}>
					{#snippet body()}
						<span class="severity">{diagnostic.severity === 'error' ? 'Error' : 'Warning'}</span>
						<span class="message">{diagnostic.message}</span>
						{#if location(diagnostic)}<span class="where">{location(diagnostic)}</span>{/if}
					{/snippet}
					{#if canOpen(diagnostic)}
						<button type="button" onclick={() => onreveal(diagnostic)}>{@render body()}</button>
					{:else}
						<div class="static">{@render body()}</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</SidePanel>

<style>
	.state {
		display: grid;
		gap: var(--s-2);
		justify-items: start;
		padding: var(--s-1) var(--s-3);
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.problem {
		color: var(--error);
		font-weight: 500;
	}

	ul {
		margin: 0;
		padding: 0 var(--s-2) var(--s-4);
		list-style: none;
	}

	li {
		margin-bottom: var(--s-1);
		border-left: 3px solid var(--warning);
		background: var(--surface);
	}

	li.error {
		border-left-color: var(--error);
	}

	button,
	.static {
		display: grid;
		gap: 2px;
		width: 100%;
		padding: var(--s-2);
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: var(--t-ui);
		line-height: 1.4;
		text-align: left;
	}

	button {
		cursor: pointer;
	}

	button:hover {
		background: var(--sunken);
	}

	.severity {
		color: var(--warning);
		font-size: var(--t-meta);
		font-weight: 600;
	}

	.error .severity {
		color: var(--error);
	}

	.message {
		overflow-wrap: anywhere;
	}

	.where {
		color: var(--ink-2);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		overflow-wrap: anywhere;
	}
</style>
