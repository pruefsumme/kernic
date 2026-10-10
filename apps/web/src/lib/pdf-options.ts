/**
 * Options of a PDF export, shared by the export dialog and the server. The
 * compile worker checks them once more against its own list.
 */
export interface PdfOptions {
	/** A standard the PDF must conform to, as the compiler names it; null for a plain PDF. */
	standard: string | null;
	/** Pages to export, e.g. `1-3,5,8-`; null for all. */
	pages: string | null;
	/** Whether to write accessibility tags. */
	tagged: boolean;
}

export const DEFAULT_PDF_OPTIONS: PdfOptions = { standard: null, pages: null, tagged: true };

export interface PdfStandard {
	id: string;
	name: string;
	purpose: string;
	/** The standard is about accessibility, so tags cannot be left out. */
	needsTags: boolean;
}

/** The standards offered in the export dialog. */
export const PDF_STANDARDS: PdfStandard[] = [
	{ id: 'a-2b', name: 'PDF/A-2b', purpose: 'long-term archiving', needsTags: false },
	{ id: 'a-3b', name: 'PDF/A-3b', purpose: 'archiving, may embed other files', needsTags: false },
	{ id: 'a-1b', name: 'PDF/A-1b', purpose: 'archiving, oldest and strictest', needsTags: false },
	{ id: 'a-4', name: 'PDF/A-4', purpose: 'archiving, based on PDF 2.0', needsTags: false },
	{ id: 'a-2a', name: 'PDF/A-2a', purpose: 'archiving, accessible', needsTags: true },
	{ id: 'ua-1', name: 'PDF/UA-1', purpose: 'accessible to screen readers', needsTags: true }
];

export const standardById = (id: string | null) =>
	PDF_STANDARDS.find((standard) => standard.id === id) ?? null;

export class PdfOptionsError extends Error {}

const MAX_PAGE_RANGES = 64;
const PAGE_RANGE = /^([1-9]\d{0,5})(?:-([1-9]\d{0,5})?)?$/;

/**
 * Checks a page selection as people type it ("1-3, 5, 8-") and returns it in
 * the compiler's form, or null for "all pages".
 */
export function normalizePages(input: string): string | null {
	const compact = input.replace(/\s+/g, '').replace(/[–—]/g, '-');
	if (compact === '') return null;

	const ranges = compact.split(',');
	if (ranges.length > MAX_PAGE_RANGES) {
		throw new PdfOptionsError('That is too many page ranges for one export.');
	}
	for (const range of ranges) {
		const parts = PAGE_RANGE.exec(range);
		if (!parts) {
			throw new PdfOptionsError(
				`“${range}” is not a page or a range. Write pages like 1-3, 5, 8- (page numbers start at 1).`
			);
		}
		if (parts[2] !== undefined && Number(parts[2]) < Number(parts[1])) {
			throw new PdfOptionsError(`The range ${range} ends before it starts.`);
		}
	}
	return compact;
}

/** Checks options from a request body. Throws `PdfOptionsError` with a message for the user. */
export function parsePdfOptions(value: unknown): PdfOptions {
	if (typeof value !== 'object' || value === null) {
		throw new PdfOptionsError('The export options are not valid.');
	}
	const raw = value as Record<string, unknown>;

	const standard = raw.standard ?? null;
	if (standard !== null && !(typeof standard === 'string' && standardById(standard))) {
		throw new PdfOptionsError('Choose one of the listed PDF standards.');
	}
	if (raw.pages !== undefined && raw.pages !== null && typeof raw.pages !== 'string') {
		throw new PdfOptionsError('The page selection is not valid.');
	}
	const pages = typeof raw.pages === 'string' ? normalizePages(raw.pages) : null;
	if (raw.tagged !== undefined && typeof raw.tagged !== 'boolean') {
		throw new PdfOptionsError('The export options are not valid.');
	}
	const tagged = raw.tagged ?? true;

	const chosen = standardById(standard as string | null);
	if (chosen?.needsTags && (pages !== null || !tagged)) {
		throw new PdfOptionsError(
			`${chosen.name} needs accessibility tags, which a selection of pages cannot have. Export all pages with tags.`
		);
	}
	return { standard: standard as string | null, pages, tagged };
}

export function isDefaultPdfOptions(options: PdfOptions): boolean {
	return options.standard === null && options.pages === null && options.tagged;
}
