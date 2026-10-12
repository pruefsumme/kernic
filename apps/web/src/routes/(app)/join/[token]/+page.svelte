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

	const can = {
		editor: 'open, change and create projects in it',
		viewer: 'open and export the projects in it, without changing them'
	};
</script>

<svelte:head>
	<title>Join a workspace · Kernic</title>
</svelte:head>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(false)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">Join a workspace</span>
	{/snippet}

	<div class="page">
		{#if data.tooMany}
			<h1>Too many attempts</h1>
			<p>Wait a few minutes, then open the link again.</p>
		{:else if !data.invite}
			<h1>This link is not valid</h1>
			<p>
				It may have been used already, been withdrawn, or be older than seven days. Ask the person
				who sent it for a new one.
			</p>
			<a class="button" href="/workspaces">Your workspaces</a>
		{:else if data.already}
			<h1>You are already in “{data.invite.workspaceName}”</h1>
			<p>There is nothing to do. The link stays valid for someone else.</p>
			<a class="button primary" href="/workspaces/{data.workspaceId}">Open the workspace</a>
		{:else}
			<h1>Join “{data.invite.workspaceName}”?</h1>
			<p>
				{data.invite.invitedBy ?? 'Someone'} invites you to this shared workspace as
				<strong>{data.invite.role}</strong>: you will be able to {can[data.invite.role]}. The other
				members will see your name and email address.
			</p>
			{#if form?.message}<p class="form-error" role="alert">{form.message}</p>{/if}
			<form method="POST" use:enhance>
				<button class="button primary">Join the workspace</button>
				<a class="button" href="/">Not now</a>
			</form>
		{/if}
	</div>
</AppShell>

<style>
	.where {
		font-weight: 600;
	}

	.page {
		display: grid;
		gap: var(--s-4);
		justify-items: start;
		max-width: 34rem;
		margin: 0 auto;
		padding: var(--s-7) var(--s-5);
	}

	p {
		color: var(--ink-2);
	}

	form {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}
</style>
