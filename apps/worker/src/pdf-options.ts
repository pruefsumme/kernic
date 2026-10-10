/**
 * Options for a PDF export. They become command-line arguments of the
 * compiler, so every value is checked against what is listed here; nothing a
 * caller sends is passed on as it came.
 */
export interface PdfOptions {
	/** A standard the PDF must conform to, as the compiler names it, e.g. `a-2b`. */
	standard: string | null;
	/** Pages to export, e.g. `1-3,5,8-`; null for all. */
	pages: string | null;
	/** Whether to write accessibility tags. Not possible together with `pages`. */
	tagged: boolean;
}

export const PDF_STANDARDS = [
	'1.4',
	'1.5',
	'1.6',
	'1.7',
	'2.0',
	'a-1b',
	'a-1a',
	'a-2b',
	'a-2u',
	'a-2a',
	'a-3b',
	'a-3u',
	'a-3a',
	'a-4',
	'a-4f',
	'a-4e',
	'ua-1'
];

const MAX_PAGE_RANGES = 64;
const PAGE_RANGE = /^([1-9]\d{0,5})(?:(-)([1-9]\d{0,5})?)?$/;

/** Checks a page selection such as `1-3,5,8-`. */
export function isPageSelection(value: string): boolean {
	const ranges = value.split(',');
	if (ranges.length > MAX_PAGE_RANGES) return false;
	return ranges.every((range) => {
		const parts = PAGE_RANGE.exec(range);
		if (!parts) return false;
		return parts[3] === undefined || Number(parts[3]) >= Number(parts[1]);
	});
}

/** Returns the checked options, or a message saying what is wrong with them. */
export function parsePdfOptions(value: unknown): PdfOptions | string {
	if (typeof value !== 'object' || value === null) return 'pdf must be an object';
	const { standard = null, pages = null, tagged = true } = value as Record<string, unknown>;

	if (standard !== null && !(typeof standard === 'string' && PDF_STANDARDS.includes(standard))) {
		return `pdf.standard must be one of ${PDF_STANDARDS.join(', ')}`;
	}
	if (pages !== null && !(typeof pages === 'string' && isPageSelection(pages))) {
		return 'pdf.pages must list pages and ranges such as "1-3,5,8-"';
	}
	if (typeof tagged !== 'boolean') return 'pdf.tagged must be true or false';
	return { standard, pages, tagged };
}

/** The compiler arguments for the options. */
export function pdfArguments(options: PdfOptions): string[] {
	const args: string[] = [];
	if (options.standard !== null) args.push('--pdf-standard', options.standard);
	if (options.pages !== null) args.push('--pages', options.pages);
	// The compiler leaves tags out of a partial export anyway, and warns unless told so.
	if (!options.tagged || options.pages !== null) args.push('--no-pdf-tags');
	return args;
}
