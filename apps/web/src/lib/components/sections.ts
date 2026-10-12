import type { IconName } from './Icon.svelte';

/** One group of settings on a page that shows a group at a time. */
export interface PageSection {
	id: string;
	label: string;
	icon: IconName;
}

/**
 * Which section a page shows: the one its address names, or else the first.
 * Forms on such a page name their section in their action (`?/save&section=…`),
 * so that the page is still on it after they were submitted, with or without
 * JavaScript.
 */
export function activeSection(
	url: { searchParams: Pick<URLSearchParams, 'get'> },
	sections: readonly PageSection[]
): string {
	const named = url.searchParams.get('section');
	return sections.find((section) => section.id === named)?.id ?? sections[0]!.id;
}
