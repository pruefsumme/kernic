import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db/client';
import type { SessionUser } from './sessions';
import { hashPassword } from './passwords';
import { EmailTakenError, createUserIn } from './users';

/**
 * Single-use links by which people get into an account without an
 * administrator ever knowing their password: an invitation creates the
 * account, a reset link lets its owner choose a new password.
 *
 * Kernic does not send email. The administrator copies the link and passes it
 * on through a channel they trust. Only a hash of the token is stored, so the
 * database does not contain usable links.
 */

const INVITE_LIFETIME_HOURS = 7 * 24;
const RESET_LIFETIME_HOURS = 24;

export type AccountLink =
	| { kind: 'invite'; email: string; expiresAt: Date }
	| { kind: 'reset'; email: string; userId: string; expiresAt: Date };

export class LinkNotValidError extends Error {}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function create(
	values: { kind: 'invite'; email: string } | { kind: 'reset'; userId: string },
	createdBy: string
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(24).toString('base64url');
	const hours = values.kind === 'invite' ? INVITE_LIFETIME_HOURS : RESET_LIFETIME_HOURS;
	const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

	await sql.begin(async (tx) => {
		// A new link replaces any earlier unused one for the same person.
		if (values.kind === 'invite') {
			await tx`DELETE FROM account_links WHERE kind = 'invite' AND email = ${values.email} AND used_at IS NULL`;
		} else {
			await tx`DELETE FROM account_links WHERE kind = 'reset' AND user_id = ${values.userId} AND used_at IS NULL`;
		}
		await tx`
			INSERT INTO account_links (token_hash, kind, email, user_id, created_by, expires_at)
			VALUES (
				${hashToken(token)}, ${values.kind},
				${values.kind === 'invite' ? values.email : null},
				${values.kind === 'reset' ? values.userId : null},
				${createdBy}, ${expiresAt}
			)
		`;
	});
	return { token, expiresAt };
}

export async function createInvitation(email: string, createdBy: string) {
	const [existing] = await sql`SELECT 1 FROM users WHERE email = ${email}`;
	if (existing) throw new EmailTakenError();
	return create({ kind: 'invite', email }, createdBy);
}

export const createPasswordReset = (userId: string, createdBy: string) =>
	create({ kind: 'reset', userId }, createdBy);

/** Looks a link up. Returns null if it is unknown, used or expired. */
export async function findAccountLink(token: string): Promise<AccountLink | null> {
	const [row] = await sql<
		{
			kind: 'invite' | 'reset';
			email: string | null;
			user_id: string | null;
			user_email: string | null;
			expires_at: Date;
		}[]
	>`
		SELECT l.kind, l.email, l.user_id, u.email AS user_email, l.expires_at
		FROM account_links l
		LEFT JOIN users u ON u.id = l.user_id AND u.disabled_at IS NULL
		WHERE l.token_hash = ${hashToken(token)} AND l.used_at IS NULL AND l.expires_at > now()
	`;
	if (!row) return null;
	if (row.kind === 'invite')
		return { kind: 'invite', email: row.email!, expiresAt: row.expires_at };
	// A reset link for an account that was disabled or deleted meanwhile is void.
	if (!row.user_id || !row.user_email) return null;
	return { kind: 'reset', email: row.user_email, userId: row.user_id, expiresAt: row.expires_at };
}

/**
 * Uses a link: creates the invited account, or sets the new password. The link
 * is consumed in the same transaction, so it works exactly once even if it is
 * submitted twice at the same moment.
 */
export async function redeemAccountLink(
	token: string,
	input: { displayName?: string; password: string }
): Promise<{ user: SessionUser; kind: 'invite' | 'reset' }> {
	return sql.begin(async (tx) => {
		const [claimed] = await tx<
			{ kind: 'invite' | 'reset'; email: string | null; user_id: string | null }[]
		>`
			UPDATE account_links SET used_at = now()
			WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
			RETURNING kind, email, user_id
		`;
		if (!claimed) throw new LinkNotValidError();

		if (claimed.kind === 'invite') {
			const user = await createUserIn(
				tx,
				{
					email: claimed.email!,
					displayName: input.displayName ?? claimed.email!,
					password: input.password
				},
				false
			);
			return { user, kind: 'invite' as const };
		}

		const [row] = await tx<
			{ id: string; email: string; display_name: string; is_admin: boolean }[]
		>`
			SELECT id, email, display_name, is_admin FROM users
			WHERE id = ${claimed.user_id} AND disabled_at IS NULL
		`;
		if (!row) throw new LinkNotValidError();
		await tx`
			UPDATE users SET password_hash = ${await hashPassword(input.password)} WHERE id = ${row.id}
		`;
		// Whoever knew the old password is signed out everywhere.
		await tx`DELETE FROM sessions WHERE user_id = ${row.id}`;
		return {
			user: { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin },
			kind: 'reset' as const
		};
	});
}
