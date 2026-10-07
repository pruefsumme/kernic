# Backlog

Ordered by priority. Each item is one or more coherent slices that end in verified, committed
work. Move finished items to "Done" with the commit that completed them.

The yardstick for "ready": the owner intends to write a bachelor's thesis in Kernic, so a document
that works on typst.app should work here, and work in it must never be lost.

## Next

1. **Typst packages (Typst Universe)** — the largest functional gap compared with typst.app: most
   thesis templates are packages. Fetch `@preview` packages outside the compile sandbox from the
   fixed registry host, verify and cache them, and hand them to the worker read-only. Admin switch
   to disable or pin the registry. The import report should then say "will be installed" instead
   of "not available".

2. **Version history and Git checkpoints** — explicit checkpoints of a project as Git commits
   (local repository per project first), a history view with diff and restore, then push/pull to
   Gitea/Forgejo. This is also the safety net against accidental deletion and bad edits.

3. **Security, safety and reliability audit** — a deliberate review, not a by-the-way one:
   - Threat model written down: untrusted documents, archives, uploads, other users, the network.
   - Authentication and sessions: cookie flags, session lifetime, rate limits, password policy,
     account lockout behaviour, setup token handling.
   - Authorization: every route, download, job, artifact and import checked for another user's
     access (needs a second user; add tests).
   - Worker isolation in the container deployment: no egress, read-only root, dropped
     capabilities, resource limits; try to break out with hostile documents.
   - Input handling: path validation, archive bombs, oversized bodies, content types, CSP.
   - Data safety: atomic writes and fsync, behaviour on full disk, on crash mid-save, on database
     loss; concurrent editing in two tabs; backup and restore drill; upgrade and failed-migration
     behaviour.
   - Parity check against typst.app for thesis work: fonts, bibliography, figures, large
     documents (100+ pages) and compile time, PDF export options, packages.
   - Dependency review and a `SECURITY.md` describing what is and is not protected.
   Outcome: a written report in `docs/`, issues fixed or listed with severity, tests for each fix.

4. **UI polish** — the layout and flow are settled; make it more pleasant to look at and smoother:
   - Visual refinement: spacing rhythm, typography details, icon consistency, hover/active/focus
     states, the empty and loading states, dialog and menu styling.
   - Motion with intent and restraint: panel open/close, menu and dialog entrance, preview page
     updates (cross-fade instead of a hard swap), save and compile state changes, list
     reordering. All of it respecting `prefers-reduced-motion`.
   - Perceived speed: skeletons that match the layout, no layout shift when pages load,
     optimistic file-tree updates.
   - A review of every screen at desktop, tablet and phone widths after the changes.

5. **Team access** — organizations/team workspaces in the UI, invitations, roles, share links,
   admin user management, audit events.

6. **Language server (Tinymist)** — completion, hover, go-to-definition, formatting and
   diagnostics while typing, behind the existing editor adapter.

7. **Real-time collaboration** — Yjs + Hocuspocus behind `/collab`, authorization before loading
   a document, presence and cursors, revocation when permissions change.

8. **Operations** — optional Redis/BullMQ job queue, optional S3-compatible storage, health and
   readiness details, structured logs with request ids, quotas per workspace.

## Smaller items

- Re-run the import dry-run compile when a different main file is chosen.
- Project-wide search and replace.
- Project folders and "move to workspace" on the dashboard.
- Share dialog (depends on team access).
- Dark theme, as an explicit choice.
- Preview: only re-fetch pages that changed; click a page position to jump to the source.
- Account page: change name, email and password; list and revoke sessions.

## Done

- Sandboxed compile worker, accounts and first-run setup, projects from templates, multi-file
  editor with autosave and conflict detection, live preview with diagnostics, PDF and ZIP export.
- App shell with connected rail and top bar, dashboard, template picker, Kernic branding.
- End-to-end test suite against the production build; content security policy; keyboard access.
- ZIP import with a dry-run check (`8a3fe41`).
- Docker Compose deployment (proxy, app, isolated worker, PostgreSQL) with self-hosting guide,
  backup and restore scripts and a tested restore.
