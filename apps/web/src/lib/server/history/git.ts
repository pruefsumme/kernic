import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';

/**
 * Version history of a project, kept in a Git repository next to its files.
 *
 * The repository lives outside the working tree (`repo.git` beside `tree/`), so
 * project files can never contain or modify Git's own configuration or hooks.
 * Git is run with a fixed, minimal configuration: no system or user config, no
 * hooks, no prompts, and no network transports except in the few commands that
 * talk to a repository elsewhere (see "A repository elsewhere" below).
 *
 * History only moves forward. Restoring an older checkpoint records the current
 * state first and then adds a new checkpoint with the old content; nothing is
 * ever rewritten or dropped.
 */

const execFileAsync = promisify(execFile);

export interface Checkpoint {
	id: string;
	message: string;
	authorName: string;
	createdAt: Date;
}

/** An automatic record of the files, taken between checkpoints. */
export interface Snapshot {
	id: string;
	createdAt: Date;
}

export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface Change {
	path: string;
	kind: ChangeKind;
}

export interface DiffLine {
	kind: 'context' | 'added' | 'removed' | 'hunk';
	text: string;
}

export interface FileDiff {
	path: string;
	/** Previous path, when the file was renamed. */
	previousPath: string | null;
	kind: ChangeKind;
	binary: boolean;
	lines: DiffLine[];
	/** True when the diff was cut off because it is very long. */
	truncated: boolean;
}

export interface Author {
	name: string;
	email: string;
}

export class NothingToCheckpointError extends Error {
	constructor() {
		super('Nothing has changed since the last checkpoint.');
	}
}

export class UnknownCheckpointError extends Error {
	constructor() {
		super('That checkpoint does not exist in this project.');
	}
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_LINES_PER_FILE = 1500;
const GIT_TIMEOUT_MS = 60_000;
const GIT_REMOTE_TIMEOUT_MS = 120_000;
const FIELD = '\x1f';

const SNAPSHOT_REFS = 'refs/kernic/snapshots/';
const SNAPSHOT_KEEP_ALL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_KEEP_DAILY_MS = 30 * 24 * 60 * 60 * 1000;

const COMMIT_ID = /^[0-9a-f]{40}$/;
export function isCheckpointId(value: unknown): value is string {
	return typeof value === 'string' && COMMIT_ID.test(value);
}

export class ProjectHistory {
	readonly #gitDir: string;
	readonly #workTree: string;

	/** `projectDirectory` is the folder that contains the project's `tree/`. */
	constructor(projectDirectory: string) {
		this.#gitDir = path.join(projectDirectory, 'repo.git');
		this.#workTree = path.join(projectDirectory, 'tree');
	}

	#arguments(args: string[]): string[] {
		return [
			`--git-dir=${this.#gitDir}`,
			`--work-tree=${this.#workTree}`,
			'-c',
			'core.bare=false',
			// Project files are untrusted: nothing in them may run code or change behaviour.
			'-c',
			'core.hooksPath=/dev/null',
			'-c',
			'core.fsmonitor=false',
			'-c',
			'core.symlinks=false',
			'-c',
			'core.autocrlf=false',
			'-c',
			'core.quotePath=false',
			'-c',
			'protocol.allow=never',
			'-c',
			'commit.gpgSign=false',
			'-c',
			'gc.auto=0',
			'-c',
			'user.name=Kernic',
			'-c',
			'user.email=kernic@localhost',
			...args
		];
	}

	get #environment(): NodeJS.ProcessEnv {
		return {
			PATH: process.env.PATH,
			// Ignore any Git configuration of the machine or the account the server runs as.
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_TERMINAL_PROMPT: '0',
			GIT_OPTIONAL_LOCKS: '0',
			HOME: this.#gitDir,
			LC_ALL: 'C'
		};
	}

	async #git(args: string[], extraEnvironment: Record<string, string> = {}): Promise<string> {
		const { stdout } = await execFileAsync('git', this.#arguments(args), {
			env: { ...this.#environment, ...extraEnvironment },
			maxBuffer: MAX_OUTPUT_BYTES,
			timeout: GIT_TIMEOUT_MS
		});
		return stdout;
	}

	/** Creates the repository if the project does not have one yet. */
	async #ensureRepository(): Promise<void> {
		try {
			await fs.access(path.join(this.#gitDir, 'HEAD'));
			return;
		} catch {
			// first use
		}
		await fs.mkdir(this.#workTree, { recursive: true });
		await execFileAsync(
			'git',
			['init', '--quiet', '--bare', '--initial-branch=main', this.#gitDir],
			{
				env: this.#environment,
				timeout: GIT_TIMEOUT_MS
			}
		);
	}

	async #hasCheckpoints(): Promise<boolean> {
		try {
			await this.#git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
			return true;
		} catch {
			return false;
		}
	}

	async #assertCheckpoint(id: string): Promise<void> {
		if (!isCheckpointId(id)) throw new UnknownCheckpointError();
		try {
			// Only commits reachable from the project's history count as its checkpoints.
			await this.#git(['merge-base', '--is-ancestor', id, 'HEAD']);
		} catch {
			throw new UnknownCheckpointError();
		}
	}

	/** Accepts a checkpoint or an automatic snapshot of this project, nothing else. */
	async #assertVersion(id: string): Promise<'checkpoint' | Snapshot> {
		if (!isCheckpointId(id)) throw new UnknownCheckpointError();
		const snapshot = (await this.snapshots()).find((candidate) => candidate.id === id);
		if (snapshot) return snapshot;
		await this.#assertCheckpoint(id);
		return 'checkpoint';
	}

	// --- Automatic snapshots --------------------------------------------------
	//
	// A snapshot is a commit without parents under refs/kernic/snapshots/<time>.
	// It is written with a separate index, so neither the branch, nor the staging
	// area of checkpoints, nor the working files are touched. Checkpoints stay the
	// only thing on the branch — the history a person curates and may later push.

	async #snapshotRefs(): Promise<(Snapshot & { ref: string; tree: string })[]> {
		const output = await this.#git([
			'for-each-ref',
			'--sort=-refname',
			`--format=%(objectname)${FIELD}%(refname)${FIELD}%(tree)`,
			SNAPSHOT_REFS
		]);
		return output
			.split('\n')
			.filter((line) => line !== '')
			.map((line) => {
				const [id, ref, tree] = line.split(FIELD);
				return {
					id: id!,
					ref: ref!,
					tree: tree!,
					createdAt: new Date(Number(ref!.slice(SNAPSHOT_REFS.length)) * 1000)
				};
			});
	}

	/** Automatic snapshots, newest first. */
	async snapshots(): Promise<Snapshot[]> {
		await this.#ensureRepository();
		return (await this.#snapshotRefs()).map(({ id, createdAt }) => ({ id, createdAt }));
	}

	/**
	 * Records the current files as an automatic snapshot. Returns null when they
	 * are already recorded, as the newest snapshot or as the last checkpoint.
	 */
	async takeSnapshot(now = new Date()): Promise<Snapshot | null> {
		await this.#ensureRepository();
		const index = { GIT_INDEX_FILE: path.join(this.#gitDir, 'kernic-snapshot-index') };
		await this.#git(['add', '--all'], index);
		const tree = (await this.#git(['write-tree'], index)).trim();

		const [newest] = await this.#snapshotRefs();
		if (newest?.tree === tree) return null;
		if (await this.#hasCheckpoints()) {
			const checkpointTree = (await this.#git(['rev-parse', 'HEAD^{tree}'])).trim();
			if (checkpointTree === tree) return null;
		}

		const seconds = Math.floor(now.getTime() / 1000);
		const date = `${seconds} +0000`;
		const id = (
			await this.#git(['commit-tree', tree, '-m', 'Automatic snapshot'], {
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_DATE: date
			})
		).trim();
		await this.#git(['update-ref', `${SNAPSHOT_REFS}${seconds}`, id]);
		return { id, createdAt: new Date(seconds * 1000) };
	}

	/**
	 * Drops snapshots that are no longer worth keeping: everything from the last
	 * day stays, then the last snapshot of each day for a month. Checkpoints are
	 * never removed. Returns how many snapshots were dropped.
	 */
	async thinSnapshots(now = new Date()): Promise<number> {
		await this.#ensureRepository();
		const keptDays = new Set<string>();
		let dropped = 0;

		// Newest first, so the first snapshot seen for a day is that day's last.
		for (const snapshot of await this.#snapshotRefs()) {
			const age = now.getTime() - snapshot.createdAt.getTime();
			if (age <= SNAPSHOT_KEEP_ALL_MS) continue;

			const day = snapshot.createdAt.toISOString().slice(0, 10);
			if (age <= SNAPSHOT_KEEP_DAILY_MS && !keptDays.has(day)) {
				keptDays.add(day);
				continue;
			}
			await this.#git(['update-ref', '-d', snapshot.ref]);
			dropped++;
		}

		// Reclaim the space of dropped snapshots and pack what saving accumulated.
		if (dropped > 0) await this.#git(['gc', '--quiet', '--prune=now']);
		return dropped;
	}

	/** Files that differ from the last checkpoint. */
	async changes(): Promise<Change[]> {
		await this.#ensureRepository();
		const output = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
		const changes: Change[] = [];
		for (const record of output.split('\0')) {
			if (record.length < 4) continue;
			const state = record.slice(0, 2);
			const kind: ChangeKind =
				state === '??' || state.includes('A')
					? 'added'
					: state.includes('D')
						? 'deleted'
						: 'modified';
			changes.push({ path: record.slice(3), kind });
		}
		return changes.sort((a, b) => a.path.localeCompare(b.path));
	}

	/** Records the current files as a checkpoint. */
	async createCheckpoint(message: string, author: Author): Promise<Checkpoint> {
		await this.#ensureRepository();
		await this.#git(['add', '--all']);

		const staged = await this.#git(['status', '--porcelain=v1', '-z']);
		if (staged.length === 0 && (await this.#hasCheckpoints())) throw new NothingToCheckpointError();

		// Angle brackets and line breaks would corrupt the author field.
		const clean = (value: string) => value.replace(/[<>\r\n]/g, ' ').trim() || 'Unknown';
		await this.#git([
			'commit',
			'--quiet',
			'--allow-empty',
			'--no-verify',
			`--author=${clean(author.name)} <${clean(author.email)}>`,
			'-m',
			message
		]);
		return (await this.list(1))[0]!;
	}

	/** Checkpoints, newest first. */
	async list(limit = 200): Promise<Checkpoint[]> {
		await this.#ensureRepository();
		if (!(await this.#hasCheckpoints())) return [];

		const output = await this.#git([
			'log',
			'-z',
			`--max-count=${limit}`,
			`--format=%H${FIELD}%an${FIELD}%at${FIELD}%s`
		]);
		return output
			.split('\0')
			.filter((record) => record !== '')
			.map((record) => {
				const [id, authorName, timestamp, message] = record.split(FIELD);
				return {
					id: id!,
					authorName: authorName!,
					createdAt: new Date(Number(timestamp) * 1000),
					message: message ?? ''
				};
			});
	}

	/**
	 * What changed.
	 * - `null`: in the current files, compared with the last checkpoint.
	 * - a checkpoint: in that checkpoint, compared with the one before it.
	 * - a snapshot: in the current files, compared with that snapshot — what
	 *   restoring it would undo.
	 */
	async diff(versionId: string | null): Promise<FileDiff[]> {
		await this.#ensureRepository();
		const options = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-U3'];

		if (versionId === null) {
			if (!(await this.#hasCheckpoints())) return [];
			return parseDiff(await this.#diffAgainstFiles(options, 'HEAD'));
		}
		const version = await this.#assertVersion(versionId);
		return parseDiff(
			version === 'checkpoint'
				? await this.#git(['show', ...options, '--format=', versionId])
				: await this.#diffAgainstFiles(options, versionId)
		);
	}

	/** Diff from a commit to the files on disk, new files included. */
	async #diffAgainstFiles(options: string[], commit: string): Promise<string> {
		// Stage first so new, untracked files show up as additions.
		await this.#git(['add', '--all', '--intent-to-add']);
		return this.#git(['diff', ...options, commit]);
	}

	/**
	 * Brings back the files of an earlier checkpoint or snapshot. Changes not yet
	 * in the history are checkpointed first, so the restore itself can be undone.
	 */
	async restore(checkpointId: string, author: Author): Promise<Checkpoint> {
		await this.#ensureRepository();
		const version = await this.#assertVersion(checkpointId);

		if ((await this.changes()).length > 0) {
			await this.createCheckpoint(
				version === 'checkpoint'
					? 'Before restoring an earlier checkpoint'
					: 'Before restoring an automatic snapshot',
				author
			);
		}

		const target =
			version === 'checkpoint'
				? (await this.#git(['log', '-1', '--format=%s', checkpointId])).split('\n')[0]
				: `Automatic snapshot of ${version.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
		// Make index and files match the old checkpoint exactly, including deletions.
		await this.#git(['read-tree', '--reset', '-u', checkpointId]);
		try {
			// HEAD still points at the newest checkpoint, so this adds to the history.
			return await this.createCheckpoint(`Restored “${target}”`, author);
		} catch (error) {
			// The files already were in that state; there is nothing new to record.
			if (error instanceof NothingToCheckpointError) return (await this.list(1))[0]!;
			throw error;
		}
	}

	/** A ZIP archive of the files as they were at a checkpoint or snapshot. */
	async archive(checkpointId: string): Promise<Readable> {
		await this.#ensureRepository();
		await this.#assertVersion(checkpointId);
		const child = spawn('git', this.#arguments(['archive', '--format=zip', checkpointId]), {
			env: this.#environment,
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return child.stdout;
	}

	// --- A repository elsewhere ----------------------------------------------
	//
	// The only commands that use the network. They may talk to the one address
	// they are given, over HTTP(S), without following it anywhere else, and the
	// token travels in the environment of the one Git process that needs it:
	// never in its arguments, the repository's configuration or a message.

	async #gitRemote(args: string[], remote: Remote): Promise<string> {
		const protocol = new URL(remote.url).protocol.slice(0, -1);
		const credentials = Buffer.from(`${remote.username}:${remote.token}`).toString('base64');
		try {
			const { stdout } = await execFileAsync(
				'git',
				this.#arguments([
					// After `protocol.allow=never`: this one protocol, for this one command.
					'-c',
					`protocol.${protocol}.allow=always`,
					// A forge that answers "go elsewhere" is not followed there with the token.
					'-c',
					'http.followRedirects=false',
					'-c',
					'credential.helper=',
					// Gives up on a connection that stalls instead of holding it open.
					'-c',
					'http.lowSpeedLimit=1000',
					'-c',
					'http.lowSpeedTime=30',
					...args
				]),
				{
					env: {
						...this.#environment,
						GIT_CONFIG_COUNT: '1',
						GIT_CONFIG_KEY_0: `http.${remote.url}.extraHeader`,
						GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`
					},
					maxBuffer: MAX_OUTPUT_BYTES,
					timeout: GIT_REMOTE_TIMEOUT_MS
				}
			);
			return stdout;
		} catch (cause) {
			throw explainRemoteFailure(cause, remote);
		}
	}

	/** The newest checkpoint, or null if there is none yet. */
	async head(): Promise<string | null> {
		await this.#ensureRepository();
		if (!(await this.#hasCheckpoints())) return null;
		return (await this.#git(['rev-parse', 'HEAD'])).trim();
	}

	/**
	 * How many checkpoints were made after the given one; all of them if it is
	 * not part of this project's history (any more).
	 */
	async checkpointsSince(checkpointId: string | null): Promise<number> {
		await this.#ensureRepository();
		if (!(await this.#hasCheckpoints())) return 0;
		let range = 'HEAD';
		if (checkpointId !== null && isCheckpointId(checkpointId)) {
			try {
				await this.#git(['merge-base', '--is-ancestor', checkpointId, 'HEAD']);
				range = `${checkpointId}..HEAD`;
			} catch {
				// not an ancestor: everything counts
			}
		}
		return Number((await this.#git(['rev-list', '--count', range])).trim());
	}

	/**
	 * Asks the repository for its branch: proof that the address and the token
	 * work. Returns the commit the branch is at, or null if it does not exist yet.
	 */
	async lookAtRemote(remote: Remote): Promise<string | null> {
		await this.#ensureRepository();
		const output = await this.#gitRemote(
			['ls-remote', '--heads', remote.url, `refs/heads/${remote.branch}`],
			remote
		);
		const id = output.split('\t')[0]?.trim() ?? '';
		return isCheckpointId(id) ? id : null;
	}

	/**
	 * Sends the checkpoints to the repository's branch. Only ever adds to it: if
	 * the branch holds commits this project does not have, nothing is sent and a
	 * `RemoteError` of kind `diverged` says so. Returns the checkpoint now there.
	 */
	async push(remote: Remote): Promise<string> {
		const head = await this.head();
		if (head === null) throw new NothingToPushError();
		await this.#gitRemote(
			['push', '--porcelain', '--no-verify', remote.url, `${head}:refs/heads/${remote.branch}`],
			remote
		);
		return head;
	}
}

/** A repository elsewhere and what is needed to write to it. */
export interface Remote {
	/** As checked by `parseRemoteUrl`. */
	url: string;
	branch: string;
	username: string;
	token: string;
}

export class NothingToPushError extends Error {
	constructor() {
		super('There is no checkpoint to push yet. Create one first.');
	}
}

export type RemoteFailure =
	| 'credentials'
	| 'not-found'
	| 'diverged'
	| 'refused'
	| 'unreachable'
	| 'certificate'
	| 'redirected'
	| 'failed';

const REMOTE_FAILURE_MESSAGES: Record<RemoteFailure, string> = {
	credentials:
		'The repository did not accept the token. Check that it is still valid and may write to this repository.',
	'not-found':
		'There is no repository at that address, or the token may not see it. Create an empty repository on the forge first.',
	diverged:
		'The branch of the repository contains commits this project does not have, so nothing was pushed. Use an empty branch or repository; taking changes over from a repository is not possible yet.',
	refused:
		'The repository refused the push. The branch may be protected, or the token may only read.',
	unreachable: 'The server could not reach the forge. Try again later.',
	certificate: 'The certificate of the forge could not be verified, so nothing was sent to it.',
	redirected:
		'The forge answered with a redirect to another address. Enter the address the repository has now.',
	failed: "The push did not work. The server's log has the details."
};

/** Why talking to a repository did not work, in words for the person who asked. */
export class RemoteError extends Error {
	readonly kind: RemoteFailure;
	constructor(kind: RemoteFailure) {
		super(REMOTE_FAILURE_MESSAGES[kind]);
		this.kind = kind;
	}
}

/** Reads Git's complaint (always in English, see `LC_ALL`) into one of the known reasons. */
function explainRemoteFailure(cause: unknown, remote: Remote): RemoteError {
	const failure = cause as { stdout?: string; stderr?: string; killed?: boolean };
	const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
	let kind: RemoteFailure = 'failed';
	if (failure.killed) kind = 'unreachable';
	else if (/\[rejected\]|non-fast-forward|fetch first/.test(output)) kind = 'diverged';
	else if (/\[remote rejected\]|protected branch|pre-receive hook declined/.test(output))
		kind = 'refused';
	else if (/Authentication failed|error: 401|could not read Username/.test(output))
		kind = 'credentials';
	else if (/error: 403/.test(output)) kind = 'refused';
	else if (/not found|error: 404/.test(output)) kind = 'not-found';
	else if (/error: 30\d|redirect/i.test(output)) kind = 'redirected';
	else if (/SSL|certificate/i.test(output)) kind = 'certificate';
	else if (
		/Could not resolve host|Failed to connect|Connection refused|timed out|Couldn't connect|transfer closed|Operation too slow/i.test(
			output
		)
	)
		kind = 'unreachable';

	if (kind === 'failed') {
		// Never the token, not even by accident of a message quoting a header.
		const scrubbed = output.replaceAll(remote.token, '***').slice(0, 2000);
		console.error(`git could not talk to ${remote.url}:\n${scrubbed}`);
	}
	return new RemoteError(kind);
}

const HEADER = /^diff --git a\/(.*) b\/(.*)$/;

/** Parses `git diff` output into one entry per file. */
export function parseDiff(output: string): FileDiff[] {
	const files: FileDiff[] = [];
	let current: FileDiff | null = null;
	let inHunks = false;

	for (const line of output.split('\n')) {
		const header = HEADER.exec(line);
		if (header) {
			current = {
				path: header[2]!,
				previousPath: null,
				kind: 'modified',
				binary: false,
				lines: [],
				truncated: false
			};
			files.push(current);
			inHunks = false;
			continue;
		}
		if (!current) continue;

		if (!inHunks) {
			if (line.startsWith('new file mode')) current.kind = 'added';
			else if (line.startsWith('deleted file mode')) current.kind = 'deleted';
			else if (line.startsWith('rename from ')) {
				current.kind = 'renamed';
				current.previousPath = line.slice('rename from '.length);
			} else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
				current.binary = true;
			} else if (line.startsWith('@@')) {
				inHunks = true;
			}
		}
		if (!inHunks) continue;

		if (current.lines.length >= MAX_DIFF_LINES_PER_FILE) {
			current.truncated = true;
			continue;
		}
		if (line.startsWith('@@')) current.lines.push({ kind: 'hunk', text: line });
		else if (line.startsWith('+')) current.lines.push({ kind: 'added', text: line.slice(1) });
		else if (line.startsWith('-')) current.lines.push({ kind: 'removed', text: line.slice(1) });
		else if (line.startsWith(' ')) current.lines.push({ kind: 'context', text: line.slice(1) });
		// "\ No newline at end of file" and the trailing empty line are not content.
	}
	return files;
}
