<script lang="ts">
	import { enhance } from '$app/forms';
	import AppShell from '#lib/components/AppShell.svelte';
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

	<div class="page">
		<div>
			<h1>Workspaces</h1>
			<p class="lede">
				A workspace holds projects and decides who can reach them. Yours is for you alone; a shared
				one is for working on the same projects with others.
			</p>
		</div>

		<ul class="list">
			{#each data.workspaces as workspace (workspace.id)}
				<li>
					<a href="/workspaces/{workspace.id}">
						<span class="name">
							{workspace.kind === 'personal' ? 'Your projects' : workspace.name}
							<span class="tag">
								{workspace.kind === 'personal' ? 'Only you' : roleNames[workspace.role]}
							</span>
						</span>
						<span class="meta">
							{workspace.usage.projects === 1
								? '1 project'
								: `${workspace.usage.projects} projects`}
							· {formatBytes(workspace.usage.bytes)}
							{#if workspace.kind === 'team'}
								· {workspace.members === 1 ? '1 member' : `${workspace.members} members`}
							{/if}
						</span>
					</a>
				</li>
			{/each}
		</ul>

		<section>
			<h2>New shared workspace</h2>
			<p class="help">
				You become its owner and let others in with a link. Projects you create in it, or move into
				it, are theirs to see as well.
			</p>
			<form method="POST" action="?/create" use:enhance>
				<div class="field">
					<label for="name">Name</label>
					<input
						class="input"
						id="name"
						name="name"
						required
						maxlength="80"
						autocomplete="off"
						value={form?.name ?? ''}
						aria-invalid={form?.message ? 'true' : undefined}
					/>
				</div>
				{#if form?.message}<p class="form-error" role="alert">{form.message}</p>{/if}
				<button class="button primary">Create workspace</button>
			</form>
		</section>
	</div>
</AppShell>

<style>
	.where {
		font-weight: 600;
	}

	.page {
		display: grid;
		gap: var(--s-5);
		max-width: 46rem;
		margin: 0 auto;
		padding: var(--s-5) var(--s-5) var(--s-7);
	}

	.lede,
	.help {
		color: var(--ink-2);
	}

	.lede {
		margin-top: var(--s-1);
	}

	.help {
		font-size: var(--t-ui);
	}

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule);
	}

	.list a {
		display: grid;
		gap: 2px;
		padding: var(--s-3) var(--s-2);
		margin: 0 calc(-1 * var(--s-2));
		border-bottom: 1px solid var(--rule);
		color: inherit;
		text-decoration: none;
		transition: background-color var(--fast) var(--ease-out);
	}

	.list li:last-child a {
		border-bottom: 0;
	}

	.list a:hover {
		background: var(--sunken);
	}

	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		font-weight: 500;
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

	section {
		display: grid;
		gap: var(--s-3);
		padding-top: var(--s-5);
		border-top: 1px solid var(--rule);
	}

	form {
		display: grid;
		gap: var(--s-3);
		justify-items: start;
	}

	.field {
		width: 100%;
		max-width: 26rem;
	}
</style>
