<script lang="ts">
	import { enhance } from '$app/forms';
	import AppShell from '#lib/components/AppShell.svelte';
	import { helpDestination, projectsDestination } from '#lib/components/rail.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const editorUrl = $derived(`/projects/${data.project.id}`);
	const messageFor = (action: string) =>
		form?.action === action && 'message' in form ? form.message : null;
	const savedBy = (action: string) => form?.action === action && 'saved' in form;
	let confirmName = $state('');
</script>

<svelte:head>
	<title>Settings · {data.project.name} · Kernic</title>
</svelte:head>

<AppShell
	destinations={[
		projectsDestination(false),
		{ id: 'editor', label: 'Editor', icon: 'files', href: editorUrl }
	]}
	footer={[
		{
			id: 'settings',
			label: 'Settings',
			icon: 'settings',
			href: `${editorUrl}/settings`,
			active: true
		},
		helpDestination
	]}
>
	{#snippet title()}
		<a class="project-name" href={editorUrl}>{data.project.name}</a>
		<span class="where">Settings</span>
	{/snippet}

	<div class="page">
		<div class="heading">
			<h1>Project settings</h1>
			<a class="button" href={editorUrl}>Back to editor</a>
		</div>

		{#if !data.canWrite}
			<p class="notice">
				You have read-only access to this project, so its settings cannot be changed.
			</p>
		{/if}

		<section>
			<h2>Name</h2>
			<form method="POST" action="?/rename" use:enhance>
				<div class="field">
					<label for="name">Project name</label>
					<input
						class="input"
						id="name"
						name="name"
						required
						maxlength="120"
						autocomplete="off"
						value={data.project.name}
						disabled={!data.canWrite}
					/>
				</div>
				{#if messageFor('rename')}<p class="field-error" role="alert">
						{messageFor('rename')}
					</p>{/if}
				<div class="row">
					<button class="button primary" disabled={!data.canWrite}>Save name</button>
					{#if savedBy('rename')}<span class="saved" role="status">Saved</span>{/if}
				</div>
			</form>
		</section>

		<section>
			<h2>Main file</h2>
			<p class="help">
				The Typst file that is compiled into the document. Other files are included from it.
			</p>
			<form method="POST" action="?/entry" use:enhance>
				{#if data.typstFiles.length === 0}
					<p class="notice">
						This project has no <span class="file-name">.typ</span> files.
						<a href={editorUrl}>Create one in the editor</a>
						first.
					</p>
				{:else}
					<div class="field">
						<label for="entryPath">Main file</label>
						<select class="input" id="entryPath" name="entryPath" disabled={!data.canWrite}>
							{#if !data.typstFiles.includes(data.project.entryPath)}
								<option value="" selected disabled>{data.project.entryPath} (missing)</option>
							{/if}
							{#each data.typstFiles as path (path)}
								<option value={path} selected={path === data.project.entryPath}>{path}</option>
							{/each}
						</select>
					</div>
					{#if messageFor('entry')}<p class="field-error" role="alert">
							{messageFor('entry')}
						</p>{/if}
					<div class="row">
						<button class="button primary" disabled={!data.canWrite}>Save main file</button>
						{#if savedBy('entry')}<span class="saved" role="status">Saved</span>{/if}
					</div>
				{/if}
			</form>
		</section>

		<section>
			<h2>Workspace</h2>
			<p class="help">
				This project is in <strong>{data.workspace.name}</strong>. Everyone in a workspace can open
				its projects; what they may do depends on their role there.
				<a href="/workspaces/{data.workspace.id}">See who that is.</a>
			</p>
			{#if data.isOwner && data.moveTargets.length > 0}
				<form method="POST" action="?/move" use:enhance>
					<div class="field">
						<label for="workspace">Move to</label>
						<select class="input" id="workspace" name="workspace">
							{#each data.moveTargets as target (target.id)}
								<option value={target.id}>{target.name}</option>
							{/each}
						</select>
					</div>
					<p class="help">
						The people of the workspace it leaves lose access to it, and the people of the one it
						goes to gain it. Files and history move with it.
					</p>
					{#if messageFor('move')}<p class="field-error" role="alert">{messageFor('move')}</p>{/if}
					<div class="row">
						<button class="button">Move project</button>
						{#if savedBy('move')}<span class="saved" role="status">Moved</span>{/if}
					</div>
				</form>
			{:else if data.isOwner}
				<p class="help">
					To share it, <a href="/workspaces">create a shared workspace</a> and move it there.
				</p>
			{/if}
		</section>

		<section>
			<h2>Backup</h2>
			<p class="help">
				Download every file of this project as a ZIP archive, with the same folder layout. The
				archive compiles anywhere with the Typst command line.
			</p>
			<div class="row">
				<a class="button" href="/api/projects/{data.project.id}/archive" download>Download ZIP</a>
			</div>
		</section>

		{#if data.isOwner}
			<section class="danger-zone">
				<h2>Delete project</h2>
				<p class="help">
					Deletes all files and rendered pages of “{data.project.name}” from this server. This
					cannot be undone; download a ZIP first if you might need the files again.
				</p>
				<form method="POST" action="?/delete" use:enhance>
					<div class="field">
						<label for="confirm">Type the project name to confirm</label>
						<input
							class="input"
							id="confirm"
							name="confirm"
							autocomplete="off"
							bind:value={confirmName}
						/>
					</div>
					{#if messageFor('delete')}<p class="field-error" role="alert">
							{messageFor('delete')}
						</p>{/if}
					<div class="row">
						<button class="button danger" disabled={confirmName.trim() !== data.project.name}>
							Delete this project
						</button>
					</div>
				</form>
			</section>
		{/if}
	</div>
</AppShell>

<style>
	.project-name {
		overflow: hidden;
		color: var(--ink);
		font-weight: 600;
		text-decoration: none;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.project-name:hover {
		text-decoration: underline;
	}

	.where {
		color: var(--ink-2);
	}

	.page {
		display: grid;
		gap: var(--s-5);
		max-width: 40rem;
		margin: 0 auto;
		padding: var(--s-5) var(--s-5) var(--s-7);
	}

	.heading {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
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
	}

	.field {
		max-width: 26rem;
	}

	.help,
	.notice {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--s-3);
	}

	.saved {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.danger-zone h2 {
		color: var(--error);
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}
	}
</style>
