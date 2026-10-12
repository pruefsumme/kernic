/**
 * A stand-in for a Git forge (Gitea, Forgejo, …): repositories over Git's own
 * HTTP protocol, behind access tokens. It is real Git on the far side
 * (`git http-backend`), so pushes are accepted and refused as a forge would.
 *
 * Used by the unit tests of pushing (`startForge`) and, run as a program, by
 * the browser tests.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What a token may do. Anything else is no token at all. */
export type Tokens = Record<string, 'write' | 'read'>;

/** One change in a commit made on the forge. */
export type ForgeChange =
	| { path: string; content: string | Buffer; executable?: boolean }
	| { path: string; symlinkTo: string }
	| { path: string; remove: true };

export interface Forge {
	/** `http://127.0.0.1:<port>` */
	origin: string;
	/** Every request received: its path and whether it carried a valid token. */
	requests: { path: string; authorized: boolean }[];
	/** Creates an empty repository `owner/name` and returns its address. */
	createRepository(name: string): Promise<string>;
	/** Adds a commit to a repository's branch behind the back of whoever pushes to it. */
	commitElsewhere(name: string, branch: string, file: string, content: string): Promise<void>;
	/** The same for several changes at once, with the odd things a real repository may hold. */
	commitFiles(
		name: string,
		branch: string,
		changes: ForgeChange[],
		message?: string
	): Promise<void>;
	/** The text of a file at the tip of a branch, or null if there is none. */
	fileText(name: string, branch: string, file: string): Promise<string | null>;
	/** Subjects of the commits on a branch, newest first; empty if there is no such branch. */
	log(name: string, branch: string): Promise<string[]>;
	/** Names of the files at the tip of a branch. */
	files(name: string, branch: string): Promise<string[]>;
	/** Every ref the repository has. */
	refs(name: string): Promise<string[]>;
	close(): Promise<void>;
}

const gitEnvironment = {
	PATH: process.env.PATH,
	GIT_CONFIG_NOSYSTEM: '1',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_AUTHOR_NAME: 'Someone Else',
	GIT_AUTHOR_EMAIL: 'else@example.org',
	GIT_COMMITTER_NAME: 'Someone Else',
	GIT_COMMITTER_EMAIL: 'else@example.org'
};

export async function startForge(options: { port?: number; tokens: Tokens }): Promise<Forge> {
	const root = await mkdtemp(path.join(tmpdir(), 'kernic-fake-forge-'));
	const { stdout: execPath } = await run('git', ['--exec-path']);
	const backend = path.join(execPath.trim(), 'git-http-backend');
	const requests: Forge['requests'] = [];
	const repository = (name: string) => path.join(root, `${name}.git`);
	const git = (name: string, args: string[]) =>
		run('git', [`--git-dir=${repository(name)}`, ...args], { env: gitEnvironment });

	const server = createServer((request, response) => {
		void handle(request, response).catch((cause) => {
			console.error('fake forge', cause);
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? '/', 'http://forge');
		if (url.pathname === '/healthz') {
			response.writeHead(200).end('ok');
			return;
		}

		const [scheme, encoded] = (request.headers.authorization ?? '').split(' ');
		const [, token] = Buffer.from(scheme === 'Basic' ? (encoded ?? '') : '', 'base64')
			.toString()
			.split(':');
		const may = token === undefined ? undefined : options.tokens[token];
		requests.push({ path: url.pathname + url.search, authorized: may !== undefined });

		// What the tests look at, in place of a forge's web pages.
		const inspect = /^\/__forge\/(log|files)\/([\w-]+\/[\w.-]+)\/([\w./-]+)$/.exec(url.pathname);
		if (inspect) {
			const [, what, name, branch] = inspect as unknown as [string, string, string, string];
			const body = what === 'log' ? await forge.log(name, branch) : await forge.files(name, branch);
			response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
			return;
		}
		// The text of one file at the tip of a branch.
		const reading = /^\/__forge\/text\/([\w-]+\/[\w.-]+)\/([\w-]+)\/(.+)$/.exec(url.pathname);
		if (reading) {
			const [, name, branch, file] = reading as unknown as [string, string, string, string];
			const text = await forge.fileText(name, branch, decodeURIComponent(file));
			response
				.writeHead(text === null ? 404 : 200, { 'content-type': 'text/plain' })
				.end(text ?? '');
			return;
		}
		// In place of a forge's "new repository" page: `?busy` puts a commit of someone else in it.
		const creating = /^\/__forge\/new\/([\w-]+\/[\w.-]+)$/.exec(url.pathname);
		if (creating && request.method === 'POST') {
			const address = await forge.createRepository(creating[1]!);
			if (url.searchParams.has('busy')) {
				await forge.commitElsewhere(creating[1]!, 'main', 'README.md', 'Written on the forge.\n');
			}
			response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(address));
			return;
		}
		// In place of someone else's push: `?message=…` names the commit.
		const committing = /^\/__forge\/commit\/([\w-]+\/[\w.-]+)\/([\w-]+)\/(.+)$/.exec(url.pathname);
		if (committing && request.method === 'POST') {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const [, name, branch, file] = committing as unknown as [string, string, string, string];
			const target = decodeURIComponent(file);
			const link = url.searchParams.get('symlink');
			await forge.commitFiles(
				name,
				branch,
				[
					link
						? { path: target, symlinkTo: link }
						: { path: target, content: Buffer.concat(chunks) }
				],
				url.searchParams.get('message') ?? undefined
			);
			response.writeHead(201).end();
			return;
		}
		// A repository that has moved: a forge answers with the new address.
		if (url.pathname.startsWith('/moved/')) {
			const target = `${forge.origin}/${url.pathname.slice('/moved/'.length)}${url.search}`;
			response.writeHead(301, { location: target }).end();
			return;
		}

		if (may === undefined) {
			response.writeHead(401, { 'www-authenticate': 'Basic realm="forge"' }).end();
			return;
		}
		const writes =
			url.pathname.endsWith('/git-receive-pack') ||
			url.searchParams.get('service') === 'git-receive-pack';
		if (writes && may !== 'write') {
			response.writeHead(403).end('this token may only read');
			return;
		}

		const child = spawn(backend, [], {
			env: {
				...gitEnvironment,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: '1',
				REQUEST_METHOD: request.method ?? 'GET',
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: request.headers['content-type'] ?? '',
				...(request.headers['content-length']
					? { CONTENT_LENGTH: request.headers['content-length'] }
					: {}),
				HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
				GIT_PROTOCOL: String(request.headers['git-protocol'] ?? ''),
				// Present only for a request that may write; the backend accepts pushes for it.
				REMOTE_USER: 'someone'
			},
			stdio: ['pipe', 'pipe', 'inherit']
		});
		request.pipe(child.stdin);

		// The backend answers as a CGI program: header lines, an empty line, the body.
		let pending = Buffer.alloc(0);
		let headersDone = false;
		child.stdout.on('data', (chunk: Buffer) => {
			if (headersDone) {
				response.write(chunk);
				return;
			}
			pending = Buffer.concat([pending, chunk]);
			const end = pending.indexOf('\r\n\r\n');
			if (end === -1) return;
			let status = 200;
			const headers: Record<string, string> = {};
			for (const line of pending.subarray(0, end).toString().split('\r\n')) {
				const colon = line.indexOf(':');
				const name = line.slice(0, colon).toLowerCase();
				const value = line.slice(colon + 1).trim();
				if (name === 'status') status = Number(value.split(' ')[0]);
				else headers[name] = value;
			}
			response.writeHead(status, headers);
			response.write(pending.subarray(end + 4));
			headersDone = true;
		});
		await new Promise<void>((resolve) => child.on('close', () => resolve()));
		if (!headersDone) response.writeHead(500);
		response.end();
	}

	await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));

	const forge: Forge = {
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		requests,
		async createRepository(name) {
			await mkdir(path.dirname(repository(name)), { recursive: true });
			await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', repository(name)], {
				env: gitEnvironment
			});
			return `${forge.origin}/${name}.git`;
		},
		async commitElsewhere(name, branch, file, content) {
			await forge.commitFiles(name, branch, [{ path: file, content }], `Edit ${file} elsewhere`);
		},
		async commitFiles(name, branch, changes, message = 'Changes made elsewhere') {
			const scratch = await mkdtemp(path.join(tmpdir(), 'kernic-fake-forge-work-'));
			const environment = { ...gitEnvironment, GIT_INDEX_FILE: path.join(scratch, 'index') };
			const inRepository = (args: string[]) =>
				run('git', [`--git-dir=${repository(name)}`, `--work-tree=${scratch}`, ...args], {
					env: environment
				});
			const exists = (await forge.log(name, branch)).length > 0;
			if (exists) await inRepository(['read-tree', `refs/heads/${branch}`]);
			for (const [number, change] of changes.entries()) {
				if ('remove' in change) {
					await inRepository(['update-index', '--force-remove', '--', change.path]);
					continue;
				}
				const blob = path.join(scratch, `blob-${number}`);
				const link = 'symlinkTo' in change;
				await writeFile(blob, link ? change.symlinkTo : change.content);
				const id = (await inRepository(['hash-object', '-w', blob])).stdout.trim();
				const mode = link ? '120000' : change.executable ? '100755' : '100644';
				await inRepository([
					'update-index',
					'--add',
					'--cacheinfo',
					`${mode},${id},${change.path}`
				]);
			}
			const tree = (await inRepository(['write-tree'])).stdout.trim();
			const parents = exists ? ['-p', `refs/heads/${branch}`] : [];
			const commit = await inRepository(['commit-tree', tree, ...parents, '-m', message]);
			await inRepository(['update-ref', `refs/heads/${branch}`, commit.stdout.trim()]);
			await rm(scratch, { recursive: true, force: true });
		},
		async fileText(name, branch, file) {
			try {
				return (await git(name, ['show', `refs/heads/${branch}:${file}`])).stdout;
			} catch {
				return null;
			}
		},
		async log(name, branch) {
			try {
				const { stdout } = await git(name, ['log', '--format=%s', `refs/heads/${branch}`, '--']);
				return stdout.split('\n').filter((line) => line !== '');
			} catch {
				return [];
			}
		},
		async files(name, branch) {
			try {
				const { stdout } = await git(name, [
					'ls-tree',
					'-r',
					'--name-only',
					`refs/heads/${branch}`
				]);
				return stdout.split('\n').filter((line) => line !== '');
			} catch {
				return [];
			}
		},
		async refs(name) {
			const { stdout } = await git(name, ['for-each-ref', '--format=%(refname)']);
			return stdout.split('\n').filter((line) => line !== '');
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
			await rm(root, { recursive: true, force: true });
		}
	};
	return forge;
}

// Run as a program: the forge of the browser tests, with what they expect to find.
if (import.meta.main) {
	const { forgePort, forgeToken, forgeReadOnlyToken } = await import('./environment.ts');
	const forge = await startForge({
		port: forgePort,
		tokens: { [forgeToken]: 'write', [forgeReadOnlyToken]: 'read' }
	});
	console.log(`fake forge on ${forge.origin}`);
}
