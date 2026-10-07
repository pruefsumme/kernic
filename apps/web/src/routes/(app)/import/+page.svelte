<script lang="ts">
	import { goto } from '$app/navigation';
	import AppShell from '#lib/components/AppShell.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { helpDestination, projectsDestination } from '#lib/components/rail.ts';
	import { formatBytes } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let file = $state<File | null>(null);
	let workspaceId = $state('');
	let uploading = $state(false);
	let error = $state<string | null>(null);
	let dragging = $state(false);
	let input = $state<HTMLInputElement>();

	const tooLarge = $derived(file !== null && file.size > data.maxArchiveBytes);

	function choose(candidate: File | undefined) {
		error = null;
		if (!candidate) return;
		if (!candidate.name.toLowerCase().endsWith('.zip')) {
			error = `“${candidate.name}” is not a ZIP archive. Compress the project folder to a .zip file first.`;
			return;
		}
		file = candidate;
	}

	async function upload(event: SubmitEvent) {
		event.preventDefault();
		if (!file || tooLarge) return;
		uploading = true;
		error = null;

		const query = new URLSearchParams({
			workspace: workspaceId || (data.workspaces[0]?.id ?? ''),
			name: file.name
		});
		try {
			const response = await fetch(`/api/imports?${query}`, {
				method: 'POST',
				headers: { 'content-type': 'application/zip' },
				body: file
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) {
				error = body?.message ?? `The upload failed (${response.status}).`;
				return;
			}
			await goto(`/import/${body.id}`);
		} catch {
			error = 'The upload did not reach the server. Check your connection and try again.';
		} finally {
			uploading = false;
		}
	}
</script>

<svelte:head>
	<title>Import · Kernic</title>
</svelte:head>

<AppShell
	userName={data.user.displayName}
	destinations={[projectsDestination(false)]}
	footer={[helpDestination]}
>
	{#snippet title()}
		<a class="crumb" href="/">Projects</a>
		<span class="where">Import</span>
	{/snippet}

	<div class="page">
		<div>
			<h1>Import a project from a ZIP archive</h1>
			<p class="lede">
				Kernic first checks the archive: it unpacks it aside, looks for missing files and packages,
				and compiles it once. You see the result and decide. Nothing is created until you confirm,
				and your archive is not changed.
			</p>
		</div>

		{#if data.workspaces.length === 0}
			<p class="form-error">
				You have read-only access to every workspace you belong to. Ask a workspace owner for edit
				access to import projects.
			</p>
		{:else}
			<form onsubmit={upload}>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="drop"
					class:dragging
					ondragover={(event) => {
						event.preventDefault();
						dragging = true;
					}}
					ondragleave={() => (dragging = false)}
					ondrop={(event) => {
						event.preventDefault();
						dragging = false;
						choose(event.dataTransfer?.files[0]);
					}}
				>
					{#if file}
						<p class="chosen">
							<Icon name="file" />
							<span>
								<strong>{file.name}</strong>
								<small>{formatBytes(file.size)}</small>
							</span>
						</p>
						<button class="button small" type="button" onclick={() => input?.click()}>
							Choose another file
						</button>
					{:else}
						<p>Drop a .zip file here, or</p>
						<button class="button" type="button" onclick={() => input?.click()}
							>Choose a ZIP file</button
						>
						<p class="hint">Up to {formatBytes(data.maxArchiveBytes)}.</p>
					{/if}
					<input
						bind:this={input}
						type="file"
						accept=".zip,application/zip"
						hidden
						aria-label="ZIP archive"
						onchange={() => choose(input?.files?.[0])}
					/>
				</div>

				{#if tooLarge && file}
					<p class="form-error" role="alert">
						This archive is {formatBytes(file.size)}; this server accepts up to
						{formatBytes(data.maxArchiveBytes)}. Remove large files you do not need, or ask your
						administrator to raise the limit.
					</p>
				{/if}
				{#if error}<p class="form-error" role="alert">{error}</p>{/if}

				{#if data.workspaces.length > 1}
					<div class="field workspace">
						<label for="workspace">Import into workspace</label>
						<select class="input" id="workspace" bind:value={workspaceId}>
							{#each data.workspaces as workspace (workspace.id)}
								<option value={workspace.id}>{workspace.name}</option>
							{/each}
						</select>
					</div>
				{/if}

				<div class="actions">
					<button class="button primary" disabled={!file || tooLarge || uploading}>
						{uploading ? 'Uploading…' : 'Check archive'}
					</button>
					<a class="button quiet" href="/">Cancel</a>
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

	.drop {
		display: grid;
		gap: var(--s-2);
		justify-items: center;
		padding: var(--s-6) var(--s-4);
		border: 1px dashed var(--control-border);
		border-radius: var(--radius);
		background: var(--ground);
		text-align: center;
	}

	.drop.dragging {
		border-color: var(--accent);
		background: var(--accent-soft);
	}

	.hint {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.chosen {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		text-align: left;
	}

	.chosen span {
		display: grid;
		overflow-wrap: anywhere;
	}

	.chosen small {
		color: var(--ink-2);
	}

	.workspace {
		max-width: 22rem;
	}

	.actions {
		display: flex;
		gap: var(--s-2);
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}
	}
</style>
