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
export async function createSession(
	userId: string,
	userAgent: string | null = null
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
	await sql`
		INSERT INTO sessions (token_hash, user_id, expires_at, user_agent)
		VALUES (${hashToken(token)}, ${userId}, ${expiresAt}, ${userAgent?.slice(0, 300) ?? null})
	`;
	return { token, expiresAt };
}

export interface SessionInfo {
	id: string;
	userAgent: string | null;
	createdAt: Date;
	lastSeenAt: Date;
	/** The session this request is made with. */
	current: boolean;
}

/** A user's sessions, the current one first. */
export async function listSessions(userId: string, currentToken: string): Promise<SessionInfo[]> {
	const currentHash = hashToken(currentToken);
	const rows = await sql<
		{
			id: string;
			user_agent: string | null;
			created_at: Date;
			last_seen_at: Date;
			current: boolean;
		}[]
	>`
		SELECT id, user_agent, created_at, last_seen_at, token_hash = ${currentHash} AS current
		FROM sessions
		WHERE user_id = ${userId} AND expires_at > now()
		ORDER BY (token_hash = ${currentHash}) DESC, last_seen_at DESC
	`;
	return rows.map((row) => ({
		id: row.id,
		userAgent: row.user_agent,
		createdAt: row.created_at,
		lastSeenAt: row.last_seen_at,
		current: row.current
	}));
}

/** Ends one of the user's own sessions. Returns false if it is not theirs. */
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
	if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false;
	const rows = await sql`
		DELETE FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} RETURNING 1
	`;
	return rows.length > 0;
}

/** Ends every session of the user, optionally sparing the one identified by `keepToken`. */
export async function revokeAllSessions(userId: string, keepToken?: string): Promise<void> {
	const keep = keepToken ? hashToken(keepToken) : '';
	await sql`DELETE FROM sessions WHERE user_id = ${userId} AND token_hash <> ${keep}`;
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
