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
