<script lang="ts">
	/**
	 * A small modal that asks for one value (a file name) or for confirmation.
	 * `onsubmit` may throw; its message is shown and the dialog stays open, so
	 * the user can correct the input.
	 */
	let {
		open = $bindable(false),
		title,
		description,
		label,
		initialValue = '',
		confirmLabel,
		danger = false,
		onsubmit
	}: {
		open: boolean;
		title: string;
		description?: string;
		/** Label of the text field. Omit for a plain confirmation. */
		label?: string;
		initialValue?: string;
		confirmLabel: string;
		danger?: boolean;
		onsubmit: (value: string) => Promise<void>;
	} = $props();

	const id = $props.id();
	let dialog: HTMLDialogElement;
	let input = $state<HTMLInputElement>();
	let value = $state('');
	let error = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (open && !dialog.open) {
			value = initialValue;
			error = null;
			dialog.showModal();
			// Select the name without its extension, as file managers do.
			const dot = initialValue.lastIndexOf('.');
			const slash = initialValue.lastIndexOf('/');
			input?.setSelectionRange(slash + 1, dot > slash ? dot : initialValue.length);
		}
		if (!open && dialog.open) dialog.close();
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		error = null;
		try {
			await onsubmit(value.trim());
			open = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'That did not work. Try again.';
		} finally {
			busy = false;
		}
	}
</script>

<dialog bind:this={dialog} onclose={() => (open = false)} aria-labelledby="{id}-title">
	<form onsubmit={submit}>
		<h2 id="{id}-title">{title}</h2>
		{#if description}<p class="description">{description}</p>{/if}

		{#if label}
			<div class="field">
				<label for="{id}-input">{label}</label>
				<input
					bind:this={input}
					class="input"
					id="{id}-input"
					bind:value
					required
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					aria-invalid={error ? 'true' : undefined}
				/>
			</div>
		{/if}

		{#if error}<p class="form-error" role="alert">{error}</p>{/if}

		<div class="actions">
			<button class="button" type="button" onclick={() => (open = false)}>Cancel</button>
			<button class="button {danger ? 'danger' : 'primary'}" disabled={busy}>{confirmLabel}</button>
		</div>
	</form>
</dialog>

<style>
	dialog {
		width: min(26rem, calc(100vw - 2rem));
		padding: var(--s-4);
		border: 1px solid var(--rule);
		border-radius: var(--radius-float);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-float);
	}

	dialog::backdrop {
		background: var(--scrim);
	}

	form {
		display: grid;
		gap: var(--s-3);
	}

	.description {
		color: var(--ink-2);
		font-size: var(--t-ui);
		overflow-wrap: anywhere;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
		margin-top: var(--s-1);
	}
</style>
