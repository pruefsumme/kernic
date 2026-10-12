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

	const shared = $derived(data.workspace.kind === 'team');
	const owner = $derived(shared && data.workspace.role === 'owner');
	const heading = $derived(shared ? data.workspace.name : 'Your projects');
	const link = $derived(form && 'link' in form ? form.link : null);
	const failure = $derived(form && 'message' in form ? form : null);
	const messageFor = (action: string) => (failure?.action === action ? failure.message : null);

	const roles = [
		{ value: 'viewer', label: 'Viewer', can: 'Opens and exports projects' },
		{ value: 'editor', label: 'Editor', can: 'Also changes, creates and imports projects' },
		{ value: 'owner', label: 'Owner', can: 'Also deletes projects and manages members' }
	] as const;
	const roleName = (role: string) => roles.find((option) => option.value === role)?.label ?? role;

	let copied = $state(false);
	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
</script>

<svelte:head>
	<title>{heading} · Kernic</title>
</svelte:head>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(true)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">{heading}</span>
	{/snippet}

	<div class="page">
		<div class="head">
			<div>
				<h1>{heading}</h1>
				<p class="lede">
					{#if shared}
						Shared workspace · you are {data.workspace.role === 'owner' ? 'an' : 'a'}
						{data.workspace.role} ·
					{:else}
						Only you can reach these projects ·
					{/if}
					{data.usage.projects === 1 ? '1 project' : `${data.usage.projects} projects`},
					{formatBytes(data.usage.bytes)} of {formatBytes(data.usage.maxBytes)}
				</p>
			</div>
			<a class="button" href="/workspaces">All workspaces</a>
		</div>

		{#if !shared}
			<section>
				<h2>Working with others</h2>
				<p class="help">
					Your own workspace cannot be shared. To work on a project with someone, create a shared
					workspace and move the project into it from the project's settings.
				</p>
				<a class="button" href="/workspaces">Create a shared workspace</a>
			</section>
		{:else}
			<section>
				<h2>Members</h2>
				<ul class="people">
					{#each data.members as member (member.userId)}
						<li>
							<div class="who">
								<span class="name">
									{member.displayName}
									{#if member.userId === data.ownId}<span class="tag">You</span>{/if}
								</span>
								<span class="meta">
									{member.email} · joined
									<time
										datetime={member.joinedAt.toISOString()}
										title={formatExact(member.joinedAt)}>{formatWhen(member.joinedAt)}</time
									>
								</span>
							</div>
							<div class="actions">
								{#if owner}
									<form method="POST" action="?/role" use:enhance>
										<input type="hidden" name="userId" value={member.userId} />
										<select
											class="select"
											name="role"
											aria-label="Role of {member.displayName}"
											value={member.role}
											onchange={(event) => event.currentTarget.form?.requestSubmit()}
										>
											{#each roles as option (option.value)}
												<option value={option.value}>{option.label}</option>
											{/each}
										</select>
										<noscript><button class="button small">Set</button></noscript>
									</form>
								{:else}
									<span class="tag">{roleName(member.role)}</span>
								{/if}
								{#if owner || member.userId === data.ownId}
									<form method="POST" action="?/remove" use:enhance>
										<input type="hidden" name="userId" value={member.userId} />
										<button
											class="button small danger"
											aria-label={member.userId === data.ownId
												? 'Leave the workspace'
												: `Remove ${member.displayName}`}
										>
											{member.userId === data.ownId ? 'Leave' : 'Remove'}
										</button>
									</form>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
				{#if messageFor('role') || messageFor('remove')}
					<p class="form-error" role="alert">{messageFor('role') ?? messageFor('remove')}</p>
				{/if}
				<dl class="roles">
					{#each roles as option (option.value)}
						<div>
							<dt>{option.label}</dt>
							<dd>{option.can}</dd>
						</div>
					{/each}
				</dl>
			</section>

			{#if owner}
				<section>
					<h2>Let someone in</h2>
					<p class="help">
						Creates a link for one person who has an account on this server. They open it, confirm,
						and are a member. Kernic does not send email: copy the link and pass it on yourself. It
						works once and for 7 days.
					</p>
					<form method="POST" action="?/invite" use:enhance>
						<div class="field">
							<label for="invite-role">They join as</label>
							<select class="input" id="invite-role" name="role">
								<option value="editor">Editor · changes, creates and imports projects</option>
								<option value="viewer">Viewer · opens and exports projects</option>
							</select>
						</div>
						{#if messageFor('invite')}
							<p class="form-error" role="alert">{messageFor('invite')}</p>
						{/if}
						<button class="button primary">Create a link</button>
					</form>

					{#if link}
						<div class="link" aria-live="polite">
							<h3>Link to join as {link.role}</h3>
							<p class="help">
								Shown only now. Valid until {formatExact(link.expiresAt)}. Whoever opens it first
								with an account joins, so send it privately.
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
						</div>
					{/if}

					{#if data.invites.length > 0}
						<h3>Links that have not been used</h3>
						<ul class="people">
							{#each data.invites as invite (invite.id)}
								<li>
									<div class="who">
										<span class="name">To join as {invite.role}</span>
										<span class="meta">
											created {formatWhen(invite.createdAt)} · valid until {formatExact(
												invite.expiresAt
											)}
										</span>
									</div>
									<form method="POST" action="?/revoke" use:enhance>
										<input type="hidden" name="inviteId" value={invite.id} />
										<button class="button small">Withdraw</button>
									</form>
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<section>
					<h2>Name</h2>
					<form method="POST" action="?/rename" use:enhance>
						<div class="field">
							<label for="workspace-name">Workspace name</label>
							<input
								class="input"
								id="workspace-name"
								name="name"
								required
								maxlength="80"
								autocomplete="off"
								value={data.workspace.name}
							/>
						</div>
						{#if messageFor('rename')}
							<p class="form-error" role="alert">{messageFor('rename')}</p>
						{/if}
						<button class="button">Save name</button>
					</form>
				</section>

				<section>
					<h2 class="danger-title">Delete workspace</h2>
					<p class="help">
						Only an empty workspace can be deleted: move its projects elsewhere or delete them
						first. Its members lose nothing else.
					</p>
					{#if messageFor('delete')}
						<p class="form-error" role="alert">{messageFor('delete')}</p>
					{/if}
					<form method="POST" action="?/delete" use:enhance>
						<button class="button danger" disabled={data.usage.projects > 0}>
							Delete this workspace
						</button>
					</form>
				</section>
			{/if}
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
		max-width: 46rem;
		margin: 0 auto;
		padding: var(--s-5) var(--s-5) var(--s-7);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		justify-content: space-between;
		gap: var(--s-3);
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

	h3 {
		font-size: var(--t-ui);
		font-weight: 600;
	}

	section > form {
		display: grid;
		gap: var(--s-3);
		justify-items: start;
	}

	.field {
		width: 100%;
		max-width: 26rem;
	}

	.people {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule);
	}

	.people li {
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

	.actions {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}

	.actions select {
		min-height: 1.75rem;
		padding: 0 1.75rem 0 var(--s-2);
		border: 1px solid var(--control-border);
		border-radius: var(--radius);
		background-color: var(--surface);
		background-position:
			calc(100% - 0.75rem) 50%,
			calc(100% - 0.75rem + 5px) 50%;
		color: var(--ink);
		font: inherit;
		font-size: var(--t-meta);
	}

	.roles {
		display: grid;
		gap: var(--s-1);
		margin: 0;
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.roles div {
		display: grid;
		grid-template-columns: 4.5rem 1fr;
		gap: var(--s-2);
	}

	.roles dt {
		font-weight: 600;
	}

	.roles dd {
		margin: 0;
	}

	.link {
		display: grid;
		gap: var(--s-2);
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

	.danger-title {
		color: var(--error);
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--s-4) var(--s-4) var(--s-6);
		}

		.copy {
			flex-direction: column;
		}
	}
</style>
