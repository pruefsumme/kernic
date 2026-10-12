<script lang="ts">
	import { enhance } from '$app/forms';
	import AppShell from '#lib/components/AppShell.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import SectionedPage from '#lib/components/SectionedPage.svelte';
	import {
		helpDestination,
		projectsDestination,
		workspacesDestination
	} from '#lib/components/rail.ts';
	import { formatBytes } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const roleNames = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };
</script>

<svelte:head>
	<title>Workspaces · Kernic</title>
</svelte:head>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(true)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">Workspaces</span>
	{/snippet}

	<SectionedPage heading="Workspaces" sections={[]} active="">
		{#snippet lede()}
			A workspace holds projects and decides who can reach them. Yours is for you alone; a shared
			one is for working on the same projects with others.
		{/snippet}

		<ul class="cards">
			{#each data.workspaces as workspace (workspace.id)}
				{@const personal = workspace.kind === 'personal'}
				{@const share = Math.min(100, (workspace.usage.bytes / workspace.usage.maxBytes) * 100)}
				<li>
					<a class="card" href="/workspaces/{workspace.id}">
						<span class="top">
							<span class="badge"><Icon name={personal ? 'person' : 'people'} size={18} /></span>
							<span class="tag">{personal ? 'Only you' : roleNames[workspace.role]}</span>
						</span>
						<span class="name">{personal ? 'Your projects' : workspace.name}</span>
						<span class="meta">
							{workspace.usage.projects === 1
								? '1 project'
								: `${workspace.usage.projects} projects`}
							{#if !personal}
								· {workspace.members === 1 ? '1 member' : `${workspace.members} members`}
							{/if}
						</span>
						<span class="usage">
							<meter
								min="0"
								max="100"
								high="85"
								value={share}
								aria-label="Storage used in {personal ? 'your projects' : workspace.name}"
							></meter>
							<span class="meta">
								{formatBytes(workspace.usage.bytes)} of {formatBytes(workspace.usage.maxBytes)}
							</span>
						</span>
					</a>
				</li>
			{/each}
			<li>
				<form class="card new" method="POST" action="?/create" use:enhance>
					<span class="top">
						<span class="badge"><Icon name="plus" size={18} /></span>
					</span>
					<label class="name" for="name">New shared workspace</label>
					<span class="meta">
						You become its owner and let others in with a link. Projects you create in it, or move
						into it, are theirs to see as well.
					</span>
					<input
						class="input"
						id="name"
						name="name"
						required
						maxlength="80"
						autocomplete="off"
						placeholder="Its name, for example Thesis group"
						value={form?.name ?? ''}
						aria-invalid={form?.message ? 'true' : undefined}
					/>
					{#if form?.message}<p class="form-error" role="alert">{form.message}</p>{/if}
					<button class="button primary">Create workspace</button>
				</form>
			</li>
		</ul>
	</SectionedPage>
</AppShell>

<style>
	.where {
		font-weight: 600;
	}

	/* Each workspace is a card; the last card makes a new one. */
	.cards {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
		gap: var(--s-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.cards li {
		display: grid;
	}

	.card {
		display: grid;
		align-content: start;
		gap: var(--s-2);
		padding: var(--s-4);
		border: 1px solid var(--rule);
		border-radius: calc(var(--radius) * 2);
		background: var(--surface);
		color: inherit;
		text-decoration: none;
	}

	a.card {
		transition:
			border-color var(--fast) var(--ease-out),
			box-shadow var(--fast) var(--ease-out);
	}

	a.card:hover {
		border-color: var(--control-border);
		box-shadow: var(--shadow-float);
	}

	.card.new {
		border-style: dashed;
		justify-items: start;
	}

	.card.new .input {
		width: 100%;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
	}

	.badge {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		background: var(--accent-soft);
		color: var(--accent);
	}

	.new .badge {
		background: var(--sunken);
		color: var(--ink-2);
	}

	.name {
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.meta {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.tag {
		padding: 0 0.4rem;
		border: 1px solid currentColor;
		border-radius: 1rem;
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-weight: 500;
	}

	.usage {
		display: grid;
		gap: var(--s-1);
		margin-top: var(--s-2);
	}
</style>
