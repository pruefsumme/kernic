import type { RequestEvent } from '@sveltejs/kit';
import { sql } from './db/client';

/**
 * The audit log: who did what, when, from where. Entries are only ever added.
 * Recording never fails the action it describes; a failure is logged instead.
 */

export type AuditAction =
	| 'setup.completed'
	| 'sign-in.succeeded'
	| 'sign-in.failed'
	| 'sign-out'
	| 'password.changed'
	| 'password.reset'
	| 'session.revoked'
	| 'account.invited'
	| 'account.created'
	| 'account.disabled'
	| 'account.enabled'
	| 'account.reset-link-created'
	| 'project.deleted'
	| 'project.restored'
	| 'project.imported'
	| 'project.moved'
	| 'workspace.created'
	| 'workspace.deleted'
	| 'workspace.invite-created'
	| 'workspace.member-joined'
	| 'workspace.member-removed'
	| 'workspace.role-changed';

export interface AuditEvent {
	id: number;
	at: Date;
	actorEmail: string | null;
	action: AuditAction;
	subject: string | null;
	address: string | null;
}

export async function recordAudit(
	event: RequestEvent,
	action: AuditAction,
	details: { subject?: string; actor?: { id: string; email: string } | null } = {}
): Promise<void> {
	// `actor` overrides the signed-in user for actions that happen without a session (sign-in).
	const actor = details.actor === undefined ? event.locals.user : details.actor;
	let address: string | null = null;
	try {
		address = event.getClientAddress();
	} catch {
		// not available in every environment
	}

	try {
		await sql`
			INSERT INTO audit_events (actor_id, actor_email, action, subject, address)
			VALUES (${actor?.id ?? null}, ${actor?.email ?? null}, ${action}, ${details.subject ?? null}, ${address})
		`;
	} catch (cause) {
		console.error(`could not record audit event ${action}`, cause);
	}
}

export async function listAuditEvents(limit = 300): Promise<AuditEvent[]> {
	const rows = await sql<
		{
			id: number;
			at: Date;
			actor_email: string | null;
			action: AuditAction;
			subject: string | null;
			address: string | null;
		}[]
	>`
		SELECT id, at, actor_email, action, subject, address
		FROM audit_events
		ORDER BY at DESC, id DESC
		LIMIT ${limit}
	`;
	return rows.map((row) => ({
		id: row.id,
		at: row.at,
		actorEmail: row.actor_email,
		action: row.action,
		subject: row.subject,
		address: row.address
	}));
}
