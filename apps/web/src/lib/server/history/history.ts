import { projectDir } from '../config';
import type { SessionUser } from '../auth/sessions';
import { withProjectLock } from '../projects/lock';
import { ProjectHistory, type Author } from './git';

/**
 * Entry point to a project's version history. Git commands on one repository
 * must not overlap each other or a file change, so they take the project lock.
 */

export function withHistory<T>(
	projectId: string,
	operation: (history: ProjectHistory) => Promise<T>
): Promise<T> {
	return withProjectLock(projectId, () => operation(new ProjectHistory(projectDir(projectId))));
}

const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
/** When each project's files were last recorded or found unchanged, per process. */
const lastSnapshotCheck = new Map<string, number>();

/**
 * Called just before a project's files are changed, while holding the project
 * lock. Records the files as they are — the state before this round of editing —
 * unless that was done in the last ten minutes. `always` skips the interval,
 * for changes that remove content (deleting a file or folder).
 *
 * Never throws: failing to take a snapshot must not prevent the save itself.
 */
export async function snapshotBeforeChange(
	projectId: string,
	options: { always?: boolean } = {}
): Promise<void> {
	const now = Date.now();
	const last = lastSnapshotCheck.get(projectId) ?? 0;
	if (!options.always && now - last < SNAPSHOT_INTERVAL_MS) return;

	try {
		const history = new ProjectHistory(projectDir(projectId));
		await history.takeSnapshot(new Date(now));
		lastSnapshotCheck.set(projectId, now);
		// Thinning looks at every snapshot; once per interval is plenty.
		if (!options.always) await history.thinSnapshots(new Date(now));
	} catch (cause) {
		console.error(`could not take a snapshot of project ${projectId}`, cause);
	}
}

export const authorOf = (user: SessionUser): Author => ({
	name: user.displayName,
	email: user.email
});

/** The first checkpoint of a new project, so its history starts with a known state. */
export async function recordInitialCheckpoint(
	projectId: string,
	message: string,
	user: SessionUser
): Promise<void> {
	try {
		await withHistory(projectId, (history) => history.createCheckpoint(message, authorOf(user)));
	} catch (cause) {
		// A project without its first checkpoint is still fully usable; history starts later.
		console.error(`could not create the initial checkpoint of project ${projectId}`, cause);
	}
}

export function validateCheckpointMessage(input: unknown): string {
	const message = typeof input === 'string' ? input.trim().replace(/\s+/g, ' ') : '';
	if (message.length === 0) return 'Checkpoint';
	return message.slice(0, 200);
}
