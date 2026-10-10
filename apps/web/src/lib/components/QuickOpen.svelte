<script lang="ts" module>
	import type { IconName } from './Icon.svelte';

	export interface QuickItem {
		id: string;
		/** What is matched against the typed text and shown. */
		label: string;
		/** What kind of thing this is, shown beside the label: "File", "Heading", "Action". */
		kind: string;
		icon: IconName;
		run: () => void;
	}
</script>

<script lang="ts">
	import { rank, segments } from '#lib/fuzzy.ts';
	import Icon from './Icon.svelte';

	/**
	 * A palette to jump somewhere or run an action by typing a few letters.
	 * The caller supplies the items; choosing one closes the palette and runs it.
	 */
	let {
		open = $bindable(false),
		items,
		label
	}: {
		open: boolean;
		items: QuickItem[];
		/** Says what can be found, for the field's placeholder and accessible name. */
		label: string;
	} = $props();

	const MAX_SHOWN = 50;
	const id = $props.id();
	let dialog: HTMLDialogElement;
	let list = $state<HTMLElement>();
	let query = $state('');
	let active = $state(0);

	// Nothing is matched or rendered while the palette is closed.
	const matches = $derived(
		open ? rank(query, items, (item) => item.label).slice(0, MAX_SHOWN) : []
	);

	$effect(() => {
		if (open && !dialog.open) {
			query = '';
			active = 0;
			dialog.showModal();
		}
		if (!open && dialog.open) dialog.close();
	});

	$effect(() => {
		list?.children[active]?.scrollIntoView({ block: 'nearest' });
	});

	function choose(item: QuickItem | undefined) {
		if (!item) return;
		open = false;
		item.run();
	}

	function keydown(event: KeyboardEvent) {
		const last = matches.length - 1;
		if (event.key === 'ArrowDown') active = active >= last ? 0 : active + 1;
		else if (event.key === 'ArrowUp') active = active <= 0 ? last : active - 1;
		else if (event.key === 'Home' && query === '') active = 0;
		else if (event.key === 'End' && query === '') active = last;
		else if (event.key === 'Enter') choose(matches[active]?.item);
		else return;
		event.preventDefault();
	}
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<dialog
	bind:this={dialog}
	aria-label={label}
	onclose={() => (open = false)}
	onclick={(event) => {
		// A click on the backdrop lands on the dialog element itself.
		if (event.target === dialog) open = false;
	}}
>
	<div class="field">
		<Icon name="search" size={18} />
		<input
			role="combobox"
			aria-label={label}
			aria-expanded="true"
			aria-controls="{id}-list"
			aria-activedescendant={matches.length > 0 ? `${id}-option-${active}` : undefined}
			aria-autocomplete="list"
			placeholder={label}
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			bind:value={query}
			oninput={() => (active = 0)}
			onkeydown={keydown}
		/>
		<kbd>Esc</kbd>
	</div>

	{#if open && matches.length === 0}
		<p class="empty" role="status">Nothing matches “{query.trim()}”. Try fewer letters.</p>
	{/if}
	<ul
		bind:this={list}
		id="{id}-list"
		role="listbox"
		aria-label="Results"
		hidden={matches.length === 0}
	>
		{#each matches as { item, positions }, index (item.id)}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<li
				id="{id}-option-{index}"
				role="option"
				aria-selected={index === active}
				onclick={() => choose(item)}
				onpointermove={() => (active = index)}
			>
				<Icon name={item.icon} size={16} />
				<span class="label">
					{#each segments(item.label, positions) as run, part (part)}
						{#if run.matched}<mark>{run.text}</mark>{:else}{run.text}{/if}
					{/each}
				</span>
				<span class="kind">{item.kind}</span>
			</li>
		{/each}
	</ul>
</dialog>

<style>
	dialog {
		width: min(36rem, calc(100vw - 1.5rem));
		max-height: min(30rem, calc(100dvh - 6rem));
		margin-top: 4.5rem;
		padding: 0;
		border: 1px solid var(--rule);
		border-radius: var(--radius-float);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-float);
		overflow: hidden;
	}

	dialog[open] {
		display: flex;
		flex-direction: column;
	}

	dialog::backdrop {
		background: oklch(23% 0.02 250 / 0.25);
	}

	.field {
		display: flex;
		align-items: center;
		flex: none;
		gap: var(--s-2);
		padding: 0 var(--s-3);
		border-bottom: 1px solid var(--rule);
		color: var(--ink-2);
	}

	input {
		flex: 1;
		min-width: 0;
		height: 3rem;
		border: 0;
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: var(--t-body);
	}

	input:focus {
		outline: none;
	}

	input::placeholder {
		color: var(--ink-3);
	}

	kbd {
		padding: 0.05rem 0.4rem;
		border: 1px solid var(--rule);
		border-radius: var(--radius);
		color: var(--ink-2);
		font-family: var(--font-ui);
		font-size: 0.75rem;
	}

	ul {
		margin: 0;
		padding: var(--s-1);
		list-style: none;
		overflow-y: auto;
	}

	li {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-height: 2.25rem;
		padding: 0 var(--s-2);
		border-radius: var(--radius);
		color: var(--ink-2);
		font-size: var(--t-ui);
		cursor: pointer;
	}

	li[aria-selected='true'] {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.label {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		color: var(--ink);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	mark {
		background: none;
		color: var(--accent);
		font-weight: 600;
	}

	.kind {
		flex: none;
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.empty {
		margin: 0;
		padding: var(--s-4) var(--s-3);
		color: var(--ink-2);
		font-size: var(--t-ui);
	}
</style>
