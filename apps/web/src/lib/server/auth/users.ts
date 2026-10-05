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
