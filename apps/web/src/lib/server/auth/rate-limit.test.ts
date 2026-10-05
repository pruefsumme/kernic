import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit';

describe('RateLimiter', () => {
	it('allows attempts up to the limit, then reports the wait', () => {
		const limiter = new RateLimiter(3, 60_000);
		expect(limiter.hit('a', 0)).toBe(0);
		expect(limiter.hit('a', 1_000)).toBe(0);
		expect(limiter.hit('a', 2_000)).toBe(0);
		expect(limiter.hit('a', 30_000)).toBe(30);
		expect(limiter.hit('b', 30_000)).toBe(0);
	});

	it('starts a new window after the old one ends, or on reset', () => {
		const limiter = new RateLimiter(1, 1_000);
		expect(limiter.hit('a', 0)).toBe(0);
		expect(limiter.hit('a', 500)).toBeGreaterThan(0);
		expect(limiter.hit('a', 1_000)).toBe(0);

		limiter.hit('a', 1_100);
		limiter.reset('a');
		expect(limiter.hit('a', 1_200)).toBe(0);
	});
});
