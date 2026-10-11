import { error } from '@sveltejs/kit';
import {
	closeLanguageConnection,
	findLanguageConnection,
	languageEvents,
	refreshLanguageConnection,
	sendLanguageMessages
} from '#lib/server/compile/language.ts';
import { WorkerRefusedError, WorkerUnavailableError } from '#lib/server/compile/worker-client.ts';
import { readBody, requireProject } from '#lib/server/http.ts';
import type { RequestEvent, RequestHandler } from './$types';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The connection named in the URL, if it is this person's and for this project. */
async function requireConnection(event: RequestEvent) {
	const { project, user } = await requireProject(event, 'read');
	const connection = findLanguageConnection(event.params.connection, user.id, project.id);
	if (!connection) error(404, 'This editor assistance connection has ended.');
	return { connection, project };
}

/** The language server's messages, as server-sent events. */
export const GET: RequestHandler = async (event) => {
	const { connection } = await requireConnection(event);
	const events = await languageEvents(connection).catch((cause) => {
		if (cause instanceof WorkerUnavailableError) return null;
		throw cause;
	});
	if (!events) error(404, 'This editor assistance connection has ended.');

	return new Response(events, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store',
			// For proxies that would otherwise collect the events before passing them on.
			'x-accel-buffering': 'no'
		}
	});
};

/** Messages from the editor to its language server, in order. */
export const POST: RequestHandler = async (event) => {
	const { connection } = await requireConnection(event);
	let body: { messages?: unknown };
	try {
		body = JSON.parse((await readBody(event.request, MAX_BODY_BYTES)).toString('utf8'));
	} catch {
		error(400, 'Expected a JSON body with messages.');
	}
	const delivered = await sendLanguageMessages(connection, body?.messages).catch((cause) => {
		if (cause instanceof WorkerUnavailableError) return false;
		throw cause;
	});
	if (!delivered) error(404, 'This editor assistance connection has ended.');
	return new Response(null, { status: 204 });
};

/** Tells the language server that files of the project were saved or changed. */
export const PUT: RequestHandler = async (event) => {
	const { connection, project } = await requireConnection(event);
	try {
		await refreshLanguageConnection(connection, project.entryPath);
	} catch (cause) {
		if (cause instanceof WorkerRefusedError || cause instanceof WorkerUnavailableError) {
			error(404, 'This editor assistance connection has ended.');
		}
		throw cause;
	}
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async (event) => {
	const { connection } = await requireConnection(event);
	await closeLanguageConnection(connection);
	return new Response(null, { status: 204 });
};
