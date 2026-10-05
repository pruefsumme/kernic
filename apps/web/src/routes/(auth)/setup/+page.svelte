<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
	let submitting = $state(false);

	const errorFor = (field: string) => (form?.field === field ? form.message : null);
</script>

<svelte:head>
	<title>Set up Kernic</title>
</svelte:head>

<div>
	<h1>Set up Kernic</h1>
	<p class="lede">
		Create the administrator account for this server. You can add more people afterwards.
	</p>
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
	<div class="field">
		<label for="setupToken">Setup token</label>
		<input
			class="input mono"
			id="setupToken"
			name="setupToken"
			autocomplete="off"
			autocapitalize="off"
			spellcheck="false"
			required
			aria-invalid={errorFor('setupToken') ? 'true' : undefined}
			aria-describedby="setupToken-hint"
		/>
		{#if errorFor('setupToken')}
			<p class="field-error" role="alert">{errorFor('setupToken')}</p>
		{/if}
		<p class="hint" id="setupToken-hint">
			Printed in the server log when Kernic starts, for example with
			<code>docker compose logs app</code>. It proves you control this server.
		</p>
	</div>

	<div class="field">
		<label for="displayName">Your name</label>
		<input
			class="input"
			id="displayName"
			name="displayName"
			autocomplete="name"
			required
			maxlength="80"
			value={form?.values?.displayName ?? ''}
			aria-invalid={errorFor('displayName') ? 'true' : undefined}
		/>
		{#if errorFor('displayName')}
			<p class="field-error" role="alert">{errorFor('displayName')}</p>
		{/if}
	</div>

	<div class="field">
		<label for="email">Email</label>
		<input
			class="input"
			id="email"
			name="email"
			type="email"
			autocomplete="username"
			required
			value={form?.values?.email ?? ''}
			aria-invalid={errorFor('email') ? 'true' : undefined}
		/>
		{#if errorFor('email')}
			<p class="field-error" role="alert">{errorFor('email')}</p>
		{/if}
	</div>

	<div class="field">
		<label for="password">Password</label>
		<input
			class="input"
			id="password"
			name="password"
			type="password"
			autocomplete="new-password"
			required
			minlength="10"
			aria-invalid={errorFor('password') ? 'true' : undefined}
			aria-describedby="password-hint"
		/>
		{#if errorFor('password')}
			<p class="field-error" role="alert">{errorFor('password')}</p>
		{/if}
		<p class="hint" id="password-hint">At least 10 characters.</p>
	</div>

	<button class="button primary" disabled={submitting}>
		{submitting ? 'Creating account…' : 'Create administrator'}
	</button>
</form>

<style>
	.mono {
		font-family: var(--font-mono);
		font-size: var(--t-ui);
	}
</style>
