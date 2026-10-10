import { sql, type Transaction } from '../db/client';
import { hashPassword, verifyPassword } from './passwords';
import type { SessionUser } from './sessions';

export class EmailTakenError extends Error {}
export class SetupAlreadyCompleteError extends Error {}

export interface NewUser {
	email: string;
	displayName: string;
	password: string;
}

// Arbitrary constant; serializes first-admin creation.
const SETUP_LOCK_ID = 4_815_162_343;

// A real scrypt hash of a random value, verified when the email is unknown so
// that response time does not reveal which addresses have accounts.
const dummyHash = hashPassword(crypto.randomUUID());

async function insertUserWithWorkspace(
	tx: Transaction,
	user: NewUser,
	isAdmin: boolean
): Promise<SessionUser> {
	const passwordHash = await hashPassword(user.password);

	const [existing] = await tx`SELECT 1 FROM users WHERE email = ${user.email}`;
	if (existing) throw new EmailTakenError();

	const [created] = await tx<{ id: string }[]>`
		INSERT INTO users (email, display_name, password_hash, is_admin)
		VALUES (${user.email}, ${user.displayName}, ${passwordHash}, ${isAdmin})
		RETURNING id
	`;
	const userId = created!.id;

	// Every user owns a personal workspace, so a project always has a workspace to live in.
	const [workspace] = await tx<{ id: string }[]>`
		INSERT INTO workspaces (name, kind) VALUES (${'Personal'}, 'personal') RETURNING id
	`;
	await tx`
		INSERT INTO workspace_members (workspace_id, user_id, role)
		VALUES (${workspace!.id}, ${userId}, 'owner')
	`;

	return { id: userId, email: user.email, displayName: user.displayName, isAdmin };
}

export async function hasAnyUser(): Promise<boolean> {
	const [row] = await sql<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM users) AS exists`;
	return row!.exists;
}

/** Creates the first administrator. Fails if any user already exists. */
export async function createFirstAdmin(user: NewUser): Promise<SessionUser> {
	return sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(${SETUP_LOCK_ID})`;
		const [row] = await tx<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM users) AS exists`;
		if (row!.exists) throw new SetupAlreadyCompleteError();
		return insertUserWithWorkspace(tx, user, true);
	});
}

export async function createUser(user: NewUser): Promise<SessionUser> {
	return sql.begin((tx) => insertUserWithWorkspace(tx, user, false));
}

/** Returns the user when the credentials are correct and the account is enabled. */
export async function authenticate(email: string, password: string): Promise<SessionUser | null> {
	const [row] = await sql<
		{ id: string; email: string; display_name: string; is_admin: boolean; password_hash: string }[]
	>`
		SELECT id, email, display_name, is_admin, password_hash
		FROM users
		WHERE email = ${email} AND disabled_at IS NULL
	`;

	if (!row) {
		await verifyPassword(password, await dummyHash);
		return null;
	}
	if (!(await verifyPassword(password, row.password_hash))) return null;

	return { id: row.id, email: row.email, displayName: row.display_name, isAdmin: row.is_admin };
}

export interface UserAccount {
	id: string;
	email: string;
	displayName: string;
	isAdmin: boolean;
	createdAt: Date;
	disabledAt: Date | null;
	/** Most recent use of any of the user's sessions. */
	lastSeenAt: Date | null;
}

export class WrongPasswordError extends Error {}
export class LastAdminError extends Error {}

export async function listUsers(): Promise<UserAccount[]> {
	const rows = await sql<
		{
			id: string;
			email: string;
			display_name: string;
			is_admin: boolean;
			created_at: Date;
			disabled_at: Date | null;
			last_seen_at: Date | null;
		}[]
	>`
		SELECT u.id, u.email, u.display_name, u.is_admin, u.created_at, u.disabled_at,
			(SELECT max(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
		FROM users u
		ORDER BY u.created_at
	`;
	return rows.map((row) => ({
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		isAdmin: row.is_admin,
		createdAt: row.created_at,
		disabledAt: row.disabled_at,
		lastSeenAt: row.last_seen_at
	}));
}

export async function updateDisplayName(userId: string, displayName: string): Promise<void> {
	await sql`UPDATE users SET display_name = ${displayName} WHERE id = ${userId}`;
}

/** Changes a password after checking the current one. */
export async function changePassword(
	userId: string,
	currentPassword: string,
	newPassword: string
): Promise<void> {
	const [row] = await sql<{ password_hash: string }[]>`
		SELECT password_hash FROM users WHERE id = ${userId}
	`;
	if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
		throw new WrongPasswordError();
	}
	await setPassword(userId, newPassword);
}

export async function setPassword(userId: string, newPassword: string): Promise<void> {
	await sql`UPDATE users SET password_hash = ${await hashPassword(newPassword)} WHERE id = ${userId}`;
}

/**
 * Disables or re-enables an account. A disabled account cannot sign in and its
 * sessions end at once. The last enabled administrator cannot be disabled, or
 * nobody could manage the installation any more.
 */
export async function setUserDisabled(userId: string, disabled: boolean): Promise<void> {
	await sql.begin(async (tx) => {
		if (disabled) {
			const [target] = await tx<{ is_admin: boolean }[]>`
				SELECT is_admin FROM users WHERE id = ${userId} FOR UPDATE
			`;
			if (target?.is_admin) {
				const [others] = await tx<{ count: number }[]>`
					SELECT count(*)::int AS count FROM users
					WHERE is_admin AND disabled_at IS NULL AND id <> ${userId}
				`;
				if (others!.count === 0) throw new LastAdminError();
			}
			await tx`DELETE FROM sessions WHERE user_id = ${userId}`;
		}
		if (disabled) await tx`UPDATE users SET disabled_at = now() WHERE id = ${userId}`;
		else await tx`UPDATE users SET disabled_at = NULL WHERE id = ${userId}`;
	});
}

/** Used by invitations: creates the account inside the caller's transaction. */
export const createUserIn = insertUserWithWorkspace;
