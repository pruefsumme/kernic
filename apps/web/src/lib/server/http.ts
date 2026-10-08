import { error, type RequestEvent } from '@sveltejs/kit';
import type { SessionUser } from './auth/sessions';
import { NothingToCheckpointError, UnknownCheckpointError } from './history/git';
import { InvalidPathError } from './projects/paths';
import {
	ProjectInputError,
	canWrite,
	getProjectAccess,
	type ProjectAccess
} from './projects/projects';
import { TreeError, type TreeErrorCode } from './projects/tree';

/** Helpers shared by route handlers: authentication, authorization and error mapping. */

export function requireUser(event: RequestEvent): SessionUser {
	if (!event.locals.user) error(401, 'Sign in to continue.');
	return event.locals.user;
}

/**
 * Loads the project named by the `projectId` route parameter and checks the
 * signed-in user's access to it. Every project route — pages, file downloads,
 * job status and artifacts — goes through this.
 */
export async function requireProject(
	event: RequestEvent,
	need: 'read' | 'write'
): Promise<ProjectAccess & { user: SessionUser }> {
	const user = requireUser(event);
	const access = await getProjectAccess(user.id, event.params.projectId ?? '');
	// Same answer for "does not exist" and "not yours", so project ids cannot be probed.
	if (!access) error(404, 'Project not found.');
	if (need === 'write' && !canWrite(access.role)) {
		error(403, 'You have read-only access to this project.');
	}
	return { ...access, user };
}

const TREE_ERROR_STATUS: Record<TreeErrorCode, number> = {
	'invalid-path': 400,
	'not-found': 404,
	'already-exists': 409,
	'not-a-file': 400,
	'not-a-directory': 400,
	conflict: 409,
	'file-too-large': 413,
	'project-too-large': 413,
	'too-many-files': 413
};

/** Turns expected domain errors into HTTP errors; rethrows everything else. */
export function throwAsHttpError(cause: unknown): never {
	if (cause instanceof TreeError)
		error(TREE_ERROR_STATUS[cause.code], cause.message, { code: cause.code });
	if (cause instanceof InvalidPathError) error(400, cause.message, { code: 'invalid-path' });
	if (cause instanceof ProjectInputError) error(400, cause.message);
	if (cause instanceof NothingToCheckpointError) error(409, cause.message, { code: 'no-changes' });
	if (cause instanceof UnknownCheckpointError) error(404, cause.message);
	throw cause;
}

/**
 * Reads a request body into memory, refusing bodies above `maxBytes` without
 * buffering them first.
 */
export async function readBody(request: Request, maxBytes: number): Promise<Buffer> {
	const declared = Number(request.headers.get('content-length') ?? '0');
	if (declared > maxBytes) error(413, 'The upload is too large.', { code: 'file-too-large' });
	if (!request.body) return Buffer.alloc(0);

	const chunks: Uint8Array[] = [];
	let received = 0;
	for await (const chunk of request.body) {
		received += chunk.byteLength;
		if (received > maxBytes) error(413, 'The upload is too large.', { code: 'file-too-large' });
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** `Content-Disposition` value that downloads a response under a readable file name. */
export function attachment(name: string, extension: string): string {
	// Characters that are invalid in file names on common systems become dashes.
	// eslint-disable-next-line no-control-regex
	const safeName = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-');
	return `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName}.${extension}`)}`;
}
