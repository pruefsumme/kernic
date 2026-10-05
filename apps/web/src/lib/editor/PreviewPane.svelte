<script lang="ts">
	import Icon from '#lib/components/Icon.svelte';
	import type { EditorSession } from './session.svelte.ts';

	let { session, onshowissues }: { session: EditorSession; onshowissues: () => void } = $props();

	const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2];
	/** `null` fits the page to the width of the pane. */
	let zoom = $state<number | null>(null);
	/** Width of each page at 100%, read from the rendered SVG. */
	let naturalWidths = $state<number[]>([]);

	/** Rendered width of the first page, to report the scale that "fit width" results in. */
	let firstPageWidth = $state(0);
	const fitScale = $derived(naturalWidths[0] ? firstPageWidth / naturalWidths[0] : 1);

	function step(direction: 1 | -1) {
		const current = zoom ?? fitScale;
		// The next step above or below the current scale, which in fit mode is arbitrary.
		const next =
			direction === 1
				? ZOOM_STEPS.find((value) => value > current + 0.01)
				: ZOOM_STEPS.findLast((value) => value < current - 0.01);
		zoom = next ?? (direction === 1 ? ZOOM_STEPS.at(-1)! : ZOOM_STEPS[0]!);
	}

	function trackWidth(image: HTMLImageElement) {
		const observer = new ResizeObserver(() => (firstPageWidth = image.clientWidth));
		observer.observe(image);
		return () => observer.disconnect();
	}

	const pages = $derived(
		session.render
			? Array.from({ length: session.render.pageCount }, (_, index) => ({
					number: index + 1,
					url: session.api.pageUrl(session.render!.jobId, index + 1)
				}))
			: []
	);

	const compiling = $derived(session.compile.status === 'compiling');
	const errorLabel = $derived(
		session.errorCount === 1 ? '1 error' : `${session.errorCount} errors`
	);
</script>

<section class="preview" aria-label="Preview">
	<header>
		<div class="status" role="status">
			{#if session.compile.status === 'compiling'}
				<span class="spinner" aria-hidden="true"></span> Compiling…
			{:else if session.compile.status === 'failed'}
				<button class="issue" type="button" onclick={onshowissues}>
					<Icon name="issues" size={16} />
					{errorLabel}
				</button>
				{#if session.render}<span class="note">Showing the last version that compiled</span>{/if}
			{:else if session.compile.status === 'unavailable'}
				<button class="issue" type="button" onclick={onshowissues}>
					<Icon name="issues" size={16} /> Preview unavailable
				</button>
				<button class="button small" type="button" onclick={() => session.requestCompile()}>
					Try again
				</button>
			{:else if session.compile.status === 'done'}
				{#if session.previewIsStale}
					<span class="note">Out of date · updates after saving</span>
				{:else}
					<Icon name="check" size={16} />
					Up to date
					<span class="note">
						· {pages.length === 1 ? '1 page' : `${pages.length} pages`}
						{#if session.warningCount > 0}
							·
							<button class="link" type="button" onclick={onshowissues}>
								{session.warningCount === 1 ? '1 warning' : `${session.warningCount} warnings`}
							</button>
						{/if}
					</span>
				{/if}
			{/if}
		</div>

		<div class="zoom" role="group" aria-label="Zoom">
			<button
				type="button"
				title="Zoom out"
				aria-label="Zoom out"
				disabled={zoom !== null && zoom <= ZOOM_STEPS[0]!}
				onclick={() => step(-1)}
			>
				<Icon name="minus" size={16} />
			</button>
			<span class="level">{Math.round((zoom ?? fitScale) * 100)}%</span>
			<button
				type="button"
				title="Zoom in"
				aria-label="Zoom in"
				disabled={zoom !== null && zoom >= ZOOM_STEPS.at(-1)!}
				onclick={() => step(1)}
			>
				<Icon name="plus" size={16} />
			</button>
			<button type="button" class="fit" aria-pressed={zoom === null} onclick={() => (zoom = null)}>
				Fit width
			</button>
		</div>
	</header>

	<div class="progress" class:active={compiling} aria-hidden="true"></div>

	<div class="canvas" class:stale={session.previewIsStale || session.compile.status === 'failed'}>
		{#if pages.length > 0}
			{#each pages as page, index (page.number)}
				<img
					{@attach index === 0 ? trackWidth : undefined}
					class="sheet"
					src={page.url}
					alt="Page {page.number}"
					style:width={zoom === null
						? undefined
						: `${(naturalWidths[index] ?? naturalWidths[0] ?? 794) * zoom}px`}
					class:fit={zoom === null}
					onload={(event) =>
						(naturalWidths[index] = (event.currentTarget as HTMLImageElement).naturalWidth)}
				/>
			{/each}
		{:else if compiling || session.compile.status === 'idle'}
			<div class="sheet placeholder" aria-hidden="true"></div>
		{:else if session.compile.status === 'failed'}
			<div class="message">
				<h2>Nothing to show yet</h2>
				<p>
					The document has {errorLabel}. Fix {session.errorCount === 1 ? 'it' : 'them'} and the pages
					appear here.
				</p>
				<button class="button" type="button" onclick={onshowissues}>Show issues</button>
			</div>
		{:else if session.compile.status === 'unavailable'}
			<div class="message">
				<h2>The preview could not be rendered</h2>
				<p>{session.compile.message}</p>
				<button class="button" type="button" onclick={() => session.requestCompile()}
					>Try again</button
				>
			</div>
		{/if}
	</div>
</section>

<style>
	.preview {
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr);
		height: 100%;
		min-width: 0;
		background: var(--desk);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		min-height: 2.5rem;
		padding: 0 var(--s-2) 0 var(--s-3);
		border-bottom: 1px solid var(--rule);
		background: var(--surface);
	}

	.status {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
		font-size: var(--t-ui);
		white-space: nowrap;
	}

	.note {
		overflow: hidden;
		color: var(--ink-2);
		text-overflow: ellipsis;
	}

	.issue {
		display: inline-flex;
		align-items: center;
		gap: var(--s-1);
		padding: 0;
		border: 0;
		background: none;
		color: var(--error);
		font: inherit;
		font-weight: 500;
		cursor: pointer;
	}

	.issue:hover,
	.link:hover {
		text-decoration: underline;
	}

	.link {
		padding: 0;
		border: 0;
		background: none;
		color: var(--warning);
		font: inherit;
		cursor: pointer;
	}

	.spinner {
		width: 0.875rem;
		height: 0.875rem;
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

	.zoom {
		display: flex;
		align-items: center;
		flex: none;
		gap: 2px;
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.zoom button {
		display: grid;
		place-items: center;
		min-width: 1.75rem;
		height: 1.75rem;
		padding: 0 var(--s-1);
		border: 0;
		border-radius: var(--radius);
		background: none;
		color: var(--ink-2);
		font: inherit;
		cursor: pointer;
	}

	.zoom button:hover:not(:disabled) {
		background: var(--sunken);
		color: var(--ink);
	}

	.zoom button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.zoom .fit {
		padding: 0 var(--s-2);
	}

	.zoom .fit[aria-pressed='true'] {
		background: var(--accent-soft);
		color: var(--accent);
		font-weight: 500;
	}

	.level {
		min-width: 2.75rem;
		text-align: center;
		font-variant-numeric: tabular-nums;
	}

	/* A hairline that runs while compiling: visible without moving the layout. */
	.progress {
		height: 2px;
		background: transparent;
		overflow: hidden;
	}

	.progress.active::after {
		content: '';
		display: block;
		width: 40%;
		height: 100%;
		background: var(--accent);
		animation: slide 1.1s ease-in-out infinite;
	}

	@keyframes slide {
		from {
			translate: -100%;
		}
		to {
			translate: 250%;
		}
	}

	.canvas {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--s-4);
		padding: var(--s-4);
		overflow: auto;
	}

	.sheet {
		display: block;
		flex: none;
		max-width: none;
		height: auto;
		background: #fff;
		box-shadow:
			0 0 0 1px oklch(20% 0.02 250 / 0.08),
			0 1px 3px oklch(20% 0.02 250 / 0.12);
		transition: opacity 0.15s;
	}

	.sheet.fit {
		width: 100%;
		max-width: 56rem;
	}

	/* Zoomed pages wider than the pane start at its left edge so they can be scrolled to. */
	.canvas:has(.sheet:not(.fit)) {
		align-items: safe center;
	}

	.stale .sheet {
		opacity: 0.6;
	}

	.placeholder {
		width: 100%;
		max-width: 56rem;
		aspect-ratio: 210 / 297;
	}

	.message {
		display: grid;
		gap: var(--s-2);
		justify-items: start;
		max-width: 26rem;
		margin-top: var(--s-6);
		padding: var(--s-4);
		background: var(--surface);
	}

	.message p {
		color: var(--ink-2);
		font-size: var(--t-ui);
	}
</style>
