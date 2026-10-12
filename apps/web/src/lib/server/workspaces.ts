import { createHash, randomBytes } from 'node:crypto';
import { sql, type Transaction } from './db/client';
import {
	assertWorkspaceRoom,
	canWrite,
	isUuid,
	workspaceUsage,
	type WorkspaceRole,
	type WorkspaceUsage
} from './projects/projects';

/**
 * Shared workspaces: several people working on the same projects.
 *
 * Everyone has a personal workspace that is theirs alone. A shared workspace
 * is created by someone who becomes its owner, and others join it through a
 * link the owner hands them. What a member may do follows from their role:
 *
 * - viewer: open projects and export them;
 * - editor: also change, create and import projects;
 * - owner: also delete projects, manage members and the workspace itself.
 *
 * Access to every project goes through `getProjectAccess`, which looks the
 * role up for each request, so a change here takes effect at once.
 */

export interface Workspace {
	id: string;
	name: string;
	kind: 'personal' | 'team';
	role: WorkspaceRole;
}

export interface WorkspaceOverview extends Workspace {
	members: number;
	usage: WorkspaceUsage;
}

export interface Member {
	userId: string;
	email: string;
	displayName: string;
	role: WorkspaceRole;
	joinedAt: Date;
}

export interface PendingInvite {
	id: string;
	role: 'editor' | 'viewer';
	createdAt: Date;
	expiresAt: Date;
}

/** Something about the request cannot be done; the message says what, for the person asking. */
export class WorkspaceError extends Error {}

const INVITE_LIFETIME_HOURS = 7 * 24;
/** Shared workspaces one person may own, so that the list stays a list. */
const MAX_OWNED_WORKSPACES = 20;
const MAX_MEMBERS = 200;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function validateWorkspaceName(input: unknown): string {
	const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
	if (name.length < 1) throw new WorkspaceError('Give the workspace a name.');
	if (name.length > 80) throw new WorkspaceError('Workspace names can be at most 80 characters.');
	return name;
}

export function isRole(value: unknown): value is WorkspaceRole {
	return value === 'owner' || value === 'editor' || value === 'viewer';
}

/** The workspace, if this person is a member of it. */
export async function getWorkspace(userId: string, workspaceId: string): Promise<Workspace | null> {
	if (!isUuid(workspaceId)) return null;
	const [row] = await sql<Workspace[]>`
		SELECT w.id, w.name, w.kind, m.role
		FROM workspaces w
		JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ${userId}
		WHERE w.id = ${workspaceId}
	`;
	return row ?? null;
}

/** Every workspace of a person, their own first, with what each holds. */
export async function listWorkspaceOverviews(userId: string): Promise<WorkspaceOverview[]> {
	const rows = await sql<(Workspace & { members: number })[]>`
		SELECT w.id, w.name, w.kind, m.role,
			(SELECT count(*)::int FROM workspace_members o WHERE o.workspace_id = w.id) AS members
		FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ${userId}
		ORDER BY (w.kind = 'personal') DESC, w.name
	`;
	return Promise.all(rows.map(async (row) => ({ ...row, usage: await workspaceUsage(row.id) })));
}

export async function createSharedWorkspace(userId: string, name: unknown): Promise<string> {
	const validName = validateWorkspaceName(name);
	return sql.begin(async (tx) => {
		const [owned] = await tx<{ count: number }[]>`
			SELECT count(*)::int AS count
			FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
			WHERE m.user_id = ${userId} AND m.role = 'owner' AND w.kind = 'team'
		`;
		if (owned!.count >= MAX_OWNED_WORKSPACES) {
			throw new WorkspaceError(
				`You already own ${MAX_OWNED_WORKSPACES} shared workspaces. Delete one you no longer need first.`
			);
		}
		const [workspace] = await tx<{ id: string }[]>`
			INSERT INTO workspaces (name, kind) VALUES (${validName}, 'team') RETURNING id
		`;
		await tx`
			INSERT INTO workspace_members (workspace_id, user_id, role)
			VALUES (${workspace!.id}, ${userId}, 'owner')
		`;
		return workspace!.id;
	});
}

export async function renameWorkspace(workspaceId: string, name: unknown): Promise<void> {
	await sql`
		UPDATE workspaces SET name = ${validateWorkspaceName(name)}
		WHERE id = ${workspaceId} AND kind = 'team'
	`;
}

export async function listMembers(workspaceId: string): Promise<Member[]> {
	const rows = await sql<
		{
			user_id: string;
			email: string;
			display_name: string;
			role: WorkspaceRole;
			created_at: Date;
		}[]
	>`
		SELECT m.user_id, u.email, u.display_name, m.role, m.created_at
		FROM workspace_members m JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = ${workspaceId}
		ORDER BY (m.role = 'owner') DESC, u.display_name, u.email
	`;
	return rows.map((row) => ({
		userId: row.user_id,
		email: row.email,
		displayName: row.display_name,
		role: row.role,
		joinedAt: row.created_at
	}));
}

/**
 * Changes a member's role. A workspace always keeps at least one owner, so the
 * last one cannot be made anything else.
 */
export async function setMemberRole(
	workspaceId: string,
	userId: string,
	role: WorkspaceRole
): Promise<void> {
	await sql.begin(async (tx) => {
		// Serialises changes to one workspace's members, so two cannot both remove the last owner.
		await tx`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
		const [current] = await tx<{ role: WorkspaceRole }[]>`
			SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
		`;
		if (!current) throw new WorkspaceError('That person is not a member of this workspace.');
		if (current.role === 'owner' && role !== 'owner')
			await assertAnotherOwner(tx, workspaceId, userId);
		await tx`
			UPDATE workspace_members SET role = ${role}
			WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
		`;
	});
}

/** Removes a member, or lets one leave. The last owner cannot go. */
export async function removeMember(workspaceId: string, userId: string): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
		const [current] = await tx<{ role: WorkspaceRole }[]>`
			SELECT role FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
		`;
		if (!current) return;
		if (current.role === 'owner') await assertAnotherOwner(tx, workspaceId, userId);
		await tx`
			DELETE FROM workspace_members WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
		`;
	});
}

async function assertAnotherOwner(
	tx: Transaction,
	workspaceId: string,
	exceptUserId: string
): Promise<void> {
	const [others] = await tx<{ count: number }[]>`
		SELECT count(*)::int AS count FROM workspace_members
		WHERE workspace_id = ${workspaceId} AND role = 'owner' AND user_id <> ${exceptUserId}
	`;
	if (others!.count === 0) {
		throw new WorkspaceError(
			'A workspace needs an owner. Make someone else an owner first, or delete the workspace.'
		);
	}
}

/** Deletes a shared workspace that has no projects left. */
export async function deleteWorkspace(workspaceId: string): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`SELECT 1 FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
		const [projects] = await tx<{ count: number }[]>`
			SELECT count(*)::int AS count FROM projects WHERE workspace_id = ${workspaceId}
		`;
		if (projects!.count > 0) {
			throw new WorkspaceError(
				'This workspace still has projects. Move them to another workspace or delete them first.'
			);
		}
		await tx`DELETE FROM workspaces WHERE id = ${workspaceId} AND kind = 'team'`;
	});
}

/** Creates a link with which one person can join the workspace in the given role. */
export async function createWorkspaceInvite(
	workspaceId: string,
	role: 'editor' | 'viewer',
	createdBy: string
): Promise<{ token: string; expiresAt: Date }> {
	const token = randomBytes(24).toString('base64url');
	const expiresAt = new Date(Date.now() + INVITE_LIFETIME_HOURS * 60 * 60 * 1000);
	await sql`
		INSERT INTO workspace_invites (token_hash, workspace_id, role, created_by, expires_at)
		VALUES (${hashToken(token)}, ${workspaceId}, ${role}, ${createdBy}, ${expiresAt})
	`;
	return { token, expiresAt };
}

/** Links that have been made and not used, revoked or left to expire. */
export async function listPendingInvites(workspaceId: string): Promise<PendingInvite[]> {
	const rows = await sql<
		{ id: string; role: 'editor' | 'viewer'; created_at: Date; expires_at: Date }[]
	>`
		SELECT id, role, created_at, expires_at FROM workspace_invites
		WHERE workspace_id = ${workspaceId} AND used_at IS NULL AND expires_at > now()
		ORDER BY created_at DESC
	`;
	return rows.map((row) => ({
		id: row.id,
		role: row.role,
		createdAt: row.created_at,
		expiresAt: row.expires_at
	}));
}

export async function revokeWorkspaceInvite(workspaceId: string, inviteId: string): Promise<void> {
	if (!isUuid(inviteId)) return;
	await sql`
		DELETE FROM workspace_invites
		WHERE id = ${inviteId} AND workspace_id = ${workspaceId} AND used_at IS NULL
	`;
}

/** What a link offers, for the page that asks whether to accept it. Null if it is not valid. */
export async function findWorkspaceInvite(token: string): Promise<{
	workspaceId: string;
	workspaceName: string;
	role: 'editor' | 'viewer';
	invitedBy: string | null;
} | null> {
	const [row] = await sql<
		{ workspace_id: string; name: string; role: 'editor' | 'viewer'; invited_by: string | null }[]
	>`
		SELECT i.workspace_id, w.name, i.role, u.display_name AS invited_by
		FROM workspace_invites i
		JOIN workspaces w ON w.id = i.workspace_id
		LEFT JOIN users u ON u.id = i.created_by
		WHERE i.token_hash = ${hashToken(token)} AND i.used_at IS NULL AND i.expires_at > now()
	`;
	return row
		? {
				workspaceId: row.workspace_id,
				workspaceName: row.name,
				role: row.role,
				invitedBy: row.invited_by
			}
		: null;
}

/**
 * Uses a link: the person becomes a member. The link is consumed in the same
 * transaction, so it admits exactly one person. Someone who is a member
 * already keeps the role they have. Returns the workspace joined.
 */
export async function acceptWorkspaceInvite(token: string, userId: string): Promise<string> {
	return sql.begin(async (tx) => {
		const [claimed] = await tx<{ workspace_id: string; role: 'editor' | 'viewer' }[]>`
			UPDATE workspace_invites SET used_at = now(), used_by = ${userId}
			WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > now()
			RETURNING workspace_id, role
		`;
		if (!claimed) {
			throw new WorkspaceError('This link is no longer valid. Ask for a new one.');
		}
		const [members] = await tx<{ count: number }[]>`
			SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id = ${claimed.workspace_id}
		`;
		if (members!.count >= MAX_MEMBERS) {
			throw new WorkspaceError('This workspace has as many members as it can take.');
		}
		await tx`
			INSERT INTO workspace_members (workspace_id, user_id, role)
			VALUES (${claimed.workspace_id}, ${userId}, ${claimed.role})
			ON CONFLICT (workspace_id, user_id) DO NOTHING
		`;
		return claimed.workspace_id;
	});
}

/**
 * Moves a project to another workspace. It leaves the reach of the people in
 * the one and enters that of the people in the other, so it takes an owner of
 * where it is and someone who may create projects where it goes.
 */
export async function moveProject(input: {
	projectId: string;
	userId: string;
	targetWorkspaceId: string;
}): Promise<void> {
	const [project] = await sql<{ workspace_id: string; bytes: number; role: WorkspaceRole }[]>`
		SELECT p.workspace_id, p.bytes, m.role
		FROM projects p
		JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = ${input.userId}
		WHERE p.id = ${input.projectId}
	`;
	if (!project) throw new WorkspaceError('Project not found.');
	if (project.workspace_id === input.targetWorkspaceId) return;
	if (project.role !== 'owner') {
		throw new WorkspaceError('Only an owner of the workspace a project is in can move it.');
	}
	const target = await getWorkspace(input.userId, input.targetWorkspaceId);
	if (!target || !canWrite(target.role)) {
		throw new WorkspaceError('You cannot create projects in that workspace.');
	}
	await assertWorkspaceRoom(target.id, { projects: 1, bytes: project.bytes });
	await sql`
		UPDATE projects SET workspace_id = ${target.id}, updated_at = now()
		WHERE id = ${input.projectId}
	`;
}
