/**
 * Static checks on Typst sources before a project is imported: which packages
 * they need and which files they refer to. This is a text scan, not a parser —
 * it finds the common, literal cases; the dry-run compile is the final word.
 */

export interface SourceScan {
	/** Package specs such as `@preview/cetz:0.3.1`. */
	packages: string[];
	/** Paths given as string literals to imports, includes and file functions. */
	references: string[];
}

export interface PackageUse {
	spec: string;
	usedIn: string[];
}

export interface MissingReference {
	/** The path as written in the source. */
	target: string;
	referencedFrom: string;
}

/** Replaces comments with spaces, leaving strings (which may contain `//`) intact. */
export function stripComments(source: string): string {
	let result = '';
	let index = 0;

	while (index < source.length) {
		const two = source.slice(index, index + 2);

		if (source[index] === '"') {
			const start = index++;
			while (index < source.length && source[index] !== '"') {
				index += source[index] === '\\' ? 2 : 1;
			}
			result += source.slice(start, ++index);
		} else if (two === '//') {
			while (index < source.length && source[index] !== '\n') index++;
		} else if (two === '/*') {
			let depth = 0;
			do {
				const pair = source.slice(index, index + 2);
				if (pair === '/*') {
					depth++;
					index += 2;
				} else if (pair === '*/') {
					depth--;
					index += 2;
				} else {
					if (source[index] === '\n') result += '\n';
					index++;
				}
			} while (depth > 0 && index < source.length);
		} else {
			result += source[index++];
		}
	}
	return result;
}

const IMPORT = /\b(?:import|include)\s+"([^"\n]+)"/g;
const FILE_FUNCTION =
	/\b(?:image|bibliography|read|csv|json|yaml|toml|xml|cbor|plugin)\s*\(\s*\(?\s*"([^"\n]+)"/g;

export function scanTypstSource(source: string): SourceScan {
	const text = stripComments(source);
	const packages = new Set<string>();
	const references = new Set<string>();

	for (const [, target] of text.matchAll(IMPORT)) {
		if (target!.startsWith('@')) packages.add(target!);
		else references.add(target!);
	}
	for (const [, target] of text.matchAll(FILE_FUNCTION)) references.add(target!);

	return { packages: [...packages], references: [...references] };
}

/**
 * Resolves a path written in a source file to a project path, the way Typst
 * does: a leading slash means the project root, anything else is relative to
 * the file. Returns null when the path leaves the project.
 */
export function resolveReference(fromFile: string, target: string): string | null {
	const base = target.startsWith('/') ? [] : fromFile.split('/').slice(0, -1);
	const segments = [...base];
	for (const segment of target.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (segments.length === 0) return null;
			segments.pop();
		} else {
			segments.push(segment);
		}
	}
	return segments.join('/');
}

export function analyzeSources(
	/** Project path → source text, for every Typst file. */
	sources: Map<string, string>,
	/** Every file path in the project. */
	allPaths: Set<string>
): { packages: PackageUse[]; missing: MissingReference[]; referenced: Set<string> } {
	const packages = new Map<string, string[]>();
	const missing: MissingReference[] = [];
	const referenced = new Set<string>();

	for (const [file, source] of sources) {
		const scan = scanTypstSource(source);
		for (const spec of scan.packages) {
			packages.set(spec, [...(packages.get(spec) ?? []), file]);
		}
		for (const target of scan.references) {
			const resolved = resolveReference(file, target);
			if (resolved !== null && allPaths.has(resolved)) referenced.add(resolved);
			else missing.push({ target, referencedFrom: file });
		}
	}

	return {
		packages: [...packages].map(([spec, usedIn]) => ({ spec, usedIn })),
		missing,
		referenced
	};
}

/**
 * Picks the file most likely to be the document's entry point: `main.typ` at
 * the top level, otherwise a top-level file that no other file includes.
 */
export function guessEntryFile(typstFiles: string[], referenced: Set<string>): string | null {
	if (typstFiles.length === 0) return null;
	const depth = (file: string) => file.split('/').length;
	const byDepth = typstFiles.toSorted((a, b) => depth(a) - depth(b) || a.localeCompare(b));

	const mainFile = byDepth.find((file) => file.split('/').at(-1)!.toLowerCase() === 'main.typ');
	if (mainFile && depth(mainFile) === 1) return mainFile;

	const topLevel = byDepth.filter((file) => depth(file) === 1);
	const roots = topLevel.filter((file) => !referenced.has(file));
	return roots[0] ?? mainFile ?? topLevel[0] ?? byDepth[0]!;
}
