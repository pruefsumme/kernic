<script lang="ts">
	import {
		DEFAULT_PDF_OPTIONS,
		parsePdfOptions,
		PDF_STANDARDS,
		PdfOptionsError,
		standardById,
		type PdfOptions
	} from '#lib/pdf-options.ts';
	import type { EditorSession } from './session.svelte.ts';

	/**
	 * Export to PDF with a choice of standard, pages and accessibility tags.
	 * The plain "PDF" entry of the Export menu needs none of this.
	 */
	let {
		open = $bindable(false),
		session,
		projectId,
		ondownload
	}: {
		open: boolean;
		session: EditorSession;
		projectId: string;
		/** Called with the URL of the finished PDF. */
		ondownload: (url: string) => void;
	} = $props();

	const id = $props.id();
	const storageKey = $derived(`kernic.export.${projectId}`);
	let dialog: HTMLDialogElement;
	let standard = $state('');
	let pages = $state('');
	let tagged = $state(true);
	let problem = $state<string | null>(null);

	const chosen = $derived(standardById(standard || null));
	const pageCount = $derived(session.render?.pages.length ?? null);
	const selectsPages = $derived(pages.trim() !== '');
	// Tags are fixed by the other choices in two cases; show what will happen.
	const tagsOn = $derived(chosen?.needsTags ? true : selectsPages ? false : tagged);

	$effect(() => {
		if (open && !dialog.open) {
			problem = null;
			pages = '';
			try {
				const stored = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as {
					standard?: unknown;
					tagged?: unknown;
				} | null;
				standard =
					typeof stored?.standard === 'string' && standardById(stored.standard)
						? stored.standard
						: '';
				tagged = stored?.tagged !== false;
			} catch {
				standard = '';
				tagged = DEFAULT_PDF_OPTIONS.tagged;
			}
			dialog.showModal();
		}
		if (!open && dialog.open) dialog.close();
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		problem = null;

		let options: PdfOptions;
		try {
			options = parsePdfOptions({
				standard: standard || null,
				pages: chosen?.needsTags ? null : pages,
				tagged: tagsOn
			});
		} catch (cause) {
			if (!(cause instanceof PdfOptionsError)) throw cause;
			problem = cause.message;
			return;
		}
		if (options.pages !== null && pageCount !== null) {
			const beyond = options.pages.split(',').find((range) => parseInt(range, 10) > pageCount);
			if (beyond) {
				problem = `The document has ${pageCount === 1 ? '1 page' : `${pageCount} pages`}; “${beyond}” is beyond its end.`;
				return;
			}
		}

		const url = await session.exportPdf(options);
		if (url) {
			localStorage.setItem(storageKey, JSON.stringify({ standard, tagged }));
			open = false;
			ondownload(url);
		} else {
			// Shown here rather than behind the dialog.
			problem = session.exportError;
			session.exportError = null;
		}
	}
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-labelledby="{id}-title">
	<form onsubmit={submit}>
		<h2 id="{id}-title">Export PDF</h2>

		<div class="field">
			<label for="{id}-standard">Standard</label>
			<select class="input" id="{id}-standard" bind:value={standard}>
				<option value="">Regular PDF</option>
				{#each PDF_STANDARDS as option (option.id)}
					<option value={option.id}>{option.name} · {option.purpose}</option>
				{/each}
			</select>
			<p class="hint">
				{#if chosen}
					The export fails with the reason if the document does not meet {chosen.name}.
				{:else}
					Choose a standard if the recipient asks for one, for example PDF/A for a thesis.
				{/if}
			</p>
		</div>

		<div class="field">
			<label for="{id}-pages">Pages</label>
			<input
				class="input"
				id="{id}-pages"
				bind:value={pages}
				placeholder="All pages"
				inputmode="text"
				autocomplete="off"
				spellcheck="false"
				disabled={chosen?.needsTags}
				aria-describedby="{id}-pages-hint"
			/>
			<p class="hint" id="{id}-pages-hint">
				{#if chosen?.needsTags}
					{chosen.name} is always exported in full.
				{:else}
					For example 1-3, 5, 8-.
					{#if pageCount !== null}
						The document has {pageCount === 1 ? '1 page' : `${pageCount} pages`}.
					{/if}
				{/if}
			</p>
		</div>

		<label class="check">
			<input
				type="checkbox"
				checked={tagsOn}
				disabled={chosen?.needsTags || selectsPages}
				onchange={(event) => (tagged = event.currentTarget.checked)}
			/>
			<span>
				Accessibility tags
				<small>
					{#if chosen?.needsTags}
						Required by {chosen.name}.
					{:else if selectsPages}
						A selection of pages is exported without tags.
					{:else}
						Let screen readers follow headings, lists and tables. Leaving them out makes the file
						smaller.
					{/if}
				</small>
			</span>
		</label>

		{#if problem}<p class="form-error" role="alert">{problem}</p>{/if}

		<div class="actions">
			<button class="button" type="button" onclick={() => (open = false)}>Cancel</button>
			<button class="button primary" disabled={session.exporting}>
				{session.exporting ? 'Exporting…' : 'Export PDF'}
			</button>
		</div>
	</form>
</dialog>

<style>
	dialog {
		width: min(28rem, calc(100vw - 2rem));
		padding: var(--s-4);
		border: 1px solid var(--rule);
		border-radius: var(--radius-float);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-float);
	}

	dialog::backdrop {
		background: oklch(23% 0.02 250 / 0.35);
	}

	form {
		display: grid;
		gap: var(--s-4);
	}

	.hint {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.check {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--s-2);
		align-items: start;
		font-size: var(--t-ui);
		font-weight: 500;
	}

	.check input {
		width: 1rem;
		height: 1rem;
		margin: 0.15rem 0 0;
		accent-color: var(--accent);
	}

	.check small {
		display: block;
		color: var(--ink-2);
		font-size: var(--t-meta);
		font-weight: 400;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
	}
</style>
