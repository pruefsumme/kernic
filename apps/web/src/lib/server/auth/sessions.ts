import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db/client';

export const SESSION_COOKIE = 'kernic_session';

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_LIFETIME_MS = 30 * DAY_MS;
/** Sessions used within this window before expiry are extended. */
const RENEWAL_WINDOW_MS = 15 * DAY_MS;
const LAST_SEEN_RESOLUTION_MS = 60 * 60 * 1000;

export interface SessionUser {
	id: string;
	email: string;
	displayName: string;
	isAdmin: boolean;
}

export interface ValidSession {
	user: SessionUser;
	expiresAt: Date;
	/** True when the expiry moved and the cookie should be re-issued. */
	renewed: boolean;
}

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * Creates a session and returns the token for the cookie. Only its hash is
 * stored, so a leaked database does not yield usable sessions.
 */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
	await sql`
		INSERT INTO sessions (token_hash, user_id, expires_at)
		VALUES (${hashToken(token)}, ${userId}, ${expiresAt})
	`;
	return { token, expiresAt };
}

export async function validateSession(token: string): Promise<ValidSession | null> {
	const tokenHash = hashToken(token);
	const [row] = await sql<
		{
			expires_at: Date;
			last_seen_at: Date;
			id: string;
			email: string;
			display_name: string;
			is_admin: boolean;
		}[]
	>`
		SELECT s.expires_at, s.last_seen_at, u.id, u.email, u.display_name, u.is_admin
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ${tokenHash} AND u.disabled_at IS NULL
	`;
	if (!row) return null;

	const now = Date.now();
	if (row.expires_at.getTime() <= now) {
		await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
		return null;
	}

	let expiresAt = row.expires_at;
	const renewed = expiresAt.getTime() - now < RENEWAL_WINDOW_MS;
	if (renewed) expiresAt = new Date(now + SESSION_LIFETIME_MS);

	if (renewed || now - row.last_seen_at.getTime() > LAST_SEEN_RESOLUTION_MS) {
		await sql`
			UPDATE sessions SET last_seen_at = now(), expires_at = ${expiresAt}
			WHERE token_hash = ${tokenHash}
		`;
	}

	return {
		user: { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin },
		expiresAt,
		renewed
	};
}

export async function revokeSession(token: string): Promise<void> {
	await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
}

export async function deleteExpiredSessions(): Promise<void> {
	await sql`DELETE FROM sessions WHERE expires_at <= now()`;
}
