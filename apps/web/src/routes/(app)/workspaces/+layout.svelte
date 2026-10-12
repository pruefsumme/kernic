<script lang="ts">
	import AppShell from '#lib/components/AppShell.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import {
		helpDestination,
		projectsDestination,
		workspacesDestination
	} from '#lib/components/rail.ts';
	import { page } from '$app/state';
	import type { LayoutProps } from './$types';

	/**
	 * Workspaces are one screen: all of them listed at the side, the personal
	 * one apart from the shared ones, and the chosen one beside the list.
	 */
	let { data, children }: LayoutProps = $props();

	const personal = $derived(data.overviews.filter((workspace) => workspace.kind === 'personal'));
	const shared = $derived(data.overviews.filter((workspace) => workspace.kind === 'team'));
	const roleNames = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
	const projects = (count: number) => (count === 1 ? '1 project' : `${count} projects`);
	const creating = $derived(page.url.pathname === '/workspaces/new');
</script>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(true)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">Workspaces</span>
	{/snippet}

	<div class="screen">
		<nav aria-label="Workspaces">
			<h2>Personal</h2>
			<ul>
				{#each personal as workspace (workspace.id)}
					<li>
						<a
							href="/workspaces/{workspace.id}"
							aria-current={page.params.workspaceId === workspace.id ? 'page' : undefined}
						>
							<span class="badge"><Icon name="person" size={18} /></span>
							<span class="text">
								<span class="name">Personal</span>
								<span class="meta">Only you · {projects(workspace.usage.projects)}</span>
							</span>
						</a>
					</li>
				{/each}
			</ul>

			<h2>Shared</h2>
			<ul>
				{#each shared as workspace (workspace.id)}
					<li>
						<a
							href="/workspaces/{workspace.id}"
							aria-current={page.params.workspaceId === workspace.id ? 'page' : undefined}
						>
							<span class="badge shared"><Icon name="people" size={18} /></span>
							<span class="text">
								<span class="name">{workspace.name}</span>
								<span class="meta">
									{workspace.members === 1 ? '1 member' : `${workspace.members} members`} ·
									{projects(workspace.usage.projects)} · {roleNames[workspace.role]}
								</span>
							</span>
						</a>
					</li>
				{:else}
					<li class="none">
						None yet. In a shared workspace several people work on the same projects.
					</li>
				{/each}
				<li>
					<a class="new" href="/workspaces/new" aria-current={creating ? 'page' : undefined}>
						<span class="badge plain"><Icon name="plus" size={18} /></span>
						<span class="text"><span class="name">New shared workspace</span></span>
					</a>
				</li>
			</ul>
		</nav>

		<div class="pane">
			{@render children()}
		</div>
	</div>
</AppShell>

<style>
	.where {
		font-weight: 600;
	}

	.screen {
		display: grid;
		grid-template-columns: 17rem minmax(0, 1fr);
		min-height: 100%;
	}

	nav {
		display: grid;
		align-content: start;
		gap: var(--s-1);
		padding: var(--s-5) var(--s-3);
		border-right: 1px solid var(--rule);
		background: var(--ground);
	}

	h2 {
		padding: 0 var(--s-2);
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h2:not(:first-child) {
		margin-top: var(--s-4);
	}

	ul {
		display: grid;
		gap: 2px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	a {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: var(--s-2);
		border-radius: var(--radius-float);
		color: inherit;
		text-decoration: none;
		transition: background-color var(--fast) var(--ease-out);
	}

	a:hover {
		background: var(--sunken);
	}

	a[aria-current='page'] {
		background: var(--accent-soft);
	}

	.badge {
		display: grid;
		flex: none;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		background: var(--sunken);
		color: var(--ink-2);
	}

	/* A shared workspace is marked solid, the personal one light: other people are in here. */
	.badge.shared {
		background: var(--ink);
		color: var(--surface);
	}

	.badge.plain {
		border: 1px dashed var(--control-border);
		background: none;
	}

	a[aria-current='page'] .badge:not(.shared, .plain) {
		background: var(--surface);
	}

	.text {
		display: grid;
		min-width: 0;
	}

	.name {
		overflow: hidden;
		font-weight: 500;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta,
	.none {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.none {
		padding: var(--s-1) var(--s-2) var(--s-2);
	}

	.new .name {
		color: var(--ink-2);
	}

	.pane {
		min-width: 0;
	}

	@media (max-width: 800px) {
		.screen {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto 1fr;
		}

		/* The list becomes a row that scrolls sideways within itself. */
		nav {
			display: flex;
			align-items: stretch;
			gap: var(--s-2);
			padding: var(--s-3);
			overflow-x: auto;
			border-right: 0;
			border-bottom: 1px solid var(--rule);
			scrollbar-width: none;
		}

		h2 {
			display: none;
		}

		ul {
			display: flex;
			flex: none;
			gap: var(--s-2);
		}

		a {
			border: 1px solid var(--rule);
			background: var(--surface);
		}

		a[aria-current='page'] {
			border-color: var(--accent);
		}

		.none {
			display: none;
		}
	}
</style>
