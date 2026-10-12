import { fail, redirect } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { projectTreeDir } from '#lib/server/config.ts';
import { RemoteError } from '#lib/server/history/git.ts';
import { RemoteUrlError } from '#lib/server/history/remote-url.ts';
import {
	connectProjectRemote,
	disconnectProjectRemote,
	getProjectRemote,
	remoteHosts,
	RemoteUnavailableError
} from '#lib/server/history/remotes.ts';
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
import {
	createProjectShare,
	listProjectShares,
	revokeProjectShare,
	SHARE_LIFETIMES_DAYS,
	ShareError
} from '#lib/server/shares.ts';
import { listWorkspaceOverviews, moveProject, WorkspaceError } from '#lib/server/workspaces.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const { project, role, user } = await requireProject(event, 'read');
	const entries = await listTree(projectTreeDir(project.id));
	const workspaces = await listWorkspaceOverviews(user.id);
	const name = (workspace: { kind: string; name: string }) =>
		workspace.kind === 'personal' ? 'Personal (only you)' : workspace.name;

	return {
		project: { id: project.id, name: project.name, entryPath: project.entryPath },
		workspace: {
			id: project.workspaceId,
			name: name(workspaces.find((workspace) => workspace.id === project.workspaceId)!)
		},
		// Links for reading are an owner's to make and to see.
		shares: role === 'owner' ? await listProjectShares(project.id) : [],
		shareLifetimes: [...SHARE_LIFETIMES_DAYS],
		// The repository checkpoints are pushed to, for everyone to see; its token is nobody's to see.
		remote: await getProjectRemote(project.id),
		remoteHosts,
		// Where the project could go: workspaces in which this person may create projects.
		moveTargets: workspaces
			.filter((workspace) => workspace.id !== project.workspaceId && canWrite(workspace.role))
			.map((workspace) => ({ id: workspace.id, name: name(workspace) })),
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

	/** Creates a link for reading. It is returned once and not stored in readable form. */
	share: async (event) => {
		const { project, role, user } = await requireProject(event, 'write');
		if (role !== 'owner') {
			return fail(403, {
				action: 'share',
				message: 'Only workspace owners can share a project outside the workspace.'
			});
		}
		const chosen = String((await event.request.formData()).get('lifetime') ?? '');
		const days = chosen === 'none' ? null : Number(chosen);
		if (days !== null && !SHARE_LIFETIMES_DAYS.some((offered) => offered === days)) {
			return fail(400, { action: 'share', message: 'Choose how long the link should work.' });
		}
		try {
			const { token, expiresAt } = await createProjectShare({
				projectId: project.id,
				createdBy: user.id,
				days
			});
			await recordAudit(event, 'project.share-created', { subject: project.name });
			return { action: 'share', link: { url: `${event.url.origin}/shared/${token}`, expiresAt } };
		} catch (error) {
			if (error instanceof ShareError)
				return fail(400, { action: 'share', message: error.message });
			throw error;
		}
	},

	unshare: async (event) => {
		const { project, role } = await requireProject(event, 'write');
		if (role !== 'owner') {
			return fail(403, {
				action: 'unshare',
				message: 'Only workspace owners can withdraw a link.'
			});
		}
		const shareId = String((await event.request.formData()).get('shareId') ?? '');
		await revokeProjectShare(project.id, shareId);
		await recordAudit(event, 'project.share-revoked', { subject: project.name });
		return { action: 'unshare' };
	},

	/** Connects the project to a Git repository, after trying the address and the token. */
	connect: async (event) => {
		const { project, role, user } = await requireProject(event, 'write');
		if (role !== 'owner') {
			return fail(403, {
				action: 'connect',
				message: 'Only workspace owners can connect a project to a repository.'
			});
		}
		const form = await event.request.formData();
		const entered = {
			url: String(form.get('url') ?? ''),
			branch: String(form.get('branch') ?? ''),
			username: String(form.get('username') ?? '')
		};
		try {
			await connectProjectRemote({
				projectId: project.id,
				userId: user.id,
				...entered,
				token: form.get('token')
			});
		} catch (error) {
			if (
				error instanceof RemoteUrlError ||
				error instanceof RemoteError ||
				error instanceof RemoteUnavailableError
			) {
				// What was typed comes back, except the token.
				return fail(400, { action: 'connect', message: error.message, entered });
			}
			throw error;
		}
		await recordAudit(event, 'project.remote-connected', { subject: project.name });
		return { action: 'connect', saved: true };
	},

	disconnect: async (event) => {
		const { project, role } = await requireProject(event, 'write');
		if (role !== 'owner') {
			return fail(403, {
				action: 'disconnect',
				message: 'Only workspace owners can disconnect a project from its repository.'
			});
		}
		if (await disconnectProjectRemote(project.id)) {
			await recordAudit(event, 'project.remote-disconnected', { subject: project.name });
		}
		return { action: 'disconnect', saved: true };
	},

	move: async (event) => {
		const { project, user } = await requireProject(event, 'write');
		const targetWorkspaceId = String((await event.request.formData()).get('workspace') ?? '');
		try {
			await moveProject({ projectId: project.id, userId: user.id, targetWorkspaceId });
		} catch (error) {
			// Covers both "may not" and "no room there".
			if (error instanceof WorkspaceError || error instanceof ProjectInputError) {
				return fail(400, { action: 'move', message: error.message });
			}
			throw error;
		}
		await recordAudit(event, 'project.moved', { subject: project.name });
		return { action: 'move', saved: true };
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
		await recordAudit(event, 'project.deleted', { subject: project.name });
		redirect(303, '/');
	}
};
