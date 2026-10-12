import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { InvalidPathError, normalizeProjectPath } from '../projects/paths';
import type { TreeLimits } from '../projects/tree';

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
/** Where the newest state of the repository elsewhere is kept, apart from the project's own branch. */
const REMOTE_REF = 'refs/kernic/remote/head';
/** How often a running fetch is checked for how much it has brought in. */
const FETCH_WATCH_MS = 400;
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

	async #gitRemote(
		args: string[],
		remote: Remote,
		watch?: { maxBytes: number; baseline: number }
	): Promise<string> {
		const protocol = new URL(remote.url).protocol.slice(0, -1);
		const credentials = Buffer.from(`${remote.username}:${remote.token}`).toString('base64');
		// Without a token the repository is asked as anyone would: public ones allow that.
		const authorized = remote.token !== '';
		try {
			const { stdout } = await runGit(
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
					...this.#environment,
					...(authorized
						? {
								GIT_CONFIG_COUNT: '1',
								GIT_CONFIG_KEY_0: `http.${remote.url}.extraHeader`,
								GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`
							}
						: {})
				},
				{
					timeoutMs: GIT_REMOTE_TIMEOUT_MS,
					watch: watch && {
						directory: path.join(this.#gitDir, 'objects', 'pack'),
						maxBytes: watch.maxBytes,
						baseline: watch.baseline
					}
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

	/**
	 * Brings in what the repository's branch has, without touching the project's
	 * own branch or files: it is kept under a reference of its own until
	 * `pull` merges it. Returns the commit the branch is at.
	 *
	 * Git is asked to check every object it receives, and to keep what arrives
	 * in one pack file so that its growth can be watched: a fetch that brings in
	 * more than `maxBytes` is stopped and what it wrote is removed.
	 */
	async fetchBranch(remote: Remote, maxBytes: number): Promise<string> {
		await this.#ensureRepository();
		const packs = path.join(this.#gitDir, 'objects', 'pack');
		const baseline = await directoryBytes(packs);
		const before = new Set(await fs.readdir(packs).catch(() => [] as string[]));
		try {
			await this.#gitRemote(
				[
					'-c',
					'transfer.fsckObjects=true',
					'-c',
					'fetch.unpackLimit=1',
					'-c',
					'fetch.recurseSubmodules=false',
					'fetch',
					'--quiet',
					'--no-tags',
					'--no-recurse-submodules',
					'--no-write-fetch-head',
					remote.url,
					`+refs/heads/${remote.branch}:${REMOTE_REF}`
				],
				remote,
				{ maxBytes, baseline }
			);
		} catch (cause) {
			// A fetch that was stopped leaves its half-written pack behind.
			await this.#removeUnfinishedPacks();
			throw cause;
		}
		// A transfer that was over before the watch could stop it is undone just the same.
		if ((await directoryBytes(packs)) - baseline > maxBytes) {
			// Not a garbage collection: this runs without the project's lock, and only
			// the packs that arrived just now are removed.
			await this.#git(['update-ref', '-d', REMOTE_REF]).catch(() => {});
			for (const name of await fs.readdir(packs).catch(() => [] as string[])) {
				if (!before.has(name)) await fs.rm(path.join(packs, name), { force: true });
			}
			throw new RemoteError('too-large');
		}
		return (await this.#git(['rev-parse', '--verify', `${REMOTE_REF}^{commit}`])).trim();
	}

	async #removeUnfinishedPacks(): Promise<void> {
		const directory = path.join(this.#gitDir, 'objects', 'pack');
		for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
			if (name.startsWith('tmp_pack_')) await fs.rm(path.join(directory, name), { force: true });
		}
	}

	/** Forgets what was fetched and frees the space its objects took. Needs the project's lock. */
	async #discardFetched(): Promise<void> {
		try {
			await this.#git(['update-ref', '-d', REMOTE_REF]);
			await this.#git(['gc', '--quiet', '--prune=now']);
		} catch (cause) {
			console.error('could not clean up after a fetch', cause);
		}
	}

	/**
	 * Checks that a commit's files are ones a project may hold, before any of
	 * them is written anywhere: ordinary files only (no links, no submodules),
	 * with names the project accepts and within its size limits.
	 */
	async #inspectTree(
		treeish: string,
		limits: TreeLimits
	): Promise<{ bytes: number; files: number; entries: { path: string; size: number }[] }> {
		const output = await this.#git(['ls-tree', '-r', '-l', '-z', '--full-tree', treeish]);
		let bytes = 0;
		let files = 0;
		const entries: { path: string; size: number }[] = [];
		for (const record of output.split('\0')) {
			if (record === '') continue;
			const entry = /^(\d+) (\w+) [0-9a-f]+ +(-|\d+)\t([\s\S]*)$/.exec(record);
			if (!entry)
				throw new PullError('unsafe-content', 'The repository holds something unreadable.');
			const [, mode, type, size, name] = entry as unknown as [
				string,
				string,
				string,
				string,
				string
			];
			if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
				throw new PullError(
					'unsafe-content',
					`“${name}” is ${type === 'commit' ? 'a submodule' : 'a link'}, not a file. Kernic keeps files only, so nothing was taken over.`
				);
			}
			try {
				if (normalizeProjectPath(name) !== name)
					throw new InvalidPathError('Not in its usual form.');
			} catch (cause) {
				const reason = cause instanceof InvalidPathError ? ` ${cause.message}` : '';
				throw new PullError(
					'unsafe-content',
					`“${name.replace(/\p{Cc}/gu, '?')}” is not a name a project can have.${reason} Nothing was taken over.`
				);
			}
			const length = Number(size);
			if (length > limits.maxFileBytes) {
				throw new PullError(
					'too-large',
					`“${name}” is ${megabytes(length)}, more than a file in a project may be (${megabytes(limits.maxFileBytes)}). Nothing was taken over.`
				);
			}
			bytes += length;
			files++;
			entries.push({ path: name, size: length });
		}
		if (bytes > limits.maxProjectBytes || files > limits.maxProjectFiles) {
			throw new PullError(
				'too-large',
				files > limits.maxProjectFiles
					? `That would make ${files} files, more than a project may have (${limits.maxProjectFiles}). Nothing was taken over.`
					: `That would make ${megabytes(bytes)}, more than a project may be (${megabytes(limits.maxProjectBytes)}). Nothing was taken over.`
			);
		}
		return { bytes, files, entries };
	}

	/**
	 * For a project that is being made from a repository: makes what `fetchBranch`
	 * brought in the project's one and only state, with its history, and writes its
	 * files. The same checks as for a pull come first, so nothing unsuitable is
	 * ever written. Returns the commit and the files.
	 */
	async adoptFetched(
		theirs: string,
		limits: TreeLimits
	): Promise<{ commit: string; files: { path: string; size: number }[] }> {
		await this.#ensureRepository();
		const fetched = (
			await this.#git(['rev-parse', '--verify', '--quiet', REMOTE_REF]).catch(() => '')
		).trim();
		if (!isCheckpointId(theirs) || fetched !== theirs) {
			throw new PullError('changed', CHANGED_MESSAGE);
		}
		const { entries } = await this.#inspectTree(theirs, limits);
		await this.#git(['update-ref', 'HEAD', theirs]);
		await this.#git(['read-tree', '--reset', '-u', theirs]);
		await this.#git(['update-ref', '-d', REMOTE_REF]);
		return { commit: theirs, files: entries };
	}

	/** Runs a command that may exit with a code other than 0 and reports both. */
	async #gitExit(args: string[]): Promise<{ code: number; stdout: string }> {
		try {
			return { code: 0, stdout: await this.#git(args) };
		} catch (cause) {
			const failure = cause as { code?: unknown; stdout?: unknown };
			if (typeof failure.code === 'number') {
				return { code: failure.code, stdout: String(failure.stdout ?? '') };
			}
			throw cause;
		}
	}

	/**
	 * Takes over what `fetchBranch` brought in.
	 *
	 * The current files are recorded as a checkpoint first, so that nothing is
	 * lost and the pull can be undone by restoring it. If the project has not
	 * changed since the repository's branch was last shared, the project simply
	 * moves forward to it; otherwise the two are merged, computed without
	 * touching any file. A merge that is clean is applied. One where both sides
	 * changed the same file is not applied but reported, and applied once there
	 * is a choice for each file (`choices`: keep this project's version or take
	 * the repository's); no conflict markers ever reach the files.
	 *
	 * What comes in is checked before anything is written, as for an upload.
	 */
	async pull(options: {
		/** The commit `fetchBranch` returned; refused if the fetched state has moved on since. */
		theirs: string;
		author: Author;
		limits: TreeLimits;
		/** How the repository is called in the history, such as `git.example.org/ada/thesis`. */
		label: string;
		choices?: Record<string, 'ours' | 'theirs'>;
		/** With `choices`: the checkpoint the conflicts were found against. */
		expectedOurs?: string;
		/** Called with the size of what the project would become, before anything is written. */
		beforeApply?: (incoming: { bytes: number; files: number }) => Promise<void>;
	}): Promise<PullResult> {
		await this.#ensureRepository();
		const { theirs, author, limits, choices } = options;
		if (!isCheckpointId(theirs)) throw new PullError('changed', CHANGED_MESSAGE);
		const fetched = (
			await this.#git(['rev-parse', '--verify', '--quiet', REMOTE_REF]).catch(() => '')
		).trim();
		if (fetched !== theirs) throw new PullError('changed', CHANGED_MESSAGE);

		try {
			await this.#inspectTree(theirs, limits);
		} catch (cause) {
			await this.#discardFetched();
			throw cause;
		}

		const checkpointedHere = (await this.changes()).length > 0 || !(await this.#hasCheckpoints());
		if (checkpointedHere) {
			await this.createCheckpoint(`Before pulling from ${options.label}`, author);
		}
		const ours = (await this.#git(['rev-parse', 'HEAD'])).trim();
		if (choices && (checkpointedHere || options.expectedOurs !== ours)) {
			throw new PullError('changed', CHANGED_MESSAGE);
		}

		const contained = async (ancestor: string, descendant: string) =>
			(await this.#gitExit(['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
		if (await contained(theirs, ours)) return { status: 'up-to-date' };

		let commit: string;
		const fastForward = await contained(ours, theirs);
		if (fastForward) {
			commit = theirs;
		} else {
			const merged = await this.#gitExit([
				'merge-tree',
				'--write-tree',
				'-z',
				'--allow-unrelated-histories',
				ours,
				theirs
			]);
			if (merged.code > 1) throw new PullError('failed', 'The two versions could not be merged.');
			const [mergedTree, ...rest] = merged.stdout.split('\0');
			const stages = new Map<string, Map<number, { mode: string; id: string }>>();
			for (const record of rest) {
				if (record === '') break;
				const entry = /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(record);
				if (!entry) continue;
				const found = stages.get(entry[4]!) ?? new Map();
				found.set(Number(entry[3]), { mode: entry[1]!, id: entry[2]! });
				stages.set(entry[4]!, found);
			}

			let tree = mergedTree!.trim();
			if (merged.code === 1) {
				const conflicts: Conflict[] = [...stages].map(([name, found]) => ({
					path: name,
					kind: found.has(1)
						? found.has(2) && found.has(3)
							? 'both-changed'
							: found.has(2)
								? 'deleted-there'
								: 'deleted-here'
						: 'both-added'
				}));
				conflicts.sort((a, b) => a.path.localeCompare(b.path));
				if (!choices || conflicts.some((conflict) => choices[conflict.path] === undefined)) {
					return { status: 'conflicts', ours, theirs, conflicts, recorded: checkpointedHere };
				}

				// The merged tree holds conflict markers; each conflicted file is replaced by
				// one side's version (or removed, if that side deleted it).
				const index = { GIT_INDEX_FILE: path.join(this.#gitDir, 'kernic-pull-index') };
				try {
					await this.#git(['read-tree', tree], index);
					for (const { path: name } of conflicts) {
						const side = stages.get(name)!.get(choices[name] === 'ours' ? 2 : 3);
						await this.#git(
							side
								? [
										'update-index',
										'--add',
										'--replace',
										'--cacheinfo',
										`${side.mode},${side.id},${name}`
									]
								: ['update-index', '--force-remove', '--', name],
							index
						);
					}
					tree = (await this.#git(['write-tree'], index)).trim();
				} finally {
					await fs.rm(index.GIT_INDEX_FILE, { force: true });
				}
			}

			const identity = (value: string) => value.replace(/[<>\r\n]/g, ' ').trim() || 'Unknown';
			commit = (
				await this.#git(
					['commit-tree', tree, '-p', ours, '-p', theirs, '-m', `Pulled from ${options.label}`],
					{ GIT_AUTHOR_NAME: identity(author.name), GIT_AUTHOR_EMAIL: identity(author.email) }
				)
			).trim();
		}

		const result = await this.#inspectTree(commit, limits);
		await options.beforeApply?.(result);

		try {
			await this.#git(['read-tree', '--reset', '-u', commit]);
		} catch (cause) {
			// Put the files back as they were; the checkpoint made above still holds them.
			await this.#git(['read-tree', '--reset', '-u', ours]).catch(() => {});
			throw cause;
		}
		await this.#git(['update-ref', 'HEAD', commit, ours]);
		await this.#git(['update-ref', '-d', REMOTE_REF]).catch(() => {});
		const changed = (await this.#git(['diff', '--name-only', '-z', ours, commit]))
			.split('\0')
			.filter((name) => name !== '').length;
		return {
			status: 'merged',
			fastForward,
			changed,
			checkpoint: (await this.list(1))[0]!
		};
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

/** A place where both the project and the repository changed, to be settled by choosing a side. */
export type ConflictKind = 'both-changed' | 'both-added' | 'deleted-here' | 'deleted-there';

export interface Conflict {
	path: string;
	kind: ConflictKind;
}

export type PullResult =
	| { status: 'up-to-date' }
	| {
			status: 'conflicts';
			/** The checkpoint of the project and the commit of the repository that clash. */
			ours: string;
			theirs: string;
			conflicts: Conflict[];
			/** Whether unsaved-in-history changes were recorded as a checkpoint to get here. */
			recorded: boolean;
	  }
	| { status: 'merged'; fastForward: boolean; changed: number; checkpoint: Checkpoint };

const CHANGED_MESSAGE =
	'The project or the repository changed while you were choosing. Pull again to see where things stand now.';

/** Why what a repository holds could not be taken over, in words for the person who asked. */
export class PullError extends Error {
	readonly kind: 'unsafe-content' | 'too-large' | 'changed' | 'failed';
	constructor(kind: PullError['kind'], message: string) {
		super(message);
		this.kind = kind;
	}
}

const megabytes = (bytes: number) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`
		: `${Math.max(1, Math.round(bytes / 1024))} KB`;

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
	| 'no-branch'
	| 'too-large'
	| 'failed';

const REMOTE_FAILURE_MESSAGES: Record<RemoteFailure, string> = {
	credentials:
		'The repository did not accept the token, or needs one. Check that it is still valid and may access this repository.',
	'not-found':
		'There is no repository at that address, or the token may not see it. Create an empty repository on the forge first.',
	diverged:
		'The branch of the repository contains commits this project does not have, so nothing was pushed. Pull them first.',
	refused:
		'The repository refused the push. The branch may be protected, or the token may only read.',
	unreachable: 'The server could not reach the forge. Try again later.',
	certificate: 'The certificate of the forge could not be verified, so nothing was sent to it.',
	redirected:
		'The forge answered with a redirect to another address. Enter the address the repository has now.',
	'no-branch': 'The repository has no branch of that name yet. There is nothing to pull from it.',
	'too-large':
		'The repository holds more than this server takes over for a project. Nothing was pulled.',
	failed: "The connection to the repository did not work. The server's log has the details."
};

/** Why talking to a repository did not work, in words for the person who asked. */
export class RemoteError extends Error {
	readonly kind: RemoteFailure;
	constructor(kind: RemoteFailure) {
		super(REMOTE_FAILURE_MESSAGES[kind]);
		this.kind = kind;
	}
}

/**
 * Runs Git and collects what it says. Stops it after `timeoutMs`, or as soon as
 * the directory it writes into has grown by more than `watch.maxBytes`.
 */
function runGit(
	argv: string[],
	env: NodeJS.ProcessEnv,
	options: {
		timeoutMs: number;
		watch?: { directory: string; maxBytes: number; baseline: number };
	}
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('git', argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let killed = false;
		let tooLarge = false;
		const collect = (into: 'out' | 'err') => (chunk: Buffer) => {
			if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) return;
			if (into === 'out') stdout += chunk.toString();
			else stderr += chunk.toString();
		};
		child.stdout.on('data', collect('out'));
		child.stderr.on('data', collect('err'));

		const stop = () => {
			killed = true;
			child.kill('SIGKILL');
		};
		const timer = setTimeout(stop, options.timeoutMs);
		let watcher: ReturnType<typeof setInterval> | undefined;
		if (options.watch) {
			const { directory, maxBytes, baseline } = options.watch;
			let measuring = false;
			watcher = setInterval(() => {
				if (measuring) return;
				measuring = true;
				directoryBytes(directory)
					.then((bytes) => {
						if (bytes - baseline > maxBytes) {
							tooLarge = true;
							stop();
						}
					})
					.finally(() => (measuring = false));
			}, FETCH_WATCH_MS);
		}

		child.on('error', (error) => {
			clearTimeout(timer);
			clearInterval(watcher);
			reject(Object.assign(error, { stdout, stderr, killed, tooLarge }));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			clearInterval(watcher);
			if (code === 0 && !killed) resolve({ stdout, stderr });
			else
				reject(
					Object.assign(new Error(`git exited with ${code}`), {
						code,
						stdout,
						stderr,
						killed,
						tooLarge
					})
				);
		});
	});
}

/** The size of the files directly in a directory. */
async function directoryBytes(directory: string): Promise<number> {
	let total = 0;
	for (const name of await fs.readdir(directory).catch(() => [] as string[])) {
		total += (await fs.stat(path.join(directory, name)).catch(() => null))?.size ?? 0;
	}
	return total;
}

/** Reads Git's complaint (always in English, see `LC_ALL`) into one of the known reasons. */
function explainRemoteFailure(cause: unknown, remote: Remote): RemoteError {
	const failure = cause as {
		stdout?: string;
		stderr?: string;
		killed?: boolean;
		tooLarge?: boolean;
	};
	const output = `${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;
	let kind: RemoteFailure = 'failed';
	if (failure.tooLarge) kind = 'too-large';
	else if (failure.killed) kind = 'unreachable';
	else if (/couldn't find remote ref/.test(output)) kind = 'no-branch';
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
		const scrubbed = (remote.token === '' ? output : output.replaceAll(remote.token, '***')).slice(
			0,
			2000
		);
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
