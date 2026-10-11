import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE, parseAppearance, serializeAppearance } from './appearance.ts';

describe('appearance cookie', () => {
	it('round-trips a choice', () => {
		const choice = { theme: 'dark' as const, hue: 155, pages: 'white' as const };
		expect(parseAppearance(serializeAppearance(choice))).toEqual(choice);
		expect(serializeAppearance({ theme: 'light', hue: 365.4, pages: 'dim' })).toBe('light.5');
		expect(serializeAppearance({ theme: 'system', hue: -10, pages: 'white' })).toBe(
			'system.350.white'
		);
		// A cookie from before the page setting existed.
		expect(parseAppearance('dark.120')).toEqual({ theme: 'dark', hue: 120, pages: 'dim' });
	});

	it('falls back to the default for anything it does not expect', () => {
		for (const value of [
			undefined,
			null,
			'',
			'dark',
			'dark.',
			'neon.120',
			'dark.999',
			'dark.12;x',
			'"><script>'
		]) {
			const parsed = parseAppearance(value);
			expect(['system', 'light', 'dark']).toContain(parsed.theme);
			expect(parsed.hue).toBeGreaterThanOrEqual(0);
			expect(parsed.hue).toBeLessThan(360);
		}
		expect(parseAppearance('nonsense')).toEqual(DEFAULT_APPEARANCE);
	});
});
