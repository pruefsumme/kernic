import * as fs from 'node:fs/promises';
import {
	projectArtifactsDir,
	projectDir,
	projectTreeDir,
	treeLimits,
	workspaceLimits
} from '../config';
import { sql } from '../db/client';
import { normalizeProjectPath } from './paths';
import { findTemplate } from './templates';
import { TreeError, readTreeFile, treeUsage, writeTreeFile } from './tree';

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface Project {
	id: string;
	workspaceId: string;
	name: string;
	entryPath: string;
	revision: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface ProjectAccess {
	project: Project;
	role: WorkspaceRole;
}

export interface ProjectSummary extends Project {
	workspaceName: string;
	workspaceKind: 'personal' | 'team';
	role: WorkspaceRole;
}

export interface WorkspaceMembership {
	id: string;
	name: string;
	kind: 'personal' | 'team';
	role: WorkspaceRole;
}

export class ProjectInputError extends Error {}

/** The workspace has used what it may of the server's storage, or holds as many projects as it may. */
export class WorkspaceLimitError extends ProjectInputError {}

interface ProjectRow {
	id: string;
	workspace_id: string;
	name: string;
	entry_path: string;
	revision: number;
	created_at: Date;
	updated_at: Date;
}

function toProject(row: ProjectRow): Project {
	return {
		id: row.id,
		workspaceId: row.workspace_id,
		name: row.name,
		entryPath: row.entry_path,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
	return typeof value === 'string' && UUID.test(value);
}

export function canWrite(role: WorkspaceRole): boolean {
	return role === 'owner' || role === 'editor';
}

export function validateProjectName(input: unknown): string {
	const name = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
	if (name.length < 1) throw new ProjectInputError('Give the project a name.');
	if (name.length > 120)
		throw new ProjectInputError('Project names can be at most 120 characters.');
	return name;
}

export async function listWorkspacesForUser(userId: string): Promise<WorkspaceMembership[]> {
	return sql<WorkspaceMembership[]>`
		SELECT w.id, w.name, w.kind, m.role
		FROM workspace_members m
		JOIN workspaces w ON w.id = m.workspace_id
		WHERE m.user_id = ${userId}
		ORDER BY (w.kind = 'personal') DESC, w.name
	`;
}

export async function listProjectsForUser(userId: string): Promise<ProjectSummary[]> {
	const rows = await sql<
		(ProjectRow & {
			workspace_name: string;
			workspace_kind: 'personal' | 'team';
			role: WorkspaceRole;
		})[]
	>`
		SELECT p.*, w.name AS workspace_name, w.kind AS workspace_kind, m.role
		FROM projects p
		JOIN workspaces w ON w.id = p.workspace_id
		JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = ${userId}
		ORDER BY p.updated_at DESC
	`;
	return rows.map((row) => ({
		...toProject(row),
		workspaceName: row.workspace_name,
		workspaceKind: row.workspace_kind,
		role: row.role
	}));
}

/**
 * The single place that decides whether a user may see a project. Returns null
 * both when the project does not exist and when the user is not a member of its
 * workspace, so callers cannot leak which of the two it was.
 */
export async function getProjectAccess(
	userId: string,
	projectId: string
): Promise<ProjectAccess | null> {
	if (!isUuid(projectId)) return null;
	const [row] = await sql<(ProjectRow & { role: WorkspaceRole })[]>`
		SELECT p.*, m.role
		FROM projects p
		JOIN workspace_members m ON m.workspace_id = p.workspace_id AND m.user_id = ${userId}
		WHERE p.id = ${projectId}
	`;
	return row ? { project: toProject(row), role: row.role } : null;
}

export async function getWorkspaceRole(
	userId: string,
	workspaceId: string
): Promise<WorkspaceRole | null> {
	if (!isUuid(workspaceId)) return null;
	const [row] = await sql<{ role: WorkspaceRole }[]>`
		SELECT role FROM workspace_members
		WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
	`;
	return row?.role ?? null;
}

export async function createProjectFromTemplate(input: {
	workspaceId: string;
	userId: string;
	name: string;
	templateId: string;
}): Promise<Project> {
	const template = findTemplate(input.templateId);
	if (!template) throw new ProjectInputError('Choose one of the available templates.');
	await assertWorkspaceRoom(input.workspaceId, { projects: 1 });

	const project = await insertProject({
		workspaceId: input.workspaceId,
		userId: input.userId,
		name: input.name,
		entryPath: template.entryPath
	});

	try {
		const root = projectTreeDir(project.id);
		await fs.mkdir(root, { recursive: true });
		for (const file of template.files) {
			await writeTreeFile(root, file.path, Buffer.from(file.content), { limits: treeLimits });
		}
	} catch (error) {
		// Do not leave a project row behind whose files could not be created.
		await deleteProject(project.id);
		throw error;
	}
	await measureProject(project.id);

	return project;
}

export async function insertProject(input: {
	workspaceId: string;
	userId: string;
	name: string;
	entryPath: string;
}): Promise<Project> {
	const [row] = await sql<ProjectRow[]>`
		INSERT INTO projects (workspace_id, name, entry_path, created_by)
		VALUES (${input.workspaceId}, ${validateProjectName(input.name)}, ${input.entryPath}, ${input.userId})
		RETURNING *
	`;
	return toProject(row!);
}

export async function renameProject(projectId: string, name: unknown): Promise<void> {
	await sql`
		UPDATE projects SET name = ${validateProjectName(name)}, updated_at = now()
		WHERE id = ${projectId}
	`;
}

export async function setEntryPath(projectId: string, entryPath: unknown): Promise<string> {
	const normalized = normalizeProjectPath(entryPath);
	if (!normalized.toLowerCase().endsWith('.typ')) {
		throw new ProjectInputError('The main file must be a .typ file.');
	}
	try {
		await readTreeFile(projectTreeDir(projectId), normalized);
	} catch (error) {
		if (error instanceof TreeError) {
			throw new ProjectInputError('That file does not exist in this project.');
		}
		throw error;
	}
	// The compiled document changes with the entry file, so this counts as a revision.
	await sql`
		UPDATE projects
		SET entry_path = ${normalized}, revision = revision + 1, updated_at = now()
		WHERE id = ${projectId}
	`;
	return normalized;
}

/** Records that the project's files changed, and how much they are now. Returns the new revision. */
export async function bumpRevision(projectId: string): Promise<number> {
	const usage = await treeUsage(projectTreeDir(projectId));
	const [row] = await sql<{ revision: number }[]>`
		UPDATE projects
		SET revision = revision + 1, updated_at = now(),
			bytes = ${usage.bytes}, file_count = ${usage.entries}, measured_at = now()
		WHERE id = ${projectId}
		RETURNING revision
	`;
	return row!.revision;
}

/** Measures a project's files without counting it as a change. */
export async function measureProject(projectId: string): Promise<void> {
	const usage = await treeUsage(projectTreeDir(projectId));
	await sql`
		UPDATE projects
		SET bytes = ${usage.bytes}, file_count = ${usage.entries}, measured_at = now()
		WHERE id = ${projectId}
	`;
}

/** Measures the projects that have no size on record yet: those from before sizes were kept. */
export async function measureUnmeasuredProjects(): Promise<number> {
	const rows = await sql<{ id: string }[]>`SELECT id FROM projects WHERE measured_at IS NULL`;
	for (const { id } of rows) await measureProject(id);
	return rows.length;
}

export interface WorkspaceUsage {
	bytes: number;
	projects: number;
	maxBytes: number;
	maxProjects: number;
}

/** What a workspace uses of what it may use. Counts project files; history and renders are extra. */
export async function workspaceUsage(workspaceId: string): Promise<WorkspaceUsage> {
	const [row] = await sql<{ bytes: number; projects: number }[]>`
		SELECT coalesce(sum(bytes), 0)::bigint AS bytes, count(*)::int AS projects
		FROM projects WHERE workspace_id = ${workspaceId}
	`;
	return { bytes: row!.bytes, projects: row!.projects, ...workspaceLimits };
}

const megabytes = (bytes: number) =>
	bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB`
		: `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;

/**
 * Says why something does not fit into a workspace any more, or null if it does.
 * Shrinking and staying the same size always fit.
 */
export function roomProblem(
	usage: WorkspaceUsage,
	added: { bytes?: number; projects?: number }
): string | null {
	const projects = added.projects ?? 0;
	const bytes = added.bytes ?? 0;
	if (projects > 0 && usage.projects + projects > usage.maxProjects) {
		return `This workspace already has ${usage.projects} projects, which is as many as this server allows. Delete one you no longer need first.`;
	}
	if (bytes > 0 && usage.bytes + bytes > usage.maxBytes) {
		return `This workspace has used its storage on this server (${megabytes(usage.bytes)} of ${megabytes(usage.maxBytes)}). Delete files or projects you no longer need, or ask the administrator for more.`;
	}
	return null;
}

/**
 * Refuses growth beyond what the workspace may hold. Call before adding bytes
 * to a project or a project to the workspace.
 */
export async function assertWorkspaceRoom(
	workspaceId: string,
	added: { bytes?: number; projects?: number }
): Promise<void> {
	const problem = roomProblem(await workspaceUsage(workspaceId), added);
	if (problem) throw new WorkspaceLimitError(problem);
}

export async function deleteProject(projectId: string): Promise<void> {
	await sql`DELETE FROM projects WHERE id = ${projectId}`;
	await fs.rm(projectDir(projectId), { recursive: true, force: true });
	await fs.rm(projectArtifactsDir(projectId), { recursive: true, force: true });
}
