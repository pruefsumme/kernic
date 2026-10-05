<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in · Kernic</title>
</svelte:head>

<div>
	<h1>Sign in</h1>
	<p class="lede">Use the account your administrator created for you.</p>
</div>

<form
	method="POST"
	use:enhance={() => {
		submitting = true;
		return async ({ update }) => {
			await update();
			submitting = false;
		};
	}}
>
	{#if form?.message}
		<p class="form-error" role="alert">{form.message}</p>
	{/if}

	<div class="field">
		<label for="email">Email</label>
		<input
			class="input"
			id="email"
			name="email"
			type="email"
			autocomplete="username"
			required
			value={form?.email ?? ''}
		/>
	</div>

	<div class="field">
		<label for="password">Password</label>
		<input
			class="input"
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			required
		/>
	</div>

	<button class="button primary" disabled={submitting}>
		{submitting ? 'Signing in…' : 'Sign in'}
	</button>
</form>
