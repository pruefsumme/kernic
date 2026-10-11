<script lang="ts">
	import { untrack } from 'svelte';
	import {
		ACCENT_PRESETS,
		applyAppearance,
		DEFAULT_APPEARANCE,
		type Appearance,
		type Theme
	} from '#lib/appearance.ts';

	/**
	 * Theme and accent colour for this browser. Every change applies at once;
	 * there is nothing to save or to undo beyond choosing something else.
	 */
	let { initial }: { initial: Appearance } = $props();

	const id = $props.id();
	let theme = $state<Theme>(untrack(() => initial.theme));
	let hue = $state(untrack(() => initial.hue));
	let pages = $state(untrack(() => initial.pages));
	// Whether the colour was set with the slider. A named colour is then not shown as
	// chosen, even while the slider passes over its hue.
	let custom = $state(untrack(() => !ACCENT_PRESETS.some((option) => option.hue === initial.hue)));

	const themes: { value: Theme; label: string; hint: string }[] = [
		{ value: 'system', label: 'System', hint: 'Follows your device' },
		{ value: 'light', label: 'Light', hint: 'Always light' },
		{ value: 'dark', label: 'Dark', hint: 'Always dark' }
	];
	const preset = $derived(ACCENT_PRESETS.find((option) => option.hue === hue));
	const isDefault = $derived(
		theme === DEFAULT_APPEARANCE.theme &&
			hue === DEFAULT_APPEARANCE.hue &&
			pages === DEFAULT_APPEARANCE.pages
	);

	function choose(next: Partial<Appearance>, fromSlider = false) {
		if (next.hue !== undefined) custom = fromSlider;
		theme = next.theme ?? theme;
		hue = next.hue ?? hue;
		pages = next.pages ?? pages;
		applyAppearance({ theme, hue, pages });
	}
</script>

<fieldset>
	<legend>Theme</legend>
	<div class="themes">
		{#each themes as option (option.value)}
			<label class="theme">
				<input
					type="radio"
					name="{id}-theme"
					value={option.value}
					checked={theme === option.value}
					onchange={() => choose({ theme: option.value })}
				/>
				<span class="swatch" data-look={option.value} aria-hidden="true">
					<span></span>
				</span>
				<span class="name">{option.label}</span>
				<span class="hint">{option.hint}</span>
			</label>
		{/each}
	</div>
	<label class="check">
		<input
			type="checkbox"
			checked={pages === 'dim'}
			onchange={(event) => choose({ pages: event.currentTarget.checked ? 'dim' : 'white' })}
		/>
		<span>
			Soften pages in the dark theme
			<small>
				Rendered pages and thumbnails are shown a little dimmer, so that white paper does not glare.
				Exported files are not changed.
			</small>
		</span>
	</label>
</fieldset>

<fieldset>
	<legend>Accent colour</legend>
	<p class="hint">Used for buttons, links, the active item and the selection.</p>
	<div class="accents">
		{#each ACCENT_PRESETS as option (option.hue)}
			<label class="accent" title={option.name}>
				<input
					type="radio"
					name="{id}-accent"
					value={option.hue}
					checked={!custom && hue === option.hue}
					onchange={() => choose({ hue: option.hue })}
				/>
				<span class="dot" style:--h={option.hue} aria-hidden="true"></span>
				<span class="visually-hidden">{option.name}</span>
			</label>
		{/each}
	</div>
	<label class="custom" for="{id}-hue">
		<span>Any other colour</span>
		<input
			id="{id}-hue"
			type="range"
			min="0"
			max="359"
			step="1"
			value={hue}
			oninput={(event) => choose({ hue: Number(event.currentTarget.value) }, true)}
			aria-valuetext={preset && !custom ? preset.name : `Hue ${hue}`}
		/>
	</label>
</fieldset>

<div class="row">
	<span class="hint">Kept in this browser; other devices keep their own look.</span>
	<button
		class="button small"
		type="button"
		disabled={isDefault}
		onclick={() => choose(DEFAULT_APPEARANCE)}
	>
		Back to the default
	</button>
</div>

<style>
	fieldset {
		display: grid;
		gap: var(--s-2);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	legend {
		padding: 0;
		font-size: var(--t-ui);
		font-weight: 600;
	}

	.hint {
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	.themes {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--s-2);
	}

	.theme {
		position: relative;
		display: grid;
		gap: 0.125rem;
		padding: var(--s-2);
		border: 1px solid var(--control-border);
		border-radius: var(--radius-float);
		background: var(--surface);
		cursor: pointer;
		transition:
			border-color var(--fast) var(--ease-out),
			box-shadow var(--fast) var(--ease-out);
	}

	.theme:hover {
		border-color: var(--ink-2);
	}

	.theme:has(input:checked) {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
	}

	.theme:has(input:focus-visible) {
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	input[type='radio'] {
		position: absolute;
		opacity: 0;
		pointer-events: none;
	}

	/* A small picture of the app in that theme: chrome, a surface, a line of accent. */
	.swatch {
		display: grid;
		align-items: end;
		height: 3rem;
		margin-bottom: var(--s-1);
		padding: 0.375rem;
		border: 1px solid var(--rule);
		border-radius: var(--radius);
		background: oklch(97.4% 0.004 255);
	}

	.swatch span {
		display: block;
		height: 1.25rem;
		border-radius: 2px;
		border-bottom: 3px solid oklch(44% 0.15 var(--accent-h));
		background: oklch(100% 0 0);
	}

	.swatch[data-look='dark'] {
		background: oklch(20% 0.012 255);
	}

	.swatch[data-look='dark'] span {
		border-bottom-color: oklch(76% 0.12 var(--accent-h));
		background: oklch(28% 0.014 255);
	}

	.swatch[data-look='system'] {
		background: linear-gradient(105deg, oklch(97.4% 0.004 255) 50%, oklch(20% 0.012 255) 50%);
	}

	.swatch[data-look='system'] span {
		border-bottom-color: oklch(60% 0.14 var(--accent-h));
		background: linear-gradient(105deg, oklch(100% 0 0) 50%, oklch(28% 0.014 255) 50%);
	}

	.name {
		font-size: var(--t-ui);
		font-weight: 500;
	}

	.check {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--s-2);
		align-items: start;
		margin-top: var(--s-1);
		font-size: var(--t-ui);
		font-weight: 500;
		cursor: pointer;
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

	.accents {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
	}

	.accent {
		position: relative;
		display: grid;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		cursor: pointer;
	}

	.dot {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 50%;
		background: light-dark(oklch(48% 0.15 var(--h)), oklch(74% 0.12 var(--h)));
		transition: scale var(--fast) var(--ease-out);
	}

	.accent:hover .dot {
		scale: 1.12;
	}

	.accent:has(input:checked) {
		box-shadow: inset 0 0 0 2px var(--ink);
	}

	.accent:has(input:focus-visible) {
		box-shadow:
			inset 0 0 0 2px var(--ink),
			0 0 0 3px var(--focus-ring);
	}

	.custom {
		display: grid;
		gap: var(--s-1);
		max-width: 22rem;
		margin-top: var(--s-1);
		color: var(--ink-2);
		font-size: var(--t-meta);
	}

	/* The slider's track shows the colours it chooses from. */
	input[type='range'] {
		width: 100%;
		height: 0.75rem;
		margin: 0;
		border: 1px solid var(--rule);
		border-radius: 1rem;
		background: linear-gradient(
			to right in oklch longer hue,
			oklch(62% 0.14 0),
			oklch(62% 0.14 359)
		);
		appearance: none;
		cursor: pointer;
	}

	input[type='range']::-webkit-slider-thumb {
		width: 1.125rem;
		height: 1.125rem;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 1px var(--control-border);
		appearance: none;
	}

	input[type='range']::-moz-range-thumb {
		width: 0.875rem;
		height: 0.875rem;
		border: 2px solid var(--surface);
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 1px var(--control-border);
	}

	input[type='range']:focus-visible {
		outline: none;
		box-shadow: 0 0 0 3px var(--focus-ring);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
	}
</style>
