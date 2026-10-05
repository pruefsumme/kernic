const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const absolute = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });
const precise = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });

/** Relative near now ("12 minutes ago"), absolute further back ("14 Oct 2026"). */
export function formatWhen(date: Date, now = new Date()): string {
	const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
	const elapsed = Math.abs(seconds);

	if (elapsed < 45) return 'just now';
	if (elapsed < 3600) return relative.format(Math.round(seconds / 60), 'minute');
	if (elapsed < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
	if (elapsed < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
	return absolute.format(date);
}

export function formatExact(date: Date): string {
	return precise.format(date);
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
