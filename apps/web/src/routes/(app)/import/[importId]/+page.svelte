<script lang="ts">
	import { enhance } from '$app/forms';
	import { refreshAll } from '$app/navigation';
	import AppShell from '#lib/components/AppShell.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { helpDestination, projectsDestination } from '#lib/components/rail.ts';
	import { formatBytes } from '#lib/format.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const pending = $derived(data.import);
	const report = $derived(pending.report);
	let importing = $state(false);

	// While the archive is being checked, ask for the result until it is there.
	$effect(() => {
		if (pending.status !== 'analyzing') return;
		const timer = setInterval(async () => {
			const response = await fetch(`/api/imports/${pending.id}`).catch(() => null);
			const body = await response?.json().catch(() => null);
			if (!response?.ok || body?.status !== 'analyzing') {
				clearInterval(timer);
				await refreshAll();
			}
		}, 700);
		return () => clearInterval(timer);
	});

	const errors = $derived(
		report?.compile.status === 'failed'
			? report.compile.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
			: []
	);
	const warnings = $derived(
		report && report.compile.status !== 'unavailable'
			? report.compile.diagnostics.filter((diagnostic) => diagnostic.severity === 'warning')
			: []
	);
	const count = (number: number, one: string, many: string) =>
		number === 1 ? `1 ${one}` : `${number} ${many}`;
	const location = (diagnostic: { path: string | null; line: number | null }) =>
		diagnostic.path
			? `${diagnostic.path}${diagnostic.line ? `, line ${diagnostic.line}` : ''}`
			: '';
</script>

<svelte:head>
	<title>Import {pending.sourceName} · Kernic</title>
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
		{#if pending.status === 'analyzing'}
			<div class="state" role="status">
				<span class="spinner" aria-hidden="true"></span>
				<div>
					<h1>Checking {pending.sourceName}…</h1>
					<p>Unpacking the archive, scanning its files and compiling the document once.</p>
				</div>
			</div>
		{:else if pending.status === 'rejected'}
			<div class="state">
				<div>
					<h1>{pending.sourceName} cannot be imported</h1>
					<p class="form-error" role="alert">{pending.error}</p>
					<p>Nothing was created, and nothing from the archive was kept on the server.</p>
					<a class="button primary" href="/import">Choose another archive</a>
				</div>
			</div>
		{:else if report}
			<div class="heading">
				<h1>Check before importing</h1>
				<p class="lede">
					{pending.sourceName} · {count(report.fileCount, 'file', 'files')} ·
					{formatBytes(report.totalBytes)}. Nothing has been created yet.
				</p>
			</div>

			<div class="columns">
				<div class="findings">
					<section>
						{#if report.compile.status === 'ok'}
							<h2 class="good"><Icon name="check" size={18} /> Compiles</h2>
							<p>
								{report.suggestedEntry} compiles to {count(
									report.compile.pageCount,
									'page',
									'pages'
								)}
								on this server{warnings.length > 0
									? `, with ${count(warnings.length, 'warning', 'warnings')}`
									: ''}.
							</p>
						{:else if report.compile.status === 'failed'}
							<h2 class="bad">
								<Icon name="issues" size={18} /> Does not compile yet ({count(
									errors.length,
									'error',
									'errors'
								)})
							</h2>
							<p>
								{report.suggestedEntry} was compiled as the main file. You can import the project anyway
								and fix this in the editor.
							</p>
							<ul class="list">
								{#each errors as diagnostic, index (index)}
									<li>
										{diagnostic.message}
										{#if location(diagnostic)}<span class="path">{location(diagnostic)}</span>{/if}
									</li>
								{/each}
							</ul>
						{:else}
							<h2 class="warn"><Icon name="issues" size={18} /> Not test-compiled</h2>
							<p>
								{report.compile.message} The files were still checked, and you can import the project.
							</p>
						{/if}
						{#if warnings.length > 0}
							<ul class="list">
								{#each warnings as diagnostic, index (index)}
									<li>
										Warning: {diagnostic.message}
										{#if location(diagnostic)}<span class="path">{location(diagnostic)}</span>{/if}
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					<section>
						{#if report.packages.length === 0}
							<h2 class="good"><Icon name="check" size={18} /> No packages needed</h2>
							<p>The project does not import Typst packages.</p>
						{:else}
							<h2 class="warn">
								<Icon name="issues" size={18} />
								{count(report.packages.length, 'package', 'packages')} needed
							</h2>
							<p>
								This server compiles without network access and has no packages installed yet, so
								files that import these will not compile here.
							</p>
							<ul class="list">
								{#each report.packages as use (use.spec)}
									<li>
										<code>{use.spec}</code>
										<span class="path">used in {use.usedIn.join(', ')}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					<section>
						{#if report.missing.length === 0}
							<h2 class="good"><Icon name="check" size={18} /> No missing files</h2>
							<p>Every file the sources refer to is in the archive.</p>
						{:else}
							<h2 class="warn">
								<Icon name="issues" size={18} />
								{count(report.missing.length, 'referenced file is', 'referenced files are')} not in the
								archive
							</h2>
							<p>
								Add {report.missing.length === 1 ? 'it' : 'them'} to the archive and check again, or upload
								{report.missing.length === 1 ? 'it' : 'them'} in the editor after importing.
							</p>
							<ul class="list">
								{#each report.missing as reference, index (index)}
									<li>
										<code>{reference.target}</code>
										<span class="path">referenced from {reference.referencedFrom}</span>
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					{#if report.skippedCount > 0}
						<section>
							<h2 class="warn">
								<Icon name="issues" size={18} />
								{count(report.skippedCount, 'entry', 'entries')} will be left out
							</h2>
							<ul class="list">
								{#each report.skipped as entry (entry.path)}
									<li>
										<code>{entry.path}</code>
										<span class="path">{entry.reason}</span>
									</li>
								{/each}
							</ul>
							{#if report.skippedCount > report.skipped.length}
								<p>…and {report.skippedCount - report.skipped.length} more of the same kinds.</p>
							{/if}
						</section>
					{/if}

					<section>
						<h2>What is kept</h2>
						<p>
							File names and folders are imported exactly as in the archive{report.strippedFolder
								? `, except that the single enclosing folder “${report.strippedFolder}” is removed`
								: ''}.
							{#if report.fontFiles.length > 0}
								The {count(report.fontFiles.length, 'font file', 'font files')} in the archive will be
								available to the document.
							{/if}
						</p>
					</section>
				</div>

				<aside>
					{#if report.compile.status === 'ok'}
						<img
							class="preview"
							src="/api/imports/{pending.id}/preview"
							alt="First page of the document"
						/>
					{/if}

					<form
						method="POST"
						action="?/confirm"
						use:enhance={() => {
							importing = true;
							return async ({ update }) => {
								await update();
								importing = false;
							};
						}}
					>
						<div class="field">
							<label for="name">Project name</label>
							<input
								class="input"
								id="name"
								name="name"
								required
								maxlength="120"
								autocomplete="off"
								value={report.suggestedName}
							/>
						</div>
						<div class="field">
							<label for="entryPath">Main file</label>
							<select class="input" id="entryPath" name="entryPath">
								{#each report.typstFiles as path (path)}
									<option value={path} selected={path === report.suggestedEntry}>{path}</option>
								{/each}
							</select>
						</div>
						{#if form?.message}<p class="form-error" role="alert">{form.message}</p>{/if}
						<button class="button primary" disabled={importing}>
							{importing
								? 'Importing…'
								: report.compile.status === 'failed'
									? 'Import anyway'
									: 'Import project'}
						</button>
					</form>
					<form method="POST" action="?/cancel" use:enhance>
						<button class="button quiet">Cancel and discard the upload</button>
					</form>
				</aside>
			</div>
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
		max-width: 64rem;
		margin: 0 auto;
		padding: var(--s-6) var(--s-5) var(--s-7);
	}

	.lede {
		margin-top: var(--s-2);
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.state {
		display: flex;
		gap: var(--s-4);
		max-width: 38rem;
	}

	.state > div {
		display: grid;
		gap: var(--s-3);
		justify-items: start;
	}

	.state p:not(.form-error) {
		color: var(--ink-2);
	}

	.state h1 {
		overflow-wrap: anywhere;
	}

	.spinner {
		flex: none;
		width: 1.25rem;
		height: 1.25rem;
		margin-top: 0.4rem;
		border: 2px solid var(--rule);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			rotate: 360deg;
		}
	}

	.columns {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 19rem;
		gap: var(--s-6);
		align-items: start;
	}

	section {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-4) 0;
		border-top: 1px solid var(--rule);
	}

	section p {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	h2 {
		display: flex;
		align-items: center;
		gap: var(--s-2);
	}

	h2.bad :global(svg) {
		color: var(--error);
	}

	h2.warn :global(svg) {
		color: var(--warning);
	}

	h2.good :global(svg) {
		color: var(--ink-2);
	}

	.list {
		display: grid;
		gap: var(--s-1);
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: var(--t-ui);
	}

	.list li {
		padding: var(--s-2) var(--s-3);
		border-left: 2px solid var(--rule);
		overflow-wrap: anywhere;
	}

	.path {
		display: block;
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	aside {
		position: sticky;
		top: var(--s-5);
		display: grid;
		gap: var(--s-4);
	}

	.preview {
		display: block;
		width: 100%;
		height: auto;
		border: 1px solid var(--rule);
		background: #fff;
	}

	aside form {
		display: grid;
		gap: var(--s-3);
		justify-items: start;
	}

	aside .field {
		width: 100%;
	}

	@media (max-width: 800px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}

		.columns {
			grid-template-columns: minmax(0, 1fr);
		}

		/* The decision comes first on a narrow screen; the details follow. */
		aside {
			position: static;
			order: -1;
		}

		.preview {
			max-width: 14rem;
		}
	}
</style>
