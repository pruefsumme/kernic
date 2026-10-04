export type Severity = 'error' | 'warning';

export interface Diagnostic {
	severity: Severity;
	message: string;
	/** Project-relative path, or null when Typst reported no source location. */
	path: string | null;
	/** 1-based line and column, as printed by Typst. */
	line: number | null;
	column: number | null;
}

const LOCATED = /^(.+?):(\d+):(\d+): (error|warning): (.*)$/;
const UNLOCATED = /^(error|warning): (.*)$/;

/**
 * Parses `typst compile --diagnostic-format short` output, one diagnostic per line:
 * `path:line:column: severity: message`.
 */
export function parseDiagnostics(stderr: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const rawLine of stderr.split('\n')) {
		const line = rawLine.trimEnd();
		if (line === '') continue;

		const located = LOCATED.exec(line);
		if (located) {
			diagnostics.push({
				severity: located[4] as Severity,
				message: located[5]!,
				path: located[1]!,
				line: Number(located[2]),
				column: Number(located[3])
			});
			continue;
		}

		const unlocated = UNLOCATED.exec(line);
		if (unlocated) {
			diagnostics.push({
				severity: unlocated[1] as Severity,
				message: unlocated[2]!,
				path: null,
				line: null,
				column: null
			});
		}
	}

	return diagnostics;
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}
