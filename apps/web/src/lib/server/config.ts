import { building } from '$app/env';
import {
	KERNIC_DATA_DIR,
	KERNIC_GIT_HOSTS,
	KERNIC_MAX_FILE_MB,
	KERNIC_MAX_PROJECT_FILES,
	KERNIC_MAX_PROJECT_MB,
	KERNIC_MAX_WAITING_COMPILES,
	KERNIC_MAX_WORKSPACE_MB,
	KERNIC_MAX_WORKSPACE_PROJECTS,
	KERNIC_SECRET_KEY
} from '$app/env/private';
import path from 'node:path';
import { parseAllowedOrigins } from './history/remote-url';
import type { TreeLimits } from './projects/tree';

export const dataDir = path.resolve(KERNIC_DATA_DIR);

export const treeLimits: TreeLimits = {
	maxFileBytes: KERNIC_MAX_FILE_MB,
	maxProjectBytes: KERNIC_MAX_PROJECT_MB,
	maxProjectFiles: KERNIC_MAX_PROJECT_FILES
};

/**
 * What one workspace, and one account, may use of a server that is shared with
 * others. Self-hosters set these to what their server can carry.
 */
export const workspaceLimits = {
	maxBytes: KERNIC_MAX_WORKSPACE_MB,
	maxProjects: KERNIC_MAX_WORKSPACE_PROJECTS
};
export const maxWaitingCompiles = KERNIC_MAX_WAITING_COMPILES;

/**
 * Git repositories elsewhere. The server opens connections to them itself, so
 * it only does so to hosts its administrator has listed; without a list,
 * projects cannot be connected to a repository at all. The key encrypts the
 * access tokens people enter.
 */
export const gitRemotes = {
	origins: parseAllowedOrigins(KERNIC_GIT_HOSTS),
	secretKey: KERNIC_SECRET_KEY
};
if (!building && gitRemotes.origins.length > 0 && gitRemotes.secretKey.length < 32) {
	throw new Error(
		'KERNIC_GIT_HOSTS is set, so KERNIC_SECRET_KEY must be set too, to at least 32 characters. ' +
			'It encrypts the access tokens of repositories; keep it, or they have to be entered again.'
	);
}

/** Largest text file the editor will open or save. Larger files are treated as assets. */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024;

/** Working tree of a project: the files the user edits and Typst compiles. */
export function projectTreeDir(projectId: string): string {
	return path.join(dataDir, 'projects', projectId, 'tree');
}

export function projectDir(projectId: string): string {
	return path.join(dataDir, 'projects', projectId);
}

/** Rendered output of compile jobs, one directory per job. */
export function projectArtifactsDir(projectId: string): string {
	return path.join(dataDir, 'artifacts', projectId);
}

/** Staging area of one upload that is being analysed or awaits confirmation. */
export function importDir(importId: string): string {
	return path.join(dataDir, 'imports', importId);
}

/** Typst packages downloaded from the registry; shared by all projects. */
export const packagesDir = path.join(dataDir, 'packages');
