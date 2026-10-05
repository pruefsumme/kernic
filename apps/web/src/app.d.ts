import type { SessionUser } from '#lib/server/auth/sessions.ts';

declare global {
	namespace App {
		interface Error {
			/** Machine-readable reason, for errors the client reacts to (e.g. `conflict`). */
			code?: string;
		}
		interface Locals {
			user: SessionUser | null;
		}
	}
}

export {};
