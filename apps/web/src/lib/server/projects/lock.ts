/**
 * One change at a time per project. Saving files, moving them, restoring a
 * checkpoint and recording one all pass through here, so that a checkpoint
 * never captures a half-applied change and a restore is not interleaved with a
 * save. Reading (listing, downloading, compiling) does not take the lock.
 *
 * The lock is in memory, which is correct while the app runs as one process.
 */

const queues = new Map<string, Promise<unknown>>();

export function withProjectLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
	const previous = queues.get(projectId) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(operation);
	queues.set(projectId, next);
	// Forget the queue once it has drained, so the map does not grow with every project.
	void next
		.catch(() => {})
		.finally(() => {
			if (queues.get(projectId) === next) queues.delete(projectId);
		});
	return next;
}
