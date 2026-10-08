import { error, fail, isHttpError, redirect } from '@sveltejs/kit';
import { recordInitialCheckpoint } from '#lib/server/history/history.ts';
import { requireUser } from '#lib/server/http.ts';
import { cancelImport, confirmImport, getImport } from '#lib/server/imports/imports.ts';
import { ProjectInputError } from '#lib/server/projects/projects.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const user = requireUser(event);
	const pending = await getImport(user.id, event.params.importId);
	if (!pending) error(404, 'Import not found.');
	if (pending.status === 'imported' && pending.projectId) {
		redirect(303, `/projects/${pending.projectId}`);
	}

	return {
		import: {
			id: pending.id,
			sourceName: pending.sourceName,
			status: pending.status,
			report: pending.report,
			error: pending.error
		}
	};
};

export const actions: Actions = {
	confirm: async (event) => {
		const user = requireUser(event);
		const form = await event.request.formData();
		let project;
		try {
			project = await confirmImport({
				userId: user.id,
				importId: event.params.importId,
				name: form.get('name'),
				entryPath: form.get('entryPath')
			});
		} catch (cause) {
			if (cause instanceof ProjectInputError) return fail(400, { message: cause.message });
			if (isHttpError(cause)) return fail(cause.status, { message: cause.body.message });
			throw cause;
		}
		const pending = await getImport(user.id, event.params.importId);
		await recordInitialCheckpoint(
			project.id,
			`Imported from ${pending?.sourceName ?? 'a ZIP archive'}`,
			user
		);
		redirect(303, `/projects/${project.id}`);
	},

	cancel: async (event) => {
		const user = requireUser(event);
		await cancelImport(user.id, event.params.importId);
		redirect(303, '/');
	}
};
