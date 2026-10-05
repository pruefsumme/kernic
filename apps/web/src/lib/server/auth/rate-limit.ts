/**
 * Fixed-window attempt counter held in memory. That is sufficient while the app
 * runs as a single process; it has to move to shared storage before the app is
 * scaled to several replicas.
 */
export class RateLimiter {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #attempts = new Map<string, { count: number; resetAt: number }>();

	constructor(limit: number, windowMs: number) {
		this.#limit = limit;
		this.#windowMs = windowMs;
	}

	/** Records an attempt. Returns the seconds to wait when the limit is exceeded, otherwise 0. */
	hit(key: string, now = Date.now()): number {
		if (this.#attempts.size > 10_000) this.#prune(now);

		const entry = this.#attempts.get(key);
		if (!entry || entry.resetAt <= now) {
			this.#attempts.set(key, { count: 1, resetAt: now + this.#windowMs });
			return 0;
		}

		entry.count++;
		return entry.count > this.#limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
	}

	reset(key: string): void {
		this.#attempts.delete(key);
	}

	#prune(now: number): void {
		for (const [key, entry] of this.#attempts) {
			if (entry.resetAt <= now) this.#attempts.delete(key);
		}
	}
}
