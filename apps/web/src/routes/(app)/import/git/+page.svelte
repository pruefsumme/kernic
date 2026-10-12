<script lang="ts">
	import { enhance } from '$app/forms';
	import AppShell from '#lib/components/AppShell.svelte';
	import {
		helpDestination,
		projectsDestination,
		workspacesDestination
	} from '#lib/components/rail.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let submitting = $state(false);
</script>

<svelte:head>
	<title>Clone a repository · Kernic</title>
</svelte:head>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(false)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<a class="crumb" href="/">Projects</a>
		<span class="where">Clone</span>
	{/snippet}

	<div class="page">
		<div>
			<h1>Make a project from a Git repository</h1>
			<p class="lede">
				Kernic fetches the repository, checks it as it checks a ZIP archive (what it needs, what is
				missing, and whether it compiles) and shows you the result. Nothing is created until you
				confirm. The project keeps the repository's history, so you can pull and push afterwards.
			</p>
		</div>

		{#if data.workspaces.length === 0}
			<p class="form-error">
				You have read-only access to every workspace you belong to. Ask a workspace owner for edit
				access to create projects.
			</p>
		{:else}
			<form
				method="POST"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update({ reset: false });
						submitting = false;
					};
				}}
			>
				<div class="field">
					<label for="url">Address of the repository</label>
					<input
						class="input"
						id="url"
						name="url"
						type="url"
						required
						autocomplete="off"
						spellcheck="false"
						placeholder="https://{data.hosts[0]?.replace(/^http:\/\//, '')}/you/thesis.git"
						value={form?.entered?.url ?? ''}
					/>
					<p class="hint">
						On {#each data.hosts as host, index (host)}{index > 0 ? ', ' : ''}<strong>{host}</strong
							>{/each}.
					</p>
				</div>
				<div class="field">
					<label for="branch">Branch</label>
					<input
						class="input"
						id="branch"
						name="branch"
						autocomplete="off"
						spellcheck="false"
						placeholder="main"
						value={form?.entered?.branch ?? ''}
					/>
				</div>
				<div class="field">
					<label for="token">Access token (optional)</label>
					<input
						class="input"
						id="token"
						name="token"
						type="password"
						autocomplete="off"
						aria-describedby="token-hint"
					/>
					<p class="hint" id="token-hint">
						Needed for a private repository, and to push later. Stored encrypted on this server.
						Without one, a public repository can still be cloned, but the project is not connected
						to it.
					</p>
				</div>
				<div class="field">
					<label for="username">User name on the forge (optional)</label>
					<input
						class="input"
						id="username"
						name="username"
						autocomplete="off"
						spellcheck="false"
						value={form?.entered?.username ?? ''}
					/>
				</div>
				{#if data.workspaces.length > 1}
					<div class="field">
						<label for="workspace">Create the project in</label>
						<select class="input" id="workspace" name="workspace">
							{#each data.workspaces as workspace (workspace.id)}
								<option value={workspace.id} selected={workspace.id === form?.entered?.workspace}>
									{workspace.name}
								</option>
							{/each}
						</select>
					</div>
				{:else}
					<input type="hidden" name="workspace" value={data.workspaces[0]?.id} />
				{/if}

				{#if form?.message}<p class="form-error" role="alert">{form.message}</p>{/if}
				<div class="actions">
					<button class="button primary" disabled={submitting}>
						{submitting ? 'Fetching…' : 'Check repository'}
					</button>
					<a class="button quiet" href="/">Cancel</a>
					<a class="other" href="/import">Import a ZIP archive instead</a>
				</div>
			</form>
		{/if}
	</div>
</AppShell>

<style>
	.crumb {
		color: var(--ink-2);
		text-decoration: none;
	}

	.crumb:hover {
		text-decoration: underline;
	}

	.where {
		font-weight: 600;
	}

	.page {
		display: grid;
		gap: var(--s-5);
		max-width: 40rem;
		margin: 0 auto;
		padding: var(--s-6) var(--s-5) var(--s-7);
	}

	.lede {
		margin-top: var(--s-2);
		color: var(--ink-2);
	}

	form {
		display: grid;
		gap: var(--s-4);
	}

	.field {
		max-width: 30rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2) var(--s-3);
	}

	.other {
		color: var(--accent);
		font-size: var(--t-ui);
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}
	}
</style>
