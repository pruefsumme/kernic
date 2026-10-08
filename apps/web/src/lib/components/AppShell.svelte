<script lang="ts" module>
	import type { IconName } from './Icon.svelte';

	export interface RailItem {
		id: string;
		label: string;
		icon: IconName;
		/** A destination. Give either `href` or `onclick`. */
		href?: string;
		/** A panel toggle. `active` then reflects whether the panel is open. */
		onclick?: () => void;
		active?: boolean;
		/** Opens in a new tab (external help). */
		external?: boolean;
		/** Count shown on the icon, e.g. the number of problems. */
		badge?: number;
		badgeTone?: 'error' | 'warning';
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import BrandMark from './BrandMark.svelte';
	import Icon from './Icon.svelte';
	import Menu from './Menu.svelte';

	/**
	 * The frame shared by every signed-in screen: a full-height rail on the left
	 * that runs into the top bar as one continuous piece of chrome, an optional
	 * panel attached to the rail, and the content area.
	 */
	let {
		userName,
		destinations,
		footer = [],
		menus,
		title,
		actions,
		panel,
		children,
		scroll = true
	}: {
		userName: string;
		/** Core destinations, in the middle of the rail. */
		destinations: RailItem[];
		/** Less frequent destinations, at the bottom of the rail. */
		footer?: RailItem[];
		/** Left of the top bar: menus. */
		menus?: Snippet;
		/** Middle of the top bar: where you are, and its state. */
		title?: Snippet;
		/** Right of the top bar: actions for the current screen. */
		actions?: Snippet;
		/** Panel attached to the rail. Render nothing to close it. */
		panel?: Snippet;
		children: Snippet;
		/** Whether the content area scrolls as a page (dashboard) or manages its own panes (editor). */
		scroll?: boolean;
	} = $props();
</script>

{#snippet railItem(item: RailItem)}
	{#snippet content()}
		<span class="glyph">
			<Icon name={item.icon} />
			{#if item.badge}
				<span class="badge" class:warning={item.badgeTone === 'warning'}>
					{item.badge > 99 ? '99+' : item.badge}
				</span>
			{/if}
		</span>
		<span class="label">{item.label}</span>
	{/snippet}

	{#if item.href}
		<a
			class="rail-item"
			class:active={item.active}
			href={item.href}
			aria-current={item.active ? 'page' : undefined}
			target={item.external ? '_blank' : undefined}
			rel={item.external ? 'noreferrer' : undefined}
		>
			{@render content()}
		</a>
	{:else}
		<button
			class="rail-item"
			class:active={item.active}
			type="button"
			aria-pressed={item.active ?? false}
			aria-label={item.badge ? `${item.label} (${item.badge})` : undefined}
			onclick={item.onclick}
		>
			{@render content()}
		</button>
	{/if}
{/snippet}

<div class="shell">
	<a class="skip" href="#content">Skip to content</a>
	<nav class="rail" aria-label="Main">
		<a class="mark" href="/" aria-label="Kernic, all projects">
			<BrandMark size={26} />
		</a>

		<a class="rail-item create" href="/?new">
			<span class="glyph"><Icon name="plus" /></span>
			<span class="label">New</span>
		</a>

		<div class="group">
			{#each destinations as item (item.id)}
				{@render railItem(item)}
			{/each}
		</div>

		<div class="group bottom">
			{#each footer as item (item.id)}
				{@render railItem(item)}
			{/each}
		</div>
	</nav>

	<header class="topbar">
		<div class="menus">{@render menus?.()}</div>
		<div class="title">{@render title?.()}</div>
		<div class="actions">
			{@render actions?.()}
			<Menu align="end" label="Account: {userName}">
				{#snippet trigger()}
					<span class="avatar" aria-hidden="true">{userName.trim().charAt(0).toUpperCase()}</span>
					<span class="user-name">{userName}</span>
					<Icon name="chevronDown" size={14} />
				{/snippet}
				<form method="POST" action="/logout">
					<button role="menuitem"><Icon name="signOut" size={16} /> Sign out</button>
				</form>
			</Menu>
		</div>
	</header>

	<div class="body">
		{#if panel}
			{@render panel()}
		{/if}
		<main id="content" tabindex="-1" class:scroll>{@render children()}</main>
	</div>
</div>

<style>
	.skip {
		position: absolute;
		top: var(--s-2);
		left: var(--s-2);
		z-index: 20;
		padding: var(--s-2) var(--s-3);
		border-radius: var(--radius);
		background: var(--ink);
		color: var(--surface);
		font-size: var(--t-ui);
		translate: 0 -200%;
	}

	.skip:focus {
		translate: 0;
	}

	main:focus {
		outline: none;
	}

	.shell {
		display: grid;
		grid-template-columns: var(--rail-width) minmax(0, 1fr);
		grid-template-rows: var(--topbar-height) minmax(0, 1fr);
		height: 100dvh;
		background: var(--surface);
	}

	/*
	 * Rail and top bar are one L-shaped piece of chrome: same ground, no line
	 * between them. The only edges are the two hairlines of the content area,
	 * which meet in the inner corner of the L. The mark sits in the outer corner.
	 */
	.rail {
		grid-row: 1 / -1;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: var(--s-1);
		padding-bottom: var(--s-2);
		background: var(--ground);
		overflow-y: auto;
	}

	.topbar {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr);
		align-items: center;
		gap: var(--s-3);
		padding: 0 var(--s-3);
		border-bottom: 1px solid var(--rule);
		background: var(--ground);
	}

	.mark {
		display: grid;
		place-items: center;
		flex: none;
		height: var(--topbar-height);
		color: var(--ink);
	}

	.group {
		display: flex;
		flex-direction: column;
		gap: var(--s-1);
	}

	.group.bottom {
		margin-top: auto;
	}

	.rail-item {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		margin: 0 var(--s-1);
		padding: var(--s-2) 0 var(--s-1);
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--ink-2);
		font: inherit;
		text-decoration: none;
		cursor: pointer;
	}

	.rail-item:hover {
		background: var(--sunken);
		color: var(--ink);
	}

	.rail-item.active {
		background: var(--accent-soft);
		color: var(--accent);
	}

	.label {
		font-size: 0.75rem;
		font-weight: 500;
		line-height: 1.3;
	}

	.glyph {
		position: relative;
		display: grid;
	}

	.create {
		margin-bottom: var(--s-2);
		color: var(--ink);
	}

	.create .glyph {
		padding: 0.3rem;
		border: 1px solid var(--control-border);
		border-radius: 50%;
		background: var(--surface);
	}

	.badge {
		position: absolute;
		top: -0.4rem;
		left: 0.75rem;
		min-width: 1.05rem;
		padding: 0 0.25rem;
		border-radius: 1rem;
		background: var(--error);
		color: oklch(99% 0 0);
		font-size: 0.6875rem;
		font-weight: 600;
		line-height: 1.05rem;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	.badge.warning {
		background: var(--warning);
	}

	.menus,
	.actions {
		display: flex;
		align-items: center;
		gap: var(--s-1);
		min-width: 0;
	}

	.actions {
		justify-content: flex-end;
		gap: var(--s-2);
	}

	.title {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-width: 0;
		font-size: var(--t-ui);
	}

	.avatar {
		display: grid;
		place-items: center;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: var(--ink);
		color: var(--surface);
		font-size: 0.75rem;
		font-weight: 600;
	}

	.user-name {
		max-width: 10rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.body {
		/* Anchor for the rail panel when it overlays the content on narrow screens. */
		position: relative;
		display: flex;
		min-width: 0;
		min-height: 0;
		border-left: 1px solid var(--rule);
	}

	main {
		flex: 1;
		min-width: 0;
		min-height: 0;
	}

	main.scroll {
		overflow-y: auto;
	}

	/*
	 * Phones: the rail keeps its place in the chrome but lies along the bottom
	 * edge, where a thumb reaches it, and leaves the full width to the content.
	 */
	@media (max-width: 640px) {
		.shell {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: var(--topbar-height) minmax(0, 1fr) auto;
		}

		.rail {
			grid-row: 3;
			flex-direction: row;
			align-items: stretch;
			justify-content: space-around;
			gap: 0;
			padding: var(--s-1) var(--s-1) max(var(--s-1), env(safe-area-inset-bottom));
			border-top: 1px solid var(--rule);
			overflow: visible;
		}

		.body {
			border-left: 0;
		}

		.mark {
			display: none;
		}

		.group,
		.group.bottom {
			display: contents;
		}

		.rail-item {
			flex: 1;
			margin: 0;
		}

		.create {
			margin-bottom: 0;
		}

		.create .glyph {
			padding: 0;
			border: 0;
			background: none;
		}

		.topbar {
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: var(--s-2);
			padding: 0 var(--s-2);
		}

		.user-name {
			display: none;
		}
	}
</style>
