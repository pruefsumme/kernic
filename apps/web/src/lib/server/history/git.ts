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
 * hooks, no network transports, no prompts.
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
const FIELD = '\x1f';

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

	async #git(args: string[]): Promise<string> {
		const { stdout } = await execFileAsync('git', this.#arguments(args), {
			env: this.#environment,
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
	 * What changed. With one argument: in that checkpoint, compared with the one
	 * before it. With `null`: in the current files, compared with the last checkpoint.
	 */
	async diff(checkpointId: string | null): Promise<FileDiff[]> {
		await this.#ensureRepository();
		const options = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-U3'];

		let output: string;
		if (checkpointId === null) {
			if (!(await this.#hasCheckpoints())) return [];
			// Stage first so new, untracked files show up as additions.
			await this.#git(['add', '--all', '--intent-to-add']);
			output = await this.#git(['diff', ...options, 'HEAD']);
		} else {
			await this.#assertCheckpoint(checkpointId);
			output = await this.#git(['show', ...options, '--format=', checkpointId]);
		}
		return parseDiff(output);
	}

	/**
	 * Brings back the files of an earlier checkpoint. Unsaved-to-history changes
	 * are checkpointed first, so the restore itself can be undone the same way.
	 */
	async restore(checkpointId: string, author: Author): Promise<Checkpoint> {
		await this.#ensureRepository();
		await this.#assertCheckpoint(checkpointId);

		if ((await this.changes()).length > 0) {
			await this.createCheckpoint('Before restoring an earlier checkpoint', author);
		}

		const [target] = (await this.#git(['log', '-1', '--format=%s', checkpointId])).split('\n');
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

	/** A ZIP archive of the files as they were at a checkpoint. */
	async archive(checkpointId: string): Promise<Readable> {
		await this.#ensureRepository();
		await this.#assertCheckpoint(checkpointId);
		const child = spawn('git', this.#arguments(['archive', '--format=zip', checkpointId]), {
			env: this.#environment,
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return child.stdout;
	}
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
