import type { RailItem } from './AppShell.svelte';

/** Rail entries that are the same on every screen. */
export const projectsDestination = (active: boolean): RailItem => ({
	id: 'projects',
	label: 'Projects',
	icon: 'projects',
	href: '/',
	active
});

export const helpDestination: RailItem = {
	id: 'help',
	label: 'Help',
	icon: 'help',
	href: 'https://typst.app/docs/',
	external: true
};
