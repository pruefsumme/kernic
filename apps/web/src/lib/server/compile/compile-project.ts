import * as fs from 'node:fs/promises';
import path from 'node:path';
import { scanTypstSource } from '../imports/scan';
import { resolvePackages, type PackageFailure } from '../packages/registry';
import { snapshotTree, type Snapshot } from './snapshot';
import {
	SnapshotChangedError,
	compileSnapshot,
	type Diagnostic,
	type OutputFormat,
	type WorkerResult
} from './worker-client';

/**
 * One compile of a directory of Typst files, as used by the editor's preview,
 * by exports and by the import dry run: take a snapshot, provide the packages
 * the sources import, compile in the worker, and explain package errors.
 */

export interface ProjectCompile {
	snapshot: Snapshot;
	result: WorkerResult;
	/** Packages the sources import that could not be provided, with the reason. */
	packageFailures: PackageFailure[];
}

const MAX_SCANNED_SOURCE_BYTES = 2 * 1024 * 1024;

// Imports of a source file only change when its content does, so remember them by content hash.
const importsByHash = new Map<string, string[]>();

async function importedPackages(root: string, snapshot: Snapshot): Promise<Set<string>> {
	const specs = new Set<string>();
	for (const file of snapshot.files) {
		if (!file.path.toLowerCase().endsWith('.typ') || file.size > MAX_SCANNED_SOURCE_BYTES) continue;

		let found = importsByHash.get(file.sha256);
		if (!found) {
			const source = await fs.readFile(path.join(root, ...file.path.split('/')), 'utf8');
			found = scanTypstSource(source).packages;
			if (importsByHash.size > 5000) importsByHash.clear();
			importsByHash.set(file.sha256, found);
		}
		for (const spec of found) specs.add(spec);
	}
	return specs;
}

const PACKAGE_ERROR = /^(failed to download package|package not found|failed to load package)/;
const SPEC_IN_SOURCE = /"(@[a-z0-9-]+\/[a-z0-9-]+:[0-9.]+)"/;

/**
 * Typst reports a package it cannot load as a failed download, because the
 * sandbox has no network. Replace that with what is actually wrong, naming the
 * package where the source line tells us which one it is.
 */
async function explainPackageErrors(
	root: string,
	diagnostics: Diagnostic[],
	failures: PackageFailure[]
): Promise<Diagnostic[]> {
	const reasons = new Map(failures.map((failure) => [failure.spec, failure.reason]));
	const explained: Diagnostic[] = [];

	for (const diagnostic of diagnostics) {
		if (!PACKAGE_ERROR.test(diagnostic.message)) {
			explained.push(diagnostic);
			continue;
		}

		let spec: string | undefined;
		if (diagnostic.path && diagnostic.line && !diagnostic.path.startsWith('@')) {
			const source = await fs
				.readFile(path.join(root, ...diagnostic.path.split('/')), 'utf8')
				.catch(() => '');
			spec = SPEC_IN_SOURCE.exec(source.split('\n')[diagnostic.line - 1] ?? '')?.[1];
		}

		const reason = spec ? reasons.get(spec) : undefined;
		explained.push({
			...diagnostic,
			message: spec
				? `${spec} is not available: ${reason ?? 'it could not be loaded.'}`
				: 'A package could not be loaded. Documents are compiled without network access; ' +
					'packages have to be named literally, as in #import "@preview/name:1.0.0".'
		});
	}
	return explained;
}

const MAX_ATTEMPTS = 4;

export async function compileProject(
	root: string,
	entry: string,
	format: OutputFormat
): Promise<ProjectCompile> {
	// Files may be saved or restored while a compile is being prepared. Start
	// over from a fresh snapshot then, instead of compiling a mixture.
	for (let attempt = 1; ; attempt++) {
		try {
			return await compileOnce(root, entry, format);
		} catch (error) {
			if (!(error instanceof SnapshotChangedError) || attempt === MAX_ATTEMPTS) throw error;
		}
	}
}

async function compileOnce(
	root: string,
	entry: string,
	format: OutputFormat
): Promise<ProjectCompile> {
	const snapshot = await snapshotTree(root);
	const { packages, failures } = await resolvePackages(await importedPackages(root, snapshot));

	const result = await compileSnapshot({ entry, format, root, files: snapshot.files, packages });
	return {
		snapshot,
		result: {
			...result,
			diagnostics: await explainPackageErrors(root, result.diagnostics, failures)
		},
		packageFailures: failures
	};
}
