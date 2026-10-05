import { fail, redirect } from '@sveltejs/kit';
import { projectTreeDir } from '#lib/server/config.ts';
import { requireProject } from '#lib/server/http.ts';
import { InvalidPathError } from '#lib/server/projects/paths.ts';
import {
	ProjectInputError,
	canWrite,
	deleteProject,
	renameProject,
	setEntryPath
} from '#lib/server/projects/projects.ts';
import { listTree } from '#lib/server/projects/tree.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { project, role } = await requireProject(event, 'read');
	const entries = await listTree(projectTreeDir(project.id));

	return {
		project: { id: project.id, name: project.name, entryPath: project.entryPath },
		canWrite: canWrite(role),
		isOwner: role === 'owner',
		typstFiles: entries
			.filter((entry) => entry.type === 'file' && entry.path.toLowerCase().endsWith('.typ'))
			.map((entry) => entry.path)
	};
};

export const actions: Actions = {
	rename: async (event) => {
		const { project } = await requireProject(event, 'write');
		const form = await event.request.formData();
		try {
			await renameProject(project.id, form.get('name'));
		} catch (error) {
			if (error instanceof ProjectInputError) {
				return fail(400, { action: 'rename', message: error.message });
			}
			throw error;
		}
		return { action: 'rename', saved: true };
	},

	entry: async (event) => {
		const { project } = await requireProject(event, 'write');
		const form = await event.request.formData();
		try {
			await setEntryPath(project.id, form.get('entryPath'));
		} catch (error) {
			if (error instanceof ProjectInputError || error instanceof InvalidPathError) {
				return fail(400, { action: 'entry', message: error.message });
			}
			throw error;
		}
		return { action: 'entry', saved: true };
	},

	delete: async (event) => {
		const { project, role } = await requireProject(event, 'write');
		if (role !== 'owner') {
			return fail(403, { action: 'delete', message: 'Only workspace owners can delete projects.' });
		}
		const form = await event.request.formData();
		// Typing the name guards against deleting the wrong project; there is no undo.
		if (String(form.get('confirm') ?? '').trim() !== project.name) {
			return fail(400, {
				action: 'delete',
				message: 'Type the project name exactly as shown to confirm.'
			});
		}
		await deleteProject(project.id);
		redirect(303, '/');
	}
};
