import { error } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { authorOf } from '#lib/server/history/history.ts';
import { isCheckpointId, PullError, RemoteError } from '#lib/server/history/git.ts';
import {
	getRemoteStatus,
	pullProject,
	RemoteUnavailableError
} from '#lib/server/history/remotes.ts';
import { requireProject } from '#lib/server/http.ts';
import { WorkspaceLimitError } from '#lib/server/projects/projects.ts';
import type { RequestHandler } from './$types';

const MAX_CHOICES = 500;

/** The choices of a request, or null for none: a path of the project and a side for each. */
function parseChoices(value: unknown): Record<string, 'ours' | 'theirs'> | undefined {
	if (value === undefined) return undefined;
	const entries =
		value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value) : null;
	if (!entries || entries.length > MAX_CHOICES) error(400, 'Expected a choice for each file.');
	// No prototype: a path such as `__proto__` is only ever a key.
	const choices: Record<string, 'ours' | 'theirs'> = Object.create(null);
	for (const [path, side] of entries) {
		if (path.length > 512 || (side !== 'ours' && side !== 'theirs')) {
			error(400, 'Expected a choice for each file.');
		}
		choices[path] = side;
	}
	return choices;
}

/**
 * Takes over what the project's repository has. Without a body it fetches and
 * merges; if both sides changed the same files, nothing is applied and the
 * files in conflict are listed. Sent again with a choice for each of them (and
 * the two commits the list named), that choice is applied.
 */
export const POST: RequestHandler = async (event) => {
	const { project, user } = await requireProject(event, 'write');
	const body = (await event.request.json().catch(() => ({}))) as Record<string, unknown> | null;
	const choices = parseChoices(body?.choices);
	const theirs = body?.theirs;
	const ours = body?.ours;
	if (choices && !(isCheckpointId(theirs) && isCheckpointId(ours))) {
		error(400, 'Say which versions the choices are about.');
	}

	let outcome;
	try {
		outcome = await pullProject({
			projectId: project.id,
			workspaceId: project.workspaceId,
			author: authorOf(user),
			choices,
			theirs: choices ? (theirs as string) : undefined,
			ours: choices ? (ours as string) : undefined
		});
	} catch (cause) {
		if (cause instanceof RemoteUnavailableError) error(409, cause.message);
		if (cause instanceof WorkspaceLimitError) error(413, cause.message, { code: 'workspace-full' });
		if (cause instanceof RemoteError) {
			const status = cause.kind === 'no-branch' ? 409 : cause.kind === 'too-large' ? 413 : 502;
			error(status, cause.message, { code: cause.kind });
		}
		if (cause instanceof PullError) {
			const status =
				cause.kind === 'changed'
					? 409
					: cause.kind === 'too-large'
						? 413
						: cause.kind === 'failed'
							? 502
							: 422;
			error(status, cause.message, { code: cause.kind });
		}
		throw cause;
	}

	if (outcome.status === 'merged') {
		await recordAudit(event, 'project.pulled', { subject: project.name });
	}
	return Response.json({ ...outcome, remote: await getRemoteStatus(project.id) });
};
