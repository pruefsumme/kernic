<script lang="ts">
	import AppearanceSettings from '#lib/components/AppearanceSettings.svelte';
	import { enhance } from '$app/forms';
	import AppShell from '#lib/components/AppShell.svelte';
	import SectionedPage from '#lib/components/SectionedPage.svelte';
	import { activeSection, type PageSection } from '#lib/components/sections.ts';
	import SettingsGroup from '#lib/components/SettingsGroup.svelte';
	import { page } from '$app/state';
	import {
		helpDestination,
		projectsDestination,
		workspacesDestination
	} from '#lib/components/rail.ts';
	import { formatBytes, formatExact, formatWhen } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const messageFor = (action: string) =>
		form?.action === action && 'message' in form ? form.message : null;
	const savedBy = (action: string) => form?.action === action && 'saved' in form;

	const sections: PageSection[] = [
		{ id: 'profile', label: 'Profile', icon: 'person' },
		{ id: 'appearance', label: 'Appearance', icon: 'sun' },
		{ id: 'security', label: 'Sign-in and security', icon: 'lock' },
		{ id: 'storage', label: 'Storage', icon: 'storage' }
	];
	const active = $derived(activeSection(page.url, sections));

	/** "Firefox on Linux" from a user-agent string; the raw string stays available as a tooltip. */
	function describeDevice(userAgent: string | null): string {
		if (!userAgent) return 'Unknown device';
		const browser = /Edg\//.test(userAgent)
			? 'Edge'
			: /Firefox\//.test(userAgent)
				? 'Firefox'
				: /Chrome\//.test(userAgent)
					? 'Chrome'
					: /Safari\//.test(userAgent)
						? 'Safari'
						: 'A browser';
		const system = /Android/.test(userAgent)
			? 'Android'
			: /iPhone|iPad/.test(userAgent)
				? 'iOS'
				: /Windows/.test(userAgent)
					? 'Windows'
					: /Mac OS X/.test(userAgent)
						? 'macOS'
						: /Linux/.test(userAgent)
							? 'Linux'
							: null;
		return system ? `${browser} on ${system}` : browser;
	}
</script>

<svelte:head>
	<title>Your account · Kernic</title>
</svelte:head>

<AppShell
	destinations={[projectsDestination(false), workspacesDestination(false)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<span class="where">Your account</span>
	{/snippet}

	<SectionedPage heading="Your account" {sections} {active}>
		{#snippet lede()}
			{data.account.email}{data.account.isAdmin ? ' · Administrator' : ''}
		{/snippet}

		{#if active === 'profile'}
			<SettingsGroup
				title="Name"
				description="Shown on your checkpoints and to the people you share a workspace with."
			>
				<form method="POST" action="?/name&section=profile" use:enhance>
					<div class="field">
						<label for="displayName">Your name</label>
						<input
							class="input"
							id="displayName"
							name="displayName"
							required
							maxlength="80"
							autocomplete="name"
							value={data.account.displayName}
						/>
					</div>
					{#if messageFor('name')}<p class="field-error" role="alert">{messageFor('name')}</p>{/if}
					<div class="row">
						<button class="button primary">Save name</button>
						{#if savedBy('name')}<span class="saved" role="status">Saved</span>{/if}
					</div>
				</form>
			</SettingsGroup>
			<SettingsGroup
				title="Email address"
				description="You sign in with it. It cannot be changed here yet; an administrator of this server can help."
			>
				<p class="value">{data.account.email}</p>
			</SettingsGroup>
		{:else if active === 'appearance'}
			<AppearanceSettings initial={data.appearance} />
		{:else if active === 'security'}
			<SettingsGroup
				title="Password"
				description="At least 10 characters. Changing it signs out your other sessions."
			>
				<form
					method="POST"
					action="?/password&section=security"
					use:enhance={() =>
						async ({ update }) =>
							update({ reset: true })}
				>
					<!-- Lets password managers attach the new password to the right account. -->
					<input type="hidden" name="username" autocomplete="username" value={data.account.email} />
					<div class="field">
						<label for="currentPassword">Current password</label>
						<input
							class="input"
							id="currentPassword"
							name="currentPassword"
							type="password"
							required
							autocomplete="current-password"
						/>
					</div>
					<div class="field">
						<label for="newPassword">New password</label>
						<input
							class="input"
							id="newPassword"
							name="newPassword"
							type="password"
							required
							minlength="10"
							autocomplete="new-password"
							aria-describedby="newPassword-hint"
						/>
						<p class="hint" id="newPassword-hint">At least 10 characters.</p>
					</div>
					<div class="field">
						<label for="repeatPassword">New password, again</label>
						<input
							class="input"
							id="repeatPassword"
							name="repeatPassword"
							type="password"
							required
							autocomplete="new-password"
						/>
					</div>
					{#if messageFor('password')}
						<p class="field-error" role="alert">{messageFor('password')}</p>
					{/if}
					<div class="row">
						<button class="button primary">Change password</button>
						{#if savedBy('password')}
							<span class="saved" role="status">
								Password changed. Your other sessions were signed out.
							</span>
						{/if}
					</div>
				</form>
			</SettingsGroup>
			<SettingsGroup
				title="Where you are signed in"
				description="Sign out a session you do not recognise, then change your password."
			>
				<ul class="sessions">
					{#each data.sessions as session (session.id)}
						<li>
							<div>
								<span class="device" title={session.userAgent}>
									{describeDevice(session.userAgent)}
									{#if session.current}<span class="tag">This session</span>{/if}
								</span>
								<span class="meta">
									Signed in <time
										datetime={session.createdAt.toISOString()}
										title={formatExact(session.createdAt)}>{formatWhen(session.createdAt)}</time
									>
									· last used
									<time
										datetime={session.lastSeenAt.toISOString()}
										title={formatExact(session.lastSeenAt)}>{formatWhen(session.lastSeenAt)}</time
									>
								</span>
							</div>
							{#if !session.current}
								<form method="POST" action="?/revoke&section=security" use:enhance>
									<input type="hidden" name="sessionId" value={session.id} />
									<button
										class="button small"
										aria-label="Sign out {describeDevice(session.userAgent)}"
									>
										Sign out
									</button>
								</form>
							{/if}
						</li>
					{/each}
				</ul>
			</SettingsGroup>
		{:else}
			<SettingsGroup
				title="Storage"
				description="Counts the files of your projects. Their version history and rendered pages are kept in addition. The limits are set by whoever runs this server."
			>
				{#each data.workspaces as workspace (workspace.id)}
					{@const share = Math.min(100, (workspace.usage.bytes / workspace.usage.maxBytes) * 100)}
					<div class="usage">
						<p>
							<strong>{workspace.kind === 'personal' ? 'Personal' : workspace.name}</strong>
							<span>
								{formatBytes(workspace.usage.bytes)} of {formatBytes(workspace.usage.maxBytes)} ·
								{workspace.usage.projects} of {workspace.usage.maxProjects} projects
							</span>
						</p>
						<meter
							min="0"
							max="100"
							high="85"
							value={share}
							aria-label="Storage used in {workspace.kind === 'personal'
								? 'your personal workspace'
								: workspace.name}"
						></meter>
					</div>
				{/each}
			</SettingsGroup>
		{/if}
	</SectionedPage>
</AppShell>

<style>
	.usage {
		display: grid;
		gap: var(--s-1);
	}

	.usage p {
		display: flex;
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--s-1) var(--s-3);
		font-size: var(--t-ui);
	}

	.usage span,
	.hint {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.where {
		font-weight: 600;
	}

	.sessions {
		margin: 0;
		padding: 0;
		list-style: none;
		border-top: 1px solid var(--rule);
	}

	.sessions li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		padding: var(--s-3) 0;
		border-bottom: 1px solid var(--rule);
	}

	.sessions li > div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.device {
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
		color: var(--accent);
		font-size: var(--t-meta);
		font-weight: 500;
	}

	.value {
		font-weight: 500;
		overflow-wrap: anywhere;
	}
</style>
