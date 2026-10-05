/**
 * Content types for serving project files back to the browser. Project files
 * are untrusted, so only formats that browsers render inertly get their real
 * type; everything else is served as plain text or as a download.
 */

const INERT_TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	// SVG can carry scripts; it is only safe together with the sandboxing CSP below.
	svg: 'image/svg+xml',
	pdf: 'application/pdf'
};

const TEXT_EXTENSIONS = new Set([
	'typ',
	'bib',
	'txt',
	'md',
	'csv',
	'tsv',
	'json',
	'yaml',
	'yml',
	'toml',
	'xml',
	'tex',
	'cls',
	'sty',
	'csl',
	'html',
	'css',
	'js',
	'ts',
	'py',
	'rs',
	'c',
	'h',
	'cpp',
	'java',
	'go',
	'sh',
	'lua',
	'gitignore',
	'gitattributes',
	'editorconfig',
	'license'
]);

export function extensionOf(filePath: string): string {
	const name = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
	const dot = name.lastIndexOf('.');
	return dot === -1 ? name : name.slice(dot + 1);
}

export function isTextPath(filePath: string): boolean {
	return TEXT_EXTENSIONS.has(extensionOf(filePath));
}

/** A file is treated as text if it is valid UTF-8 without NUL bytes. */
export function looksLikeText(content: Uint8Array): boolean {
	if (content.includes(0)) return false;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(content);
		return true;
	} catch {
		return false;
	}
}

export function responseHeadersFor(filePath: string, content: Uint8Array): Record<string, string> {
	const inert = INERT_TYPES[extensionOf(filePath)];
	const isText = !inert && looksLikeText(content);
	const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);

	return {
		'content-type': inert ?? (isText ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
		'content-disposition': `${inert || isText ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
		// Even when opened directly in a tab, a project file may not run scripts,
		// load anything, or act with the app's origin.
		'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
		'x-kernic-text': isText ? '1' : '0'
	};
}
