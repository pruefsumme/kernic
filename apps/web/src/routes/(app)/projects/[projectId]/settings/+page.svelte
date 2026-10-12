<script lang="ts">
	import { formatExact, formatWhen } from '#lib/format.ts';
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
	/** What was typed into the repository form when it was refused; the token is not among it. */
	const entered = $derived(
		form?.action === 'connect' && 'entered' in form
			? (form.entered as { url: string; branch: string; username: string })
			: null
	);

	const link = $derived(form?.action === 'share' && 'link' in form ? form.link : null);
	let copied = $state(false);
	async function copy(text: string) {
		await navigator.clipboard.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 2000);
	}
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

		{#if data.isOwner}
			<section>
				<h2>Share for reading</h2>
				<p class="help">
					A link that shows the rendered pages of this project, as they are when the link is opened,
					to anyone who has it. No account is needed. They cannot see the source or the files and
					cannot change anything.
				</p>
				<form method="POST" action="?/share" use:enhance>
					<div class="field">
						<label for="lifetime">The link works for</label>
						<select class="input" id="lifetime" name="lifetime">
							{#each data.shareLifetimes as days (days)}
								<option value={days}>{days === 365 ? 'One year' : `${days} days`}</option>
							{/each}
							<option value="none">Until I withdraw it</option>
						</select>
					</div>
					{#if messageFor('share')}<p class="field-error" role="alert">
							{messageFor('share')}
						</p>{/if}
					<div class="row">
						<button class="button">Create a link for reading</button>
					</div>
				</form>

				{#if link}
					<div class="link" aria-live="polite">
						<h3>Link for reading</h3>
						<p class="help">
							Shown only now.
							{link.expiresAt
								? `It works until ${formatExact(link.expiresAt)}.`
								: 'It works until you withdraw it.'}
							Anyone who has it can read the document.
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

				{#if data.shares.length > 0}
					<h3>Links in use</h3>
					<ul class="shares">
						{#each data.shares as share (share.id)}
							<li>
								<span>
									Created {formatWhen(share.createdAt)} ·
									{share.expiresAt ? `works until ${formatExact(share.expiresAt)}` : 'no end date'} ·
									{share.lastOpenedAt
										? `last opened ${formatWhen(share.lastOpenedAt)}`
										: 'not opened yet'}
								</span>
								<form method="POST" action="?/unshare" use:enhance>
									<input type="hidden" name="shareId" value={share.id} />
									<button class="button small">Withdraw</button>
								</form>
							</li>
						{/each}
					</ul>
					{#if messageFor('unshare')}
						<p class="field-error" role="alert">{messageFor('unshare')}</p>
					{/if}
				{/if}
			</section>
		{/if}

		<section>
			<h2>Git repository</h2>
			{#if data.remote}
				<p class="help">
					The checkpoints of this project can be pushed to
					<strong class="address">{data.remote.url}</strong>, branch
					<strong>{data.remote.branch}</strong>, from the History panel of the editor.
					{#if data.remote.lastPushedAt}
						Last pushed {formatWhen(data.remote.lastPushedAt)}.
					{:else}
						Nothing has been pushed yet.
					{/if}
				</p>
				{#if data.isOwner}
					<form method="POST" action="?/disconnect" use:enhance>
						<p class="help">
							Disconnecting removes the access token from this server. The repository and what was
							pushed to it stay as they are.
						</p>
						{#if messageFor('disconnect')}
							<p class="field-error" role="alert">{messageFor('disconnect')}</p>
						{/if}
						<div class="row">
							<button class="button">Disconnect</button>
						</div>
					</form>
				{/if}
			{:else if data.remoteHosts.length === 0}
				<p class="help">
					A project can push its checkpoints to a Git repository on a forge such as Forgejo or
					Gitea. This server is not set up for that: its administrator has to name the hosts it may
					connect to.
				</p>
			{:else if !data.isOwner}
				<p class="help">
					This project is not connected to a Git repository. An owner of the workspace can connect
					it.
				</p>
			{:else}
				<p class="help">
					Push the checkpoints of this project to a repository on
					{#each data.remoteHosts as host, index (host)}{index > 0
							? index === data.remoteHosts.length - 1
								? ' or '
								: ', '
							: ''}<strong>{host}</strong>{/each}. Create an empty repository there and an access
					token that may write to it. Checkpoints carry the names and e-mail addresses of the people
					who made them; whoever can read the repository can read those too.
				</p>
				<form method="POST" action="?/connect" use:enhance>
					<div class="field">
						<label for="remote-url">Address of the repository</label>
						<input
							class="input"
							id="remote-url"
							name="url"
							type="url"
							required
							autocomplete="off"
							spellcheck="false"
							placeholder="https://{data.remoteHosts[0]?.replace(/^http:\/\//, '')}/you/thesis.git"
							value={entered?.url ?? ''}
						/>
					</div>
					<div class="field">
						<label for="remote-branch">Branch</label>
						<input
							class="input"
							id="remote-branch"
							name="branch"
							autocomplete="off"
							spellcheck="false"
							placeholder="main"
							value={entered?.branch ?? ''}
						/>
					</div>
					<div class="field">
						<label for="remote-username">User name on the forge (optional)</label>
						<input
							class="input"
							id="remote-username"
							name="username"
							autocomplete="off"
							spellcheck="false"
							value={entered?.username ?? ''}
						/>
					</div>
					<div class="field">
						<label for="remote-token">Access token</label>
						<input
							class="input"
							id="remote-token"
							name="token"
							type="password"
							required
							autocomplete="off"
							aria-describedby="remote-token-hint"
						/>
						<p class="hint" id="remote-token-hint">
							Stored encrypted on this server and never shown again. Give it no more than write
							access to this one repository if the forge allows that.
						</p>
					</div>
					{#if messageFor('connect')}
						<p class="field-error" role="alert">{messageFor('connect')}</p>
					{/if}
					<div class="row">
						<button class="button">Connect</button>
					</div>
				</form>
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
	h3 {
		font-size: var(--t-ui);
		font-weight: 600;
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

	/* An address is long and has no spaces: let it break anywhere rather than widen the page. */
	.address {
		overflow-wrap: anywhere;
	}

	.shares {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule);
	}

	.shares li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2) var(--s-3);
		padding: var(--s-2) 0;
		border-bottom: 1px solid var(--rule);
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

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
