/**
 * How the app looks for one browser: light or dark, and the hue of the accent.
 * Kept in a cookie so that the server can render the page in the right colours
 * from its first byte, without a flash of the other theme.
 */

export type Theme = 'system' | 'light' | 'dark';

export interface Appearance {
	theme: Theme;
	/** Hue of the accent colour, 0 to 359. */
	hue: number;
	/** Whether rendered pages are shown a little dimmer in the dark theme, or plain white. */
	pages: 'dim' | 'white';
}

export const APPEARANCE_COOKIE = 'kernic_look';
export const DEFAULT_APPEARANCE: Appearance = { theme: 'system', hue: 264, pages: 'dim' };

/** Accent colours offered by name; any other hue can be set with the slider. */
export const ACCENT_PRESETS: { name: string; hue: number }[] = [
	{ name: 'Blue', hue: 264 },
	{ name: 'Violet', hue: 300 },
	{ name: 'Rose', hue: 355 },
	{ name: 'Orange', hue: 50 },
	{ name: 'Olive', hue: 110 },
	{ name: 'Green', hue: 155 },
	{ name: 'Teal', hue: 195 },
	{ name: 'Sky', hue: 235 }
];

const THEMES: Theme[] = ['system', 'light', 'dark'];

/** Reads the cookie's value; anything unexpected gives the default. */
export function parseAppearance(value: string | undefined | null): Appearance {
	const match = /^(system|light|dark)\.(\d{1,3})(\.white)?$/.exec(value ?? '');
	if (!match) return DEFAULT_APPEARANCE;
	const hue = Number(match[2]);
	return {
		theme: THEMES.includes(match[1] as Theme) ? (match[1] as Theme) : DEFAULT_APPEARANCE.theme,
		hue: hue >= 0 && hue < 360 ? hue : DEFAULT_APPEARANCE.hue,
		pages: match[3] ? 'white' : 'dim'
	};
}

export const serializeAppearance = ({ theme, hue, pages }: Appearance) =>
	`${theme}.${Math.round(((hue % 360) + 360) % 360)}${pages === 'white' ? '.white' : ''}`;

/** Applies the look to the page that is open and remembers it for the next ones. */
export function applyAppearance(appearance: Appearance): void {
	const root = document.documentElement;
	root.dataset.theme = appearance.theme;
	root.dataset.pages = appearance.pages;
	root.style.setProperty('--accent-h', String(appearance.hue));
	const secure = location.protocol === 'https:' ? '; Secure' : '';
	document.cookie = `${APPEARANCE_COOKIE}=${serializeAppearance(appearance)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}
