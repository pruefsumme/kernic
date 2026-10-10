<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · Kernic</title>
</svelte:head>

<div>
	<h1>{page.status === 404 ? 'This link does not work' : 'Something went wrong'}</h1>
	<p class="lede">{page.error?.message}</p>
</div>
<p><a class="button primary" href="/login">Go to sign in</a></p>
