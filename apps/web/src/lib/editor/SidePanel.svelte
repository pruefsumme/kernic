<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';

	/** The panel attached to the rail. One panel is open at a time. */
	let {
		title,
		onclose,
		actions,
		children
	}: { title: string; onclose: () => void; actions?: Snippet; children: Snippet } = $props();
</script>

<aside aria-label={title}>
	<header>
		<h2>{title}</h2>
		<div class="actions">
			{@render actions?.()}
			<button class="button quiet small" type="button" aria-label="Close {title}" onclick={onclose}>
				<Icon name="close" size={16} />
			</button>
		</div>
	</header>
	<div class="content">{@render children()}</div>
</aside>

<style>
	aside {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		flex: none;
		width: 17rem;
		border-right: 1px solid var(--rule);
		background: var(--ground);
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
		min-height: 2.5rem;
		padding: 0 var(--s-1) 0 var(--s-3);
	}

	h2 {
		font-size: var(--t-ui);
		font-weight: 600;
	}

	.actions {
		display: flex;
		align-items: center;
	}

	.content {
		overflow-y: auto;
	}

	/* Below the two-pane width the panel covers the content instead of squeezing it. */
	@media (max-width: 900px) {
		aside {
			position: absolute;
			inset: 0 auto 0 0;
			z-index: 5;
			width: min(20rem, 100%);
			box-shadow: var(--shadow-float);
		}
	}
</style>
