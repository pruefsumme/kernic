import { listAuditEvents } from '#lib/server/audit.ts';
import { requireAdmin } from '#lib/server/http.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	requireAdmin(event);
	return { events: await listAuditEvents() };
};
