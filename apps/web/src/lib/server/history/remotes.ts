import { gitRemotes, projectDir, projectTreeDir, treeLimits } from '../config';
import { sql } from '../db/client';
import { assertWorkspaceRoom, bumpRevision } from '../projects/projects';
import { treeUsage } from '../projects/tree';
import { openSecret, sealSecret } from '../secrets';
import { ProjectHistory, type Author, type PullResult, type Remote } from './git';
import { withHistory } from './history';
import { parseBranch, parseRemoteUrl, parseToken, parseUsername } from './remote-url';

/**
 * The Git repository elsewhere that a project's checkpoints are pushed to.
 *
 * Connecting is an owner's decision: it puts a token on the server and lets
 * everyone who may write to the project publish its history there. Pushing
 * only ever adds to the repository's branch. Git runs in the app, never in the
 * compile worker, and talks only to hosts the administrator listed.
 */

export interface ProjectRemote {
	url: string;
	branch: string;
	username: string;
	connectedAt: Date;
	lastPushedAt: Date | null;
	lastPushedCheckpoint: string | null;
}

/** Shown where a person could act on it: the feature is off, or busy. */
export class RemoteUnavailableError extends Error {}

const TOKEN_PURPOSE = 'git remote token';

/** Whether this server lets projects be connected to repositories at all. */
export const remotesEnabled = gitRemotes.origins.length > 0;
/** The hosts that may be used, as people write them: `git.example.org`. */
export const remoteHosts = gitRemotes.origins.map((origin) =>
	origin.startsWith('https://') ? origin.slice('https://'.length) : origin
);

interface RemoteRow {
	url: string;
	branch: string;
	username: string;
	token_sealed: Uint8Array;
	connected_at: Date;
	last_pushed_at: Date | null;
	last_pushed_checkpoint: string | null;
}

const toRemote = (row: RemoteRow): ProjectRemote => ({
	url: row.url,
	branch: row.branch,
	username: row.username,
	connectedAt: row.connected_at,
	lastPushedAt: row.last_pushed_at,
	lastPushedCheckpoint: row.last_pushed_checkpoint
});

async function findRow(projectId: string): Promise<RemoteRow | null> {
	const [row] = await sql<RemoteRow[]>`
		SELECT url, branch, username, token_sealed, connected_at, last_pushed_at, last_pushed_checkpoint
		FROM project_remotes WHERE project_id = ${projectId}
	`;
	return row ?? null;
}

/** The repository a project is connected to, without its token. */
export async function getProjectRemote(projectId: string): Promise<ProjectRemote | null> {
	const row = await findRow(projectId);
	return row ? toRemote(row) : null;
}

/** The connection and how many checkpoints the repository does not have yet. */
export async function getRemoteStatus(
	projectId: string
): Promise<{ remote: ProjectRemote; unpushed: number } | null> {
	const remote = await getProjectRemote(projectId);
	if (!remote) return null;
	const history = new ProjectHistory(projectDir(projectId));
	return { remote, unpushed: await history.checkpointsSince(remote.lastPushedCheckpoint) };
}

/**
 * Connects a project to a repository. The values are checked, and the
 * repository is asked for its branch with them before anything is stored, so
 * a connection that is saved is one that worked. Throws `RemoteUrlError` for
 * values that cannot be used and `RemoteError` if the forge does not play along.
 */
export async function connectProjectRemote(input: {
	projectId: string;
	userId: string;
	url: unknown;
	branch: unknown;
	username: unknown;
	token: unknown;
}): Promise<ProjectRemote> {
	if (!remotesEnabled) {
		throw new RemoteUnavailableError('This server is not set up to connect to Git repositories.');
	}
	const remote: Remote = {
		url: parseRemoteUrl(input.url, gitRemotes.origins),
		branch: parseBranch(input.branch),
		username: parseUsername(input.username),
		token: parseToken(input.token)
	};
	await new ProjectHistory(projectDir(input.projectId)).lookAtRemote(remote);

	const sealed = sealSecret(gitRemotes.secretKey, TOKEN_PURPOSE, input.projectId, remote.token);
	const [row] = await sql<RemoteRow[]>`
		INSERT INTO project_remotes (project_id, url, branch, username, token_sealed, connected_by)
		VALUES (${input.projectId}, ${remote.url}, ${remote.branch}, ${remote.username}, ${sealed}, ${input.userId})
		ON CONFLICT (project_id) DO UPDATE SET
			url = EXCLUDED.url,
			branch = EXCLUDED.branch,
			username = EXCLUDED.username,
			token_sealed = EXCLUDED.token_sealed,
			connected_by = EXCLUDED.connected_by,
			connected_at = now(),
			last_pushed_at = NULL,
			last_pushed_checkpoint = NULL
		RETURNING url, branch, username, token_sealed, connected_at, last_pushed_at, last_pushed_checkpoint
	`;
	return toRemote(row!);
}

/** Forgets the repository and its token. The repository itself is not touched. */
export async function disconnectProjectRemote(projectId: string): Promise<boolean> {
	const removed = await sql`DELETE FROM project_remotes WHERE project_id = ${projectId}`;
	return removed.count > 0;
}

/** Projects with a push or pull under way, so that a second one is told to wait. */
const busy = new Set<string>();

/** The connection of a project as Git needs it, with its token opened. Throws if it may not be used. */
async function openConnection(
	projectId: string
): Promise<{ row: RemoteRow; remote: Remote; label: string }> {
	const row = await findRow(projectId);
	if (!row) throw new RemoteUnavailableError('This project is not connected to a repository.');
	if (!remotesEnabled || !gitRemotes.origins.includes(new URL(row.url).origin)) {
		// The administrator's list changed after the project was connected.
		throw new RemoteUnavailableError(
			`This server is no longer set up to connect to ${new URL(row.url).host}.`
		);
	}
	const token = openSecret(gitRemotes.secretKey, TOKEN_PURPOSE, projectId, row.token_sealed);
	const location = new URL(row.url);
	return {
		row,
		remote: { url: row.url, branch: row.branch, username: row.username, token },
		label: `${location.host}${location.pathname.replace(/\.git$/, '')} (${row.branch})`
	};
}

/** Runs one push or pull of a project at a time. */
async function exclusively<T>(projectId: string, work: () => Promise<T>): Promise<T> {
	if (busy.has(projectId)) {
		throw new RemoteUnavailableError('A push or pull of this project is already under way.');
	}
	busy.add(projectId);
	try {
		return await work();
	} finally {
		busy.delete(projectId);
	}
}

/**
 * Pushes a project's checkpoints to its repository and returns the connection
 * as it is afterwards. Throws `RemoteError` with the reason if the forge
 * refuses, `NothingToPushError` before the first checkpoint.
 */
export async function pushProject(projectId: string): Promise<ProjectRemote> {
	const { row, remote } = await openConnection(projectId);
	return exclusively(projectId, async () => {
		// Not under the project's lock: a slow forge must not hold up saving. A push
		// only reads what checkpoints have already written.
		const checkpoint = await new ProjectHistory(projectDir(projectId)).push(remote);
		const [updated] = await sql<RemoteRow[]>`
			UPDATE project_remotes
			SET last_pushed_at = now(), last_pushed_checkpoint = ${checkpoint}
			WHERE project_id = ${projectId} AND url = ${row.url} AND branch = ${row.branch}
			RETURNING url, branch, username, token_sealed, connected_at, last_pushed_at, last_pushed_checkpoint
		`;
		// Disconnected or connected elsewhere while the push ran: report what was pushed to.
		return updated
			? toRemote(updated)
			: { ...toRemote(row), lastPushedAt: new Date(), lastPushedCheckpoint: checkpoint };
	});
}

/** What a pull of a project's repository came to. */
export type PullOutcome = PullResult & { revision?: number };

/**
 * Takes over what the project's repository has (see `ProjectHistory.pull`).
 * Without `choices` it fetches first; with them it settles the conflicts found
 * by an earlier call, which is refused if the project or the repository has
 * changed since. Throws `RemoteError` when the forge cannot be talked to,
 * `PullError` for what may not be taken over, and `WorkspaceLimitError` when
 * the result would not fit in the workspace.
 */
export async function pullProject(input: {
	projectId: string;
	workspaceId: string;
	author: Author;
	choices?: Record<string, 'ours' | 'theirs'>;
	theirs?: string;
	ours?: string;
}): Promise<PullOutcome> {
	const { remote, label } = await openConnection(input.projectId);
	return exclusively(input.projectId, async () => {
		const history = new ProjectHistory(projectDir(input.projectId));
		// Outside the project's lock, like a push: only the merge below needs it.
		const theirs =
			input.theirs ??
			(await history.fetchBranch(
				remote,
				Math.max(treeLimits.maxProjectBytes * 2, 64 * 1024 * 1024)
			));

		const outcome = await withHistory(input.projectId, (locked) =>
			locked.pull({
				theirs,
				author: input.author,
				limits: treeLimits,
				label,
				choices: input.choices,
				expectedOurs: input.ours,
				beforeApply: async ({ bytes }) => {
					const current = (await treeUsage(projectTreeDir(input.projectId))).bytes;
					await assertWorkspaceRoom(input.workspaceId, { bytes: Math.max(0, bytes - current) });
				}
			})
		);
		if (outcome.status !== 'merged') return outcome;
		return { ...outcome, revision: await bumpRevision(input.projectId) };
	});
}
