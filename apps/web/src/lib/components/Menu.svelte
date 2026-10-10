<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * A button that opens a menu. Built on the Popover API, which provides the
	 * top layer, light dismiss and Escape handling. Put `<button role="menuitem">`
	 * or `<a role="menuitem">` elements inside.
	 */
	let {
		label,
		trigger,
		children,
		align = 'start',
		triggerClass = 'button quiet small'
	}: {
		/** Accessible name of the trigger when its content is not text. */
		label?: string;
		trigger: Snippet;
		children: Snippet;
		align?: 'start' | 'end';
		triggerClass?: string;
	} = $props();

	const id = $props.id();
	let button: HTMLButtonElement;
	let menu: HTMLDivElement;
	let open = $state(false);

	function place() {
		const anchor = button.getBoundingClientRect();
		const width = menu.offsetWidth;
		const left = align === 'end' ? anchor.right - width : anchor.left;
		menu.style.left = `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`;
		const below = anchor.bottom + 4;
		const fitsBelow = below + menu.offsetHeight <= window.innerHeight - 8;
		menu.style.top = `${fitsBelow ? below : Math.max(8, anchor.top - menu.offsetHeight - 4)}px`;
	}

	function items(): HTMLElement[] {
		return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
	}

	function ontoggle(event: ToggleEvent) {
		open = event.newState === 'open';
		if (open) {
			place();
			items()[0]?.focus();
		}
	}

	function onkeydown(event: KeyboardEvent) {
		const all = items();
		const index = all.indexOf(document.activeElement as HTMLElement);
		if (event.key === 'ArrowDown') all[(index + 1) % all.length]?.focus();
		else if (event.key === 'ArrowUp') all[(index - 1 + all.length) % all.length]?.focus();
		else if (event.key === 'Home') all[0]?.focus();
		else if (event.key === 'End') all.at(-1)?.focus();
		else return;
		event.preventDefault();
	}

	function onclick(event: MouseEvent) {
		// Choosing an item closes the menu and returns focus to the trigger.
		if ((event.target as HTMLElement).closest('[role="menuitem"]')) menu.hidePopover();
	}
</script>

<button
	bind:this={button}
	class={triggerClass}
	type="button"
	popovertarget={id}
	aria-haspopup="menu"
	aria-expanded={open}
	aria-label={label}
>
	{@render trigger()}
</button>

<div
	bind:this={menu}
	{id}
	class="menu"
	popover="auto"
	role="menu"
	tabindex="-1"
	{ontoggle}
	{onkeydown}
	{onclick}
>
	{@render children()}
</div>

<style>
	.menu {
		position: fixed;
		inset: auto;
		margin: 0;
		min-width: 12rem;
		max-width: min(20rem, calc(100vw - 1rem));
		padding: var(--s-1);
		border: 1px solid var(--rule);
		border-radius: var(--radius-float);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-float);
	}

	.menu :global([role='menuitem']) {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		width: 100%;
		min-height: 2rem;
		padding: 0 var(--s-2);
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--ink);
		font: inherit;
		font-size: var(--t-ui);
		text-align: left;
		text-decoration: none;
		cursor: pointer;
		transition: background-color var(--fast) var(--ease-out);
	}

	.menu :global([role='menuitem']:hover),
	.menu :global([role='menuitem']:focus-visible) {
		background: var(--sunken);
		outline: none;
	}

	.menu :global([role='menuitem'].danger) {
		color: var(--error);
	}

	.menu :global([role='menuitem'][disabled]) {
		color: var(--ink-3);
		cursor: not-allowed;
	}

	.menu :global(hr) {
		margin: var(--s-1) 0;
		border: 0;
		border-top: 1px solid var(--rule);
	}

	.menu :global(.menu-note) {
		padding: var(--s-1) var(--s-2);
		color: var(--ink-2);
		font-size: var(--t-meta);
	}
</style>
