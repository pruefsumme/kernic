import { KERNIC_WORKER_TOKEN, KERNIC_WORKER_URL } from '$app/env/private';

/**
 * Font families the compile worker offers to every document: those built into
 * the compiler and those installed in the worker. Fonts uploaded into a
 * project are not part of this list.
 */

const REFRESH_MS = 10 * 60_000;
let cached: { families: string[]; at: number } | null = null;

export async function listFontFamilies(): Promise<string[]> {
	if (cached && Date.now() - cached.at < REFRESH_MS) return cached.families;
	try {
		const response = await fetch(`${KERNIC_WORKER_URL}/fonts`, {
			headers: { authorization: `Bearer ${KERNIC_WORKER_TOKEN}` },
			signal: AbortSignal.timeout(30_000)
		});
		if (!response.ok) return cached?.families ?? [];
		const body = (await response.json()) as { families?: unknown };
		const families = Array.isArray(body.families)
			? body.families
					.filter((family): family is string => typeof family === 'string')
					.slice(0, 5000)
			: [];
		cached = { families, at: Date.now() };
		return families;
	} catch {
		// The list only helps while typing; without the worker there is none.
		return cached?.families ?? [];
	}
}
