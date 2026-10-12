import { error, fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { recordAudit } from '#lib/server/audit.ts';
import { requireUser } from '#lib/server/http.ts';
import { isUuid, workspaceUsage } from '#lib/server/projects/projects.ts';
import {
	createWorkspaceInvite,
	deleteWorkspace,
	getWorkspace,
	isRole,
	listMembers,
	listPendingInvites,
	removeMember,
	renameWorkspace,
	revokeWorkspaceInvite,
	setMemberRole,
	WorkspaceError
} from '#lib/server/workspaces.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The workspace of the route, if the signed-in person is a member. Someone who
 * is not gets "not found", the same as for a workspace that does not exist.
 */
async function requireWorkspace(event: RequestEvent, need: 'member' | 'owner') {
	const user = requireUser(event);
	const workspace = await getWorkspace(user.id, event.params.workspaceId ?? '');
	if (!workspace) error(404, 'Workspace not found.');
	if (need === 'owner' && workspace.role !== 'owner') {
		error(403, 'Only an owner of this workspace can do that.');
	}
	return { user, workspace };
}

/** Members and links only exist for shared workspaces. */
function requireShared(workspace: { kind: string }) {
	if (workspace.kind !== 'team') error(400, 'Your own workspace cannot be shared or changed.');
}

export const load: PageServerLoad = async (event) => {
	const { user, workspace } = await requireWorkspace(event, 'member');
	const owner = workspace.role === 'owner' && workspace.kind === 'team';
	return {
		workspace,
		ownId: user.id,
		usage: await workspaceUsage(workspace.id),
		members: workspace.kind === 'team' ? await listMembers(workspace.id) : [],
		invites: owner ? await listPendingInvites(workspace.id) : []
	};
};

const asFailure = (action: string) => (cause: unknown) => {
	if (cause instanceof WorkspaceError) return fail(400, { action, message: cause.message });
	throw cause;
};

export const actions: Actions = {
	rename: async (event) => {
		const { workspace } = await requireWorkspace(event, 'owner');
		requireShared(workspace);
		const name = (await event.request.formData()).get('name');
		return renameWorkspace(workspace.id, name).then(
			() => ({ action: 'rename', saved: true }),
			asFailure('rename')
		);
	},

	/** Creates a link to join with. It is returned once and not stored in readable form. */
	invite: async (event) => {
		const { user, workspace } = await requireWorkspace(event, 'owner');
		requireShared(workspace);
		const role = (await event.request.formData()).get('role');
		if (role !== 'editor' && role !== 'viewer') {
			return fail(400, { action: 'invite', message: 'Choose what the person may do.' });
		}
		const { token, expiresAt } = await createWorkspaceInvite(workspace.id, role, user.id);
		await recordAudit(event, 'workspace.invite-created', { subject: workspace.name });
		return {
			action: 'invite',
			link: { url: `${event.url.origin}/join/${token}`, role, expiresAt }
		};
	},

	revoke: async (event) => {
		const { workspace } = await requireWorkspace(event, 'owner');
		requireShared(workspace);
		const inviteId = String((await event.request.formData()).get('inviteId') ?? '');
		await revokeWorkspaceInvite(workspace.id, inviteId);
		return { action: 'revoke' };
	},

	role: async (event) => {
		const { workspace } = await requireWorkspace(event, 'owner');
		requireShared(workspace);
		const form = await event.request.formData();
		const userId = String(form.get('userId') ?? '');
		const role = form.get('role');
		if (!isUuid(userId) || !isRole(role))
			return fail(400, { action: 'role', message: 'Not valid.' });
		try {
			await setMemberRole(workspace.id, userId, role);
		} catch (cause) {
			return asFailure('role')(cause);
		}
		await recordAudit(event, 'workspace.role-changed', { subject: workspace.name });
		return { action: 'role' };
	},

	/** An owner removes someone, or a member leaves. */
	remove: async (event) => {
		const { user, workspace } = await requireWorkspace(event, 'member');
		requireShared(workspace);
		const userId = String((await event.request.formData()).get('userId') ?? '');
		if (!isUuid(userId)) return fail(400, { action: 'remove', message: 'Not valid.' });
		if (userId !== user.id && workspace.role !== 'owner') {
			error(403, 'Only an owner of this workspace can remove others.');
		}
		try {
			await removeMember(workspace.id, userId);
		} catch (cause) {
			return asFailure('remove')(cause);
		}
		await recordAudit(event, 'workspace.member-removed', { subject: workspace.name });
		if (userId === user.id) redirect(303, '/workspaces');
		return { action: 'remove' };
	},

	delete: async (event) => {
		const { workspace } = await requireWorkspace(event, 'owner');
		requireShared(workspace);
		try {
			await deleteWorkspace(workspace.id);
		} catch (cause) {
			return asFailure('delete')(cause);
		}
		await recordAudit(event, 'workspace.deleted', { subject: workspace.name });
		redirect(303, '/workspaces');
	}
};
