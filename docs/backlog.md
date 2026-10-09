# Backlog

Ordered by priority. Each item is one or more coherent slices that end in verified, committed
work. Move finished items to "Done" with the commit that completed them.

The yardstick for "ready": the owner intends to write a bachelor's thesis in Kernic, so a document
that works on typst.app should work here, and work in it must never be lost.

## Next

1. **Automatic snapshots** between explicit checkpoints, kept apart from the checkpoint history,
   so a bad edit can be undone even without a checkpoint.

2. **UI polish** — the layout and flow are settled; make it more pleasant to look at and smoother:
   - Visual refinement: spacing rhythm, typography details, icon consistency, hover/active/focus
     states, the empty and loading states, dialog and menu styling.
   - Motion with intent and restraint: panel open/close, menu and dialog entrance, preview page
     updates (cross-fade instead of a hard swap), save and compile state changes, list
     reordering. All of it respecting `prefers-reduced-motion`.
   - Perceived speed: skeletons that match the layout, no layout shift when pages load,
     optimistic file-tree updates.
   - A review of every screen at desktop, tablet and phone widths after the changes.

3. **Account page and user management** — change name and password, list and revoke sessions;
   administrators create and disable accounts.

4. **Git remotes (Gitea/Forgejo)** — connect a project to a repository on a forge: push
   checkpoints, pull and merge changes made elsewhere, import a project by cloning (allow-listed
   hosts, scoped tokens stored as secrets, no hooks, limits on size and time).

5. **Remaining items of the security review** — see "Open" in [security.md](security.md):
   per-job isolation inside the worker container, fairness in the compile queue, an audit log,
   and the checks not yet exercised (real domain, ARM64, upgrade between versions).

6. **Team access** — organizations/team workspaces in the UI, invitations, roles, share links,
   admin user management, audit events.

7. **Language server (Tinymist)** — completion, hover, go-to-definition, formatting and
   diagnostics while typing, behind the existing editor adapter.

8. **Real-time collaboration** — Yjs + Hocuspocus behind `/collab`, authorization before loading
   a document, presence and cursors, revocation when permissions change.

9. **Operations** — optional Redis/BullMQ job queue, optional S3-compatible storage, health and
   readiness details, structured logs with request ids, quotas per workspace.

## Smaller items

- Packages: an admin view of installed packages; private (`@local`) packages uploaded by an admin.
- History: restore a single file; compare any two checkpoints.
- Re-run the import dry-run compile when a different main file is chosen.
- Project-wide search and replace.
- Project folders and "move to workspace" on the dashboard.
- Share dialog (depends on team access).
- Dark theme, as an explicit choice.
- Preview: click a position on a page to jump to the source, and the reverse.

## Done

- Sandboxed compile worker, accounts and first-run setup, projects from templates, multi-file
  editor with autosave and conflict detection, live preview with diagnostics, PDF and ZIP export.
- App shell with connected rail and top bar, dashboard, template picker, Kernic branding.
- End-to-end test suite against the production build; content security policy; keyboard access.
- ZIP import with a dry-run check (`8a3fe41`).
- Docker Compose deployment (proxy, app, isolated worker, PostgreSQL) with self-hosting guide,
  backup and restore scripts and a tested restore.
- Typst Universe packages, fetched by the app and passed to the worker; transitive dependencies;
  specific error messages for missing and private packages.
- Version history: checkpoints as Git commits per project, diff, restore, ZIP of a version;
  one lock per project for file changes and history operations.
- Security, safety and reliability review with fixes and tests; report in `docs/security.md`.
- Preview performance for long documents: pages stored by content hash, sized up front, loaded
  only near the screen.
