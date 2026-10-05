import {
	KERNIC_DATA_DIR,
	KERNIC_MAX_FILE_MB,
	KERNIC_MAX_PROJECT_FILES,
	KERNIC_MAX_PROJECT_MB
} from '$app/env/private';
import path from 'node:path';
import type { TreeLimits } from './projects/tree';

export const dataDir = path.resolve(KERNIC_DATA_DIR);

export const treeLimits: TreeLimits = {
	maxFileBytes: KERNIC_MAX_FILE_MB,
	maxProjectBytes: KERNIC_MAX_PROJECT_MB,
	maxProjectFiles: KERNIC_MAX_PROJECT_FILES
};

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
