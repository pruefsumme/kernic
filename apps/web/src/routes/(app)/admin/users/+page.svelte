<script lang="ts">
	import { enhance } from '$app/forms';
	import AppShell from '#lib/components/AppShell.svelte';
	import {
		helpDestination,
		projectsDestination,
		workspacesDestination
	} from '#lib/components/rail.ts';
	import { formatBytes, formatExact, formatWhen } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const link = $derived(form && 'link' in form ? form.link : null);
	const errorMessage = $derived(form && 'message' in form ? form.message : null);
	let copied = $state(false);

	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<svelte:head>
	<title>People · Kernic</title>
</svelte:head>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(false)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">People</span>
	{/snippet}

	<div class="page">
		<div>
			<h1>People</h1>
			<p class="lede">
				Everyone with an account on this server. There is no public sign-up: you invite people with
				a link.
			</p>
		</div>

		<section>
			<h2>Invite someone</h2>
			<p class="help">
				Creates a link with which that person chooses their own name and password. Kernic does not
				send email: copy the link and pass it on yourself. It works once and for 7 days.
			</p>
			<form method="POST" action="?/invite" use:enhance>
				<div class="field">
					<label for="email">Their email address</label>
					<input class="input" id="email" name="email" type="email" required autocomplete="off" />
				</div>
				<button class="button primary">Create invitation link</button>
			</form>
			{#if errorMessage}<p class="form-error" role="alert">{errorMessage}</p>{/if}
		</section>

		{#if link}
			<section class="link" aria-live="polite">
				<h2>{link.kind === 'invite' ? 'Invitation link' : 'Password reset link'} for {link.for}</h2>
				<p class="help">
					Shown only now. Valid until {formatExact(link.expiresAt)}. Anyone who has this link can
					use it, so send it privately.
				</p>
				<div class="copy">
					<input
						class="input"
						readonly
						value={link.url}
						aria-label="Link"
						onfocus={(event) => event.currentTarget.select()}
					/>
					<button class="button" type="button" onclick={() => copy(link.url)}>
						{copied ? 'Copied' : 'Copy link'}
					</button>
				</div>
			</section>
		{/if}

		<section>
			<h2>Accounts</h2>
			<ul class="users">
				{#each data.users as user (user.id)}
					<li class:disabled={user.disabledAt}>
						<div class="who">
							<span class="name">
								{user.displayName}
								{#if user.isAdmin}<span class="tag">Administrator</span>{/if}
								{#if user.disabledAt}<span class="tag off">Disabled</span>{/if}
								{#if user.id === data.ownId}<span class="tag">You</span>{/if}
							</span>
							<span class="meta">
								{user.email} ·
								{#if user.lastSeenAt}
									last active <time
										datetime={user.lastSeenAt.toISOString()}
										title={formatExact(user.lastSeenAt)}>{formatWhen(user.lastSeenAt)}</time
									>
								{:else}
									not signed in
								{/if}
								· {user.projects === 1 ? '1 project' : `${user.projects} projects`}, {formatBytes(
									user.storageBytes
								)}
							</span>
						</div>
						<div class="actions">
							{#if !user.disabledAt}
								<form method="POST" action="?/reset" use:enhance>
									<input type="hidden" name="userId" value={user.id} />
									<button
										class="button small"
										aria-label="Password reset link for {user.displayName}"
									>
										Reset link
									</button>
								</form>
							{/if}
							{#if user.id !== data.ownId}
								<form method="POST" action={user.disabledAt ? '?/enable' : '?/disable'} use:enhance>
									<input type="hidden" name="userId" value={user.id} />
									<button
										class="button small"
										class:danger={!user.disabledAt}
										aria-label="{user.disabledAt ? 'Enable' : 'Disable'} {user.displayName}"
									>
										{user.disabledAt ? 'Enable' : 'Disable'}
									</button>
								</form>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
			<p class="help">
				A disabled account cannot sign in and is signed out everywhere at once. Its projects are
				kept.
			</p>
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

	.link {
		padding: var(--s-4);
		border: 1px solid var(--accent);
		border-radius: var(--radius);
		background: var(--accent-soft);
	}

	.copy {
		display: flex;
		gap: var(--s-2);
	}

	.copy .input {
		font-size: var(--t-meta);
	}

	.users {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule);
	}

	.users li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2) var(--s-3);
		padding: var(--s-3) 0;
		border-bottom: 1px solid var(--rule);
	}

	.who {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--s-2);
		font-weight: 500;
	}

	.disabled .name {
		color: var(--ink-2);
	}

	.meta {
		color: var(--ink-2);
		font-size: var(--t-meta);
		overflow-wrap: anywhere;
	}

	.tag {
		padding: 0 0.4rem;
		border: 1px solid currentColor;
		border-radius: 1rem;
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-weight: 500;
	}

	.tag.off {
		color: var(--error);
	}

	.actions {
		display: flex;
		gap: var(--s-2);
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}

		.copy {
			flex-direction: column;
		}
	}
</style>
