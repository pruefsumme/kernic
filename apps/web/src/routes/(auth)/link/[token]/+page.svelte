<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let submitting = $state(false);
	const invite = $derived(data.link.kind === 'invite');
</script>

<svelte:head>
	<title>{invite ? 'Create your account' : 'Choose a new password'} · Kernic</title>
</svelte:head>

<div>
	<h1>{invite ? 'Create your account' : 'Choose a new password'}</h1>
	<p class="lede">
		{#if invite}
			You were invited to Kernic as <strong>{data.link.email}</strong>. Choose how you appear to
			others and a password.
		{:else}
			For the account <strong>{data.link.email}</strong>. After this you are signed out everywhere
			else.
		{/if}
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
	{#if form?.message}
		<p class="form-error" role="alert">{form.message}</p>
	{/if}

	<input type="hidden" name="username" autocomplete="username" value={data.link.email} />

	{#if invite}
		<div class="field">
			<label for="displayName">Your name</label>
			<input
				class="input"
				id="displayName"
				name="displayName"
				required
				maxlength="80"
				autocomplete="name"
				value={form?.displayName ?? ''}
			/>
		</div>
	{/if}

	<div class="field">
		<label for="password">{invite ? 'Password' : 'New password'}</label>
		<input
			class="input"
			id="password"
			name="password"
			type="password"
			required
			minlength="10"
			autocomplete="new-password"
			aria-describedby="password-hint"
		/>
		<p class="hint" id="password-hint">At least 10 characters.</p>
	</div>

	<div class="field">
		<label for="repeatPassword">{invite ? 'Password' : 'New password'}, again</label>
		<input
			class="input"
			id="repeatPassword"
			name="repeatPassword"
			type="password"
			required
			autocomplete="new-password"
		/>
	</div>

	<button class="button primary" disabled={submitting}>
		{submitting ? 'One moment…' : invite ? 'Create account' : 'Set password and sign in'}
	</button>
</form>
