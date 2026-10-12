import { createHash, randomBytes } from 'node:crypto';
import type { RenderedPage } from './compile/jobs';
import { sql } from './db/client';
import { isUuid } from './projects/projects';

/**
 * Links for reading: whoever has one sees the rendered pages of a project as
 * they currently are, without an account. Not the source, not the files, not
 * the history, and nothing can be changed through one.
 *
 * A link is a long random value of which only a hash is stored. It is made by
 * an owner of the project's workspace, shown once, and can be withdrawn.
 */

export interface ProjectShare {
	id: string;
	createdAt: Date;
	expiresAt: Date | null;
	lastOpenedAt: Date | null;
}

export interface SharedDocument {
	name: string;
	/** The pages of the newest successful render, or none if the project never rendered. */
	pages: RenderedPage[];
	renderedAt: Date | null;
}

const MAX_LINKS_PER_PROJECT = 20;
/** Lifetimes offered when a link is made; null for one that lasts until withdrawn. */
export const SHARE_LIFETIMES_DAYS = [7, 30, 365] as const;

export class ShareError extends Error {}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const live = sql`(expires_at IS NULL OR expires_at > now())`;

export async function createProjectShare(input: {
	projectId: string;
	createdBy: string;
	days: number | null;
}): Promise<{ token: string; expiresAt: Date | null }> {
	const [existing] = await sql<{ count: number }[]>`
		SELECT count(*)::int AS count FROM project_shares
		WHERE project_id = ${input.projectId} AND ${live}
	`;
	if (existing!.count >= MAX_LINKS_PER_PROJECT) {
		throw new ShareError(
			'This project has many links already. Withdraw one you no longer need first.'
		);
	}
	const token = randomBytes(24).toString('base64url');
	const expiresAt =
		input.days === null ? null : new Date(Date.now() + input.days * 24 * 60 * 60 * 1000);
	await sql`
		INSERT INTO project_shares (token_hash, project_id, created_by, expires_at)
		VALUES (${hashToken(token)}, ${input.projectId}, ${input.createdBy}, ${expiresAt})
	`;
	return { token, expiresAt };
}

export async function listProjectShares(projectId: string): Promise<ProjectShare[]> {
	const rows = await sql<
		{ id: string; created_at: Date; expires_at: Date | null; last_opened_at: Date | null }[]
	>`
		SELECT id, created_at, expires_at, last_opened_at FROM project_shares
		WHERE project_id = ${projectId} AND ${live}
		ORDER BY created_at DESC
	`;
	return rows.map((row) => ({
		id: row.id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastOpenedAt: row.last_opened_at
	}));
}

export async function revokeProjectShare(projectId: string, shareId: string): Promise<void> {
	if (!isUuid(shareId)) return;
	await sql`DELETE FROM project_shares WHERE id = ${shareId} AND project_id = ${projectId}`;
}

/** The project a link shows, or null if the link is unknown, withdrawn or expired. */
async function projectOf(token: string): Promise<{ id: string; name: string } | null> {
	// Tokens are 32 characters of base64url; anything else is not worth a query.
	if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
	const [row] = await sql<{ id: string; name: string }[]>`
		SELECT p.id, p.name
		FROM project_shares s JOIN projects p ON p.id = s.project_id
		WHERE s.token_hash = ${hashToken(token)} AND ${sql`(s.expires_at IS NULL OR s.expires_at > now())`}
	`;
	return row ?? null;
}

/** What a link shows. Records that it was opened. */
export async function openSharedDocument(token: string): Promise<SharedDocument | null> {
	const project = await projectOf(token);
	if (!project) return null;
	const [render] = await sql<{ pages: RenderedPage[]; finished_at: Date }[]>`
		SELECT pages, finished_at FROM compile_jobs
		WHERE project_id = ${project.id} AND format = 'svg' AND status = 'succeeded'
			AND pages IS NOT NULL
		ORDER BY finished_at DESC
		LIMIT 1
	`;
	await sql`
		UPDATE project_shares SET last_opened_at = now() WHERE token_hash = ${hashToken(token)}
	`;
	return {
		name: project.name,
		pages: render?.pages ?? [],
		renderedAt: render?.finished_at ?? null
	};
}

/**
 * The project whose rendered page with this hash a link may show: the page
 * has to belong to a render of that very project. Null otherwise.
 */
export async function sharedPageProject(token: string, pageHash: string): Promise<string | null> {
	const project = await projectOf(token);
	if (!project) return null;
	const [known] = await sql`
		SELECT 1
		FROM compile_jobs, jsonb_array_elements(pages) AS page
		WHERE project_id = ${project.id} AND pages IS NOT NULL AND page->>'hash' = ${pageHash}
		LIMIT 1
	`;
	return known ? project.id : null;
}
