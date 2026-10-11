import { randomBytes } from 'node:crypto';
import { projectTreeDir } from '../config';
import { snapshotWithPackages } from './compile-project';
import {
	languageServerStream,
	sendToLanguageServer,
	startLanguageServer,
	stopLanguageServer
} from './worker-client';

/**
 * Editor assistance: each open editor gets a connection to a language server
 * in the compile worker. The browser never talks to the worker; this module
 * remembers which connection belongs to which person and project, and passes
 * messages on for exactly that pair.
 *
 * Connections live in memory. After a restart of the app the editors open new
 * ones, and the worker stops servers nobody listens to.
 */

interface Connection {
	id: string;
	userId: string;
	projectId: string;
	openedAt: number;
}

/** Editors one person may have assisted at the same time; opening another closes the oldest. */
const MAX_CONNECTIONS_PER_USER = 3;
const MAX_MESSAGES_PER_REQUEST = 256;

const connections = new Map<string, Connection>();

async function syncProject(connection: Connection, entryPath: string): Promise<void> {
	const root = projectTreeDir(connection.projectId);
	const { snapshot, packages } = await snapshotWithPackages(root);
	await startLanguageServer({
		name: connection.id,
		entry: entryPath,
		root,
		files: snapshot.files,
		packages
	});
}

/**
 * Opens a connection for one editor. Throws `WorkerRefusedError` (assistance
 * is not offered, or all places are taken) or `WorkerUnavailableError`.
 */
export async function openLanguageConnection(input: {
	userId: string;
	projectId: string;
	entryPath: string;
}): Promise<string> {
	const mine = [...connections.values()]
		.filter((connection) => connection.userId === input.userId)
		.sort((a, b) => a.openedAt - b.openedAt);
	while (mine.length >= MAX_CONNECTIONS_PER_USER) await closeLanguageConnection(mine.shift()!);

	// Unguessable, and a valid name for a server in the worker.
	const connection: Connection = {
		id: randomBytes(24).toString('hex'),
		userId: input.userId,
		projectId: input.projectId,
		openedAt: Date.now()
	};
	await syncProject(connection, input.entryPath);
	connections.set(connection.id, connection);
	return connection.id;
}

/** The connection, if it belongs to this person and project. */
export function findLanguageConnection(
	id: string,
	userId: string,
	projectId: string
): Connection | null {
	const connection = connections.get(id);
	return connection?.userId === userId && connection.projectId === projectId ? connection : null;
}

/** Gives the language server the project's current files, after a save or an upload. */
export async function refreshLanguageConnection(
	connection: Connection,
	entryPath: string
): Promise<void> {
	await syncProject(connection, entryPath);
}

/** Passes protocol messages on. False if the language server has ended. */
export async function sendLanguageMessages(
	connection: Connection,
	messages: unknown
): Promise<boolean> {
	if (!Array.isArray(messages) || messages.length > MAX_MESSAGES_PER_REQUEST) return true;
	const delivered = await sendToLanguageServer(connection.id, messages);
	if (!delivered) connections.delete(connection.id);
	return delivered;
}

/**
 * The language server's messages as server-sent events, one message per
 * event, ending with an `end` event when the server stops.
 */
export async function languageEvents(
	connection: Connection
): Promise<ReadableStream<Uint8Array> | null> {
	const abort = new AbortController();
	const source = await languageServerStream(connection.id, abort.signal);
	if (!source) {
		connections.delete(connection.id);
		return null;
	}

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const reader = source.getReader();
	let heartbeat: ReturnType<typeof setInterval>;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			// Keeps proxies from closing a connection on which nothing is said for a while.
			heartbeat = setInterval(() => controller.enqueue(encoder.encode(': keep-alive\n\n')), 25_000);

			void (async () => {
				let pending = '';
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						pending += decoder.decode(value, { stream: true });
						for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
							controller.enqueue(encoder.encode(`data: ${pending.slice(0, end)}\n\n`));
							pending = pending.slice(end + 1);
						}
					}
					controller.enqueue(encoder.encode('event: end\ndata: {}\n\n'));
				} catch {
					// The editor went away or the worker did; either way this stream is over.
				}
				clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					// already cancelled
				}
			})();
		},
		cancel() {
			clearInterval(heartbeat);
			abort.abort();
		}
	});
}

export async function closeLanguageConnection(connection: Connection): Promise<void> {
	connections.delete(connection.id);
	await stopLanguageServer(connection.id);
}
