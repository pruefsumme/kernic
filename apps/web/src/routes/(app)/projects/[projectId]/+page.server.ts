import { latestSuccessfulJob } from '#lib/server/compile/jobs.ts';
import { projectTreeDir } from '#lib/server/config.ts';
import { requireProject } from '#lib/server/http.ts';
import { canWrite } from '#lib/server/projects/projects.ts';
import { listTree } from '#lib/server/projects/tree.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { project, role } = await requireProject(event, 'read');
	const [entries, lastRender] = await Promise.all([
		listTree(projectTreeDir(project.id)),
		latestSuccessfulJob(project.id, 'svg')
	]);

	return {
		project: {
			id: project.id,
			name: project.name,
			entryPath: project.entryPath,
			revision: project.revision
		},
		canWrite: canWrite(role),
		entries,
		// Shown immediately while the first compile of this visit runs.
		lastRender: lastRender && {
			jobId: lastRender.id,
			pageCount: lastRender.pageCount ?? 0,
			revision: lastRender.revision
		}
	};
};
