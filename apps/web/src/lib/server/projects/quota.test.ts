import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/env/private', () => ({
	DATABASE_URL: 'postgres://unused',
	KERNIC_DATA_DIR: '/tmp/kernic-unused',
	KERNIC_MAX_FILE_MB: 1,
	KERNIC_MAX_PROJECT_MB: 1,
	KERNIC_MAX_PROJECT_FILES: 1,
	KERNIC_MAX_WORKSPACE_MB: 1,
	KERNIC_MAX_WORKSPACE_PROJECTS: 1,
	KERNIC_MAX_WAITING_COMPILES: 1
}));

const { roomProblem } = await import('./projects');

const MiB = 1024 * 1024;
const usage = { bytes: 90 * MiB, projects: 3, maxBytes: 100 * MiB, maxProjects: 4 };

describe('room in a workspace', () => {
	it('allows what fits, up to the limit exactly', () => {
		expect(roomProblem(usage, { bytes: 10 * MiB })).toBeNull();
		expect(roomProblem(usage, { projects: 1 })).toBeNull();
		expect(roomProblem(usage, { projects: 1, bytes: 5 * MiB })).toBeNull();
	});

	it('refuses growth past the storage limit, and says how much is used', () => {
		const problem = roomProblem(usage, { bytes: 10 * MiB + 1 });
		expect(problem).toContain('90 MB of 100 MB');
		expect(problem).toContain('Delete files or projects');
	});

	it('refuses one project more than allowed', () => {
		expect(roomProblem({ ...usage, projects: 4 }, { projects: 1 })).toContain('4 projects');
	});

	it('never stands in the way of making things smaller', () => {
		const full = { ...usage, bytes: 150 * MiB, projects: 9 };
		expect(roomProblem(full, { bytes: -5 })).toBeNull();
		expect(roomProblem(full, { bytes: 0 })).toBeNull();
		expect(roomProblem(full, {})).toBeNull();
	});

	it('names large limits in gigabytes', () => {
		const large = { bytes: 2040 * MiB, projects: 1, maxBytes: 2048 * MiB, maxProjects: 9 };
		expect(roomProblem(large, { bytes: 100 * MiB })).toContain('2 GB of 2 GB');
	});
});
