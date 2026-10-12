<script lang="ts">
	import AppShell from '#lib/components/AppShell.svelte';
	import {
		helpDestination,
		projectsDestination,
		workspacesDestination
	} from '#lib/components/rail.ts';
	import { formatExact } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const labels: Record<string, string> = {
		'setup.completed': 'Set up this server',
		'sign-in.succeeded': 'Signed in',
		'sign-in.failed': 'Failed sign-in',
		'sign-out': 'Signed out',
		'password.changed': 'Changed their password',
		'password.reset': 'Set a new password with a reset link',
		'session.revoked': 'Signed out another session',
		'account.invited': 'Invited',
		'account.created': 'Accepted an invitation',
		'account.disabled': 'Disabled the account of',
		'account.enabled': 'Enabled the account of',
		'account.reset-link-created': 'Created a password reset link for',
		'project.deleted': 'Deleted the project',
		'project.restored': 'Restored a version of',
		'project.imported': 'Imported the project',
		'project.moved': 'Moved to another workspace the project',
		'workspace.created': 'Created the shared workspace',
		'workspace.deleted': 'Deleted the shared workspace',
		'workspace.invite-created': 'Created a link to join the workspace',
		'workspace.member-joined': 'Joined the workspace',
		'workspace.member-removed': 'Removed a member from, or left, the workspace',
		'workspace.role-changed': 'Changed a role in the workspace'
	};

	let filter = $state('');
	const events = $derived(
		data.events.filter((event) => {
			const needle = filter.trim().toLowerCase();
			return (
				needle === '' ||
				[event.actorEmail, event.subject, labels[event.action], event.address].some((value) =>
					value?.toLowerCase().includes(needle)
				)
			);
		})
	);
</script>

<svelte:head>
	<title>Activity log · Kernic</title>
</svelte:head>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(false)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">Activity log</span>
	{/snippet}

	<div class="page">
		<div>
			<h1>Activity log</h1>
			<p class="lede">
				Sign-ins, account changes and irreversible project actions on this server, newest first.
				Entries cannot be edited or removed here.
			</p>
		</div>

		<div class="field filter">
			<label for="filter">Filter by person, action or address</label>
			<input class="input" id="filter" type="search" bind:value={filter} />
		</div>

		{#if events.length === 0}
			<p class="lede">
				{data.events.length === 0
					? 'Nothing has been recorded yet.'
					: 'No entry matches the filter.'}
			</p>
		{:else}
			<div class="scroll">
				<table>
					<thead>
						<tr><th>When</th><th>Who</th><th>What</th><th>From</th></tr>
					</thead>
					<tbody>
						{#each events as event (event.id)}
							<tr class:failed={event.action === 'sign-in.failed'}>
								<td><time datetime={event.at.toISOString()}>{formatExact(event.at)}</time></td>
								<td>{event.actorEmail ?? '—'}</td>
								<td>
									{labels[event.action] ?? event.action}
									{#if event.subject}<span class="subject">{event.subject}</span>{/if}
								</td>
								<td class="address">{event.address ?? ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</AppShell>

<style>
	.where {
		font-weight: 600;
	}

	.page {
		display: grid;
		gap: var(--s-5);
		max-width: 64rem;
		margin: 0 auto;
		padding: var(--s-5) var(--s-5) var(--s-7);
	}

	.lede {
		margin-top: var(--s-1);
		color: var(--ink-2);
	}

	.filter {
		max-width: 24rem;
	}

	.scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--t-ui);
	}

	th {
		padding: var(--s-2) var(--s-3) var(--s-2) 0;
		border-bottom: 1px solid var(--control-border);
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-weight: 600;
		text-align: left;
	}

	td {
		padding: var(--s-2) var(--s-3) var(--s-2) 0;
		border-bottom: 1px solid var(--rule);
		vertical-align: top;
		overflow-wrap: anywhere;
	}

	td:first-child {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.subject {
		font-weight: 500;
	}

	.address {
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-variant-numeric: tabular-nums;
	}

	.failed td:nth-child(3) {
		color: var(--error);
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}
	}
</style>
