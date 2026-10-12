<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '#lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
</script>

<svelte:head>
	<title>New shared workspace · Kernic</title>
</svelte:head>

<div class="page">
	<header>
		<span class="badge"><Icon name="people" size={22} /></span>
		<div>
			<h1>New shared workspace</h1>
			<p class="lede">For working on the same projects with other people.</p>
		</div>
	</header>

	<ol class="how">
		<li>You become its owner.</li>
		<li>You let others in with a link, as viewers or editors.</li>
		<li>
			Projects created in it, or moved into it, can be opened by everyone in it. Projects in your
			personal workspace stay yours alone.
		</li>
	</ol>

	<form method="POST" use:enhance>
		<div class="field">
			<label for="name">Name</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				class="input"
				id="name"
				name="name"
				required
				maxlength="80"
				autocomplete="off"
				autofocus
				placeholder="For example: Thesis group"
				value={form?.name ?? ''}
				aria-invalid={form?.message ? 'true' : undefined}
			/>
		</div>
		{#if form?.message}<p class="form-error" role="alert">{form.message}</p>{/if}
		<div class="row">
			<button class="button primary">Create workspace</button>
			<a class="button" href="/workspaces">Cancel</a>
		</div>
	</form>
</div>

<style>
	.page {
		display: grid;
		gap: var(--s-5);
		max-width: 38rem;
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
		background: var(--ink);
		color: var(--surface);
	}

	.lede {
		color: var(--ink-2);
	}

	.how {
		display: grid;
		gap: var(--s-2);
		margin: 0;
		padding-left: 1.25rem;
		color: var(--ink-2);
		font-size: var(--t-ui);
	}

	form {
		display: grid;
		gap: var(--s-3);
	}

	.field {
		max-width: 26rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	@media (max-width: 800px) {
		.page {
			padding: var(--s-4) var(--s-3) var(--s-6);
		}
	}
</style>
