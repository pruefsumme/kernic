<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '#lib/components/Icon.svelte';
	import { activeSection, type PageSection } from '#lib/components/sections.ts';
	import SettingsGroup from '#lib/components/SettingsGroup.svelte';
	import { page } from '$app/state';
	import { formatBytes, formatExact, formatWhen } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const shared = $derived(data.workspace.kind === 'team');
	const owner = $derived(shared && data.workspace.role === 'owner');
	const heading = $derived(shared ? data.workspace.name : 'Personal');
	const link = $derived(form && 'link' in form ? form.link : null);
	const failure = $derived(form && 'message' in form ? form : null);
	const messageFor = (action: string) => (failure?.action === action ? failure.message : null);

	const canCreate = $derived(data.workspace.role !== 'viewer');
	const sections = $derived<(PageSection & { count?: number })[]>([
		{ id: 'projects', label: 'Projects', icon: 'projects', count: data.projects.length },
		...(shared
			? [{ id: 'members', label: 'Members', icon: 'people' as const, count: data.members.length }]
			: []),
		...(owner
			? [
					{
						id: 'invitations',
						label: 'Invitations',
						icon: 'link' as const,
						count: data.invites.length || undefined
					},
					{ id: 'settings', label: 'Settings', icon: 'settings' as const }
				]
			: [])
	]);
	const active = $derived(activeSection(page.url, sections));

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

<div class="page">
	<header>
		<span class="badge" class:shared><Icon name={shared ? 'people' : 'person'} size={22} /></span>
		<div class="title">
			<p class="kind">{shared ? 'Shared workspace' : 'Personal workspace'}</p>
			<h1>{heading}</h1>
			<p class="lede">
				{#if shared}
					{data.members.length === 1 ? 'Only you are' : `${data.members.length} people are`} in it and
					can open its projects · you are {data.workspace.role === 'owner' ? 'an' : 'a'}
					{data.workspace.role}
				{:else}
					Only you can open these projects.
				{/if}
			</p>
		</div>
		{#if data.members.length > 1}
			<!-- Who is in here, at a glance; the Members section has the names. -->
			<ul class="faces" aria-hidden="true">
				{#each data.members.slice(0, 5) as member (member.userId)}
					<li title={member.displayName}>{member.displayName.trim().charAt(0).toUpperCase()}</li>
				{/each}
				{#if data.members.length > 5}<li class="more">+{data.members.length - 5}</li>{/if}
			</ul>
		{/if}
	</header>

	{#if sections.length > 1}
		<nav class="tabs" aria-label="Sections">
			{#each sections as section (section.id)}
				<a
					href="?section={section.id}"
					aria-current={section.id === active ? 'page' : undefined}
					data-sveltekit-noscroll
					data-sveltekit-replacestate
					data-sveltekit-keepfocus
				>
					{section.label}
					{#if section.count !== undefined}<span class="count">{section.count}</span>{/if}
				</a>
			{/each}
		</nav>
	{/if}

	<div class="content">
		{#if active === 'projects'}
			{#if data.projects.length === 0}
				<p class="empty">
					No projects here yet.
					{#if canCreate}
						Create one{shared ? ', or move one in from its settings under Sharing' : ''}.
					{/if}
				</p>
			{:else}
				<ul class="rows">
					{#each data.projects as project (project.id)}
						<li>
							<a class="project" href="/projects/{project.id}">
								<Icon name="file" size={18} />
								<span>{project.name}</span>
							</a>
							<span class="meta">
								edited
								<time
									datetime={project.updatedAt.toISOString()}
									title={formatExact(project.updatedAt)}>{formatWhen(project.updatedAt)}</time
								>
							</span>
						</li>
					{/each}
				</ul>
			{/if}
			{#if canCreate}
				<div class="row">
					<a class="button primary" href="/?new&workspace={data.workspace.id}">
						New project {shared ? 'in this workspace' : ''}
					</a>
				</div>
			{/if}

			<div class="usage">
				<meter
					min="0"
					max="100"
					high="85"
					value={Math.min(100, (data.usage.bytes / data.usage.maxBytes) * 100)}
					aria-label="Storage used in {heading}"
				></meter>
				<span class="meta">
					{formatBytes(data.usage.bytes)} of {formatBytes(data.usage.maxBytes)} used ·
					{data.usage.projects} of {data.usage.maxProjects} projects
				</span>
			</div>

			{#if !shared}
				<aside class="tip">
					<Icon name="people" size={18} />
					<p>
						To work on a project with someone, <a href="/workspaces/new"
							>create a shared workspace</a
						>
						and move the project into it from the project's settings.
					</p>
				</aside>
			{/if}
		{:else if active === 'members'}
			<SettingsGroup
				title={data.members.length === 1 ? '1 member' : `${data.members.length} members`}
				description={owner
					? 'Change what someone may do, or remove them. To let someone in, create a link under Invitations.'
					: 'The people who can reach the projects of this workspace.'}
			>
				<ul class="rows">
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
									<form method="POST" action="?/role&section=members" use:enhance>
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
									<form method="POST" action="?/remove&section=members" use:enhance>
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
			</SettingsGroup>
		{:else if active === 'invitations'}
			<SettingsGroup
				title="Let someone in"
				description="Creates a link for one person who has an account on this server. They open it, confirm, and are a member. Kernic does not send email: copy the link and pass it on yourself. It works once and for 7 days."
			>
				<form method="POST" action="?/invite&section=invitations" use:enhance>
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
							Shown only now. Valid until {formatExact(link.expiresAt)}. Whoever opens it first with
							an account joins, so send it privately.
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
			</SettingsGroup>

			<SettingsGroup
				title="Links that have not been used"
				description={data.invites.length === 0
					? 'None at the moment.'
					: 'Withdraw a link that should no longer let anyone in.'}
			>
				{#if data.invites.length > 0}
					<ul class="rows">
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
								<form method="POST" action="?/revoke&section=invitations" use:enhance>
									<input type="hidden" name="inviteId" value={invite.id} />
									<button class="button small">Withdraw</button>
								</form>
							</li>
						{/each}
					</ul>
				{/if}
			</SettingsGroup>
		{:else}
			<SettingsGroup title="Name">
				<form method="POST" action="?/rename&section=settings" use:enhance>
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
			</SettingsGroup>

			<SettingsGroup
				danger
				title="Delete workspace"
				description="Only an empty workspace can be deleted: move its projects elsewhere or delete them first. Its members lose nothing else."
			>
				{#if messageFor('delete')}
					<p class="form-error" role="alert">{messageFor('delete')}</p>
				{/if}
				<form method="POST" action="?/delete&section=settings" use:enhance>
					<button class="button danger" disabled={data.usage.projects > 0}>
						Delete this workspace
					</button>
				</form>
			</SettingsGroup>
		{/if}
	</div>
</div>

<style>
	.page {
		display: grid;
		align-content: start;
		gap: var(--s-4);
		max-width: 52rem;
		padding: var(--s-5) var(--s-6) var(--s-7);
	}

	header {
		display: flex;
		align-items: center;
		gap: var(--s-4);
	}

	.badge {
		display: grid;
		flex: none;
		place-items: center;
		width: 3rem;
		height: 3rem;
		border-radius: 50%;
		background: var(--sunken);
		color: var(--ink-2);
	}

	.badge.shared {
		background: var(--ink);
		color: var(--surface);
	}

	.title {
		flex: 1;
		min-width: 0;
	}

	.kind {
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	h1 {
		overflow-wrap: anywhere;
	}

	.lede {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.faces {
		display: flex;
		flex: none;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.faces li {
		display: grid;
		place-items: center;
		width: 2rem;
		height: 2rem;
		margin-left: -0.4rem;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--sunken);
		color: var(--ink);
		font-size: var(--t-meta);
		font-weight: 600;
	}

	.faces .more {
		color: var(--ink-2);
		font-weight: 500;
	}

	/* The sections of a workspace, as tabs under its name. */
	.tabs {
		display: flex;
		gap: var(--s-4);
		border-bottom: 1px solid var(--rule);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.tabs a {
		display: flex;
		flex: none;
		align-items: center;
		gap: var(--s-2);
		padding: var(--s-2) 0;
		margin-bottom: -1px;
		border-bottom: 2px solid transparent;
		color: var(--ink-2);
		font-size: var(--t-ui);
		font-weight: 500;
		text-decoration: none;
	}

	.tabs a:hover {
		color: var(--ink);
	}

	.tabs a[aria-current='page'] {
		border-bottom-color: var(--accent);
		color: var(--ink);
	}

	.count {
		min-width: 1.4rem;
		padding: 0 0.35rem;
		border-radius: 1rem;
		background: var(--sunken);
		color: var(--ink-2);
		font-size: var(--t-meta);
		text-align: center;
	}

	.content {
		display: grid;
		align-content: start;
		gap: var(--s-4);
		min-width: 0;
		padding-top: var(--s-2);
	}

	.empty {
		color: var(--ink-2);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	.tip {
		display: flex;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-4);
		border-radius: var(--radius-float);
		background: var(--sunken);
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	.tip :global(svg) {
		flex: none;
		margin-top: 2px;
	}

	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule);
	}

	.rows li {
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

	.project {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
		color: inherit;
		font-weight: 500;
		text-decoration: none;
	}

	.project:hover span {
		text-decoration: underline;
	}

	.project span {
		overflow-wrap: anywhere;
	}

	.usage {
		display: grid;
		gap: var(--s-1);
	}

	@media (max-width: 800px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}

		.faces {
			display: none;
		}
	}

	@media (max-width: 640px) {
		.copy {
			flex-direction: column;
		}
	}
</style>
