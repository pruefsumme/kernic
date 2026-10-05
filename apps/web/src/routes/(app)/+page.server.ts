import { fail, redirect } from '@sveltejs/kit';
import { requestCompile } from '#lib/server/compile/jobs.ts';
import { sql } from '#lib/server/db/client.ts';
import { requireUser } from '#lib/server/http.ts';
import {
	ProjectInputError,
	canWrite,
	createProjectFromTemplate,
	getWorkspaceRole,
	listProjectsForUser,
	listWorkspacesForUser
} from '#lib/server/projects/projects.ts';
import { templateCategories, templates } from '#lib/server/projects/templates.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const [projects, workspaces] = await Promise.all([
		listProjectsForUser(user.id),
		listWorkspacesForUser(user.id)
	]);

	// The newest rendered first page of each project doubles as its thumbnail.
	const renders = await sql<{ project_id: string; id: string }[]>`
		SELECT DISTINCT ON (project_id) project_id, id
		FROM compile_jobs
		WHERE project_id = ANY(${projects.map((project) => project.id)}::uuid[])
			AND format = 'svg' AND status = 'succeeded'
		ORDER BY project_id, finished_at DESC
	`;
	const thumbnailJob = new Map(renders.map((row) => [row.project_id, row.id]));

	return {
		projects: projects.map((project) => ({
			id: project.id,
			name: project.name,
			updatedAt: project.updatedAt,
			workspaceId: project.workspaceId,
			workspaceName: project.workspaceName,
			role: project.role,
			thumbnailJobId: thumbnailJob.get(project.id) ?? null
		})),
		workspaces: workspaces.filter((workspace) => canWrite(workspace.role)),
		templateCategories: [...templateCategories],
		templates: templates.map(({ id, name, category, description, files }) => ({
			id,
			name,
			category,
			description,
			files: files.map((file) => file.path)
		}))
	};
};

export const actions: Actions = {
	create: async (event) => {
		const user = requireUser(event);
		const form = await event.request.formData();
		const name = String(form.get('name') ?? '');
		const templateId = String(form.get('template') ?? '');
		const workspaceId = String(form.get('workspace') ?? '');

		const role = await getWorkspaceRole(user.id, workspaceId);
		if (!role || !canWrite(role)) {
			return fail(403, {
				name,
				templateId,
				message: 'You cannot create projects in that workspace.'
			});
		}

		let project;
		try {
			project = await createProjectFromTemplate({ workspaceId, userId: user.id, name, templateId });
		} catch (error) {
			if (error instanceof ProjectInputError) {
				return fail(400, { name, templateId, message: error.message });
			}
			throw error;
		}

		// Render right away, so the editor and the project's thumbnail have pages to show.
		await requestCompile({ projectId: project.id, userId: user.id, format: 'svg' });
		redirect(303, `/projects/${project.id}`);
	}
};
