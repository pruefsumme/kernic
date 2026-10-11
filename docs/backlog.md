# Backlog

Ordered by priority. Each item is one or more coherent slices that end in verified, committed
work. Move finished items to "Done" with the commit that completed them.

The yardstick for "ready": the owner intends to write a bachelor's thesis in Kernic, so a document
that works on typst.app should work here, and work in it must never be lost.

## Rules for new dependencies

Solutions below were chosen under one constraint: nothing of low trust enters the system.

- Prefer what is already here: PostgreSQL, Git, the official Typst CLI, util-linux, Node's
  standard library, CodeMirror.
- A new component must be the established one for its job, actively maintained, and replaceable:
  Tinymist (the Typst language server), `@codemirror/lsp-client` (by CodeMirror's author),
  Yjs with Hocuspocus, `openid-client`, distribution font packages.
- Not acceptable: small single-maintainer sandbox wrappers, npm packages that wrap a system tool
  we can call directly, stale builds (the `tinymist-web` npm package was last published in
  January 2025), or anything that needs the worker to have network access or extra privileges.

"Tested here" below means the claim was checked on this project's machine on 11 October 2026.
"Not verified" means it comes from documentation or general knowledge and must be confirmed when
the item is built.

## Next

### 1. Preview that follows typing, and jumps between page and source

Editor assistance from Tinymist is in place (see "Done"). What Tinymist can still give:

- Its preview renders incrementally and only what is visible, and knows which place on a page
  belongs to which place in the source. That would let the preview follow each keystroke and
  make a click on the page jump to its source, and back. It needs the preview's own protocol
  passed through the worker with the same care as the language-server protocol.
- Errors and warnings while typing, from the language server's diagnostics, merged with the
  compiler's after each save so that nothing is shown twice.
- Not verified: how much memory and processor time the preview adds per open editor.

### 2. Fair compile queue, and readiness for more than one app process

No broker needed for this; PostgreSQL covers it.

- Fairness: the claim query picks the oldest queued job of the account with the fewest running
  jobs; at most two running compiles per account; a per-account limit on compile requests.
- More than one process: replace the in-memory project lock with PostgreSQL advisory locks, and
  the in-memory attempt counters with a small table. Until then the documentation keeps saying
  "one app instance".
- BullMQ with Redis stays an option for many workers; it is established, but it is a second
  service to run and back up, so only when a single worker is not enough.

### 3. Package trust

**Finding.** Typst Universe's index publishes no checksums (checked: the index has name,
version, entrypoint, authors, licence and similar fields only), and the official CLI does not
verify any either. Authenticity rests on HTTPS to the registry.

**Solution.** Make the existing "first download wins" visible and controllable.

- Record each installed package (version, SHA-256, when, first requested by whom) in the
  database; an admin page lists them and can remove one.
- Optional approval mode: new packages are not fetched until an administrator approves them.
- Per project, record the hashes of the packages it compiled with, and warn if a later install
  of the same version has a different hash (for example after a restore onto a new server).
- Private packages: administrators upload a package archive into a `local` namespace.

### 4. Checks not yet exercised

- A CI pipeline (Forgejo Actions or GitHub Actions; the repository has none yet) that runs unit
  and end-to-end tests and builds both images for x86-64 and ARM64.
- An upgrade test: start the previous release's images with data, upgrade, and run the suite.
- A failed migration: start the app against a database where a migration fails half-way and
  check that it stops without leaving the schema half-changed.
- A real domain with an automatic certificate, once there is a host to try it on.
- The unexplained mass test failure: server output of test runs is now kept in `e2e/.logs/`;
  if it recurs, the cause can be read there.

### 5. Git remotes (Gitea/Forgejo)

Connect a project to a repository on a forge: push checkpoints, pull and merge changes made
elsewhere, import a project by cloning. Allow-listed hosts, scoped tokens stored as secrets, no
hooks, limits on size and time, Git run outside the compile worker.

### 6. Team access

Team workspaces in the interface, membership and roles, share links. Accounts and invitations
exist; what is missing is putting several people into one workspace.

### 7. Real-time collaboration

Yjs with the CodeMirror binding and Hocuspocus behind `/collab`; authorization before a document
is loaded; presence and cursors; connections closed when access is withdrawn.

### 8. Operations

Optional S3-compatible storage, structured logs with request ids, quotas per workspace, health
details.

## Smaller items

- History: restore a single file; compare any two checkpoints.
- Re-run the import dry-run compile when a different main file is chosen.
- Replace across all files of a project (search across them exists).
- Project folders and "move to workspace" on the dashboard.
- Share dialog (depends on team access).
- Dark theme, as an explicit choice.
- Accounts: make another person an administrator; change one's email address; single sign-on
  against Gitea/Forgejo or another provider with `openid-client`.
- Polish, second round: optimistic file-tree updates, a skeleton for the first render of a
  project, drag and drop to move files within the tree.
- Render a thumbnail for projects that have none yet (after an upgrade or a restore).
- Fonts: complete the families of font files uploaded into the project too (needs the worker to
  read them inside the sandbox); an optional image variant with Noto CJK (91 MB).

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
  only near the screen (`a6f95dd`).
- Each compile confined with Landlock inside the worker container; worker image on Debian 13
  with a larger set of packaged fonts.
- Automatic snapshots between checkpoints, on their own Git references, thinned over time.
- UI polish: motion tokens, dialog and menu entrances, cross-fade between screens and between
  renderings of a page, hover and press feedback, paper-like thumbnails, quiet scrollbars.
- Account page (name, password, sessions), people management by invitation and reset links,
  activity log.
- Durability check (`pnpm test:durability`): the app is killed while saving, again and again,
  and files, history and the restarted app are examined; leftovers of cut-off saves are
  cleared at startup.
- Editor assistance: one sandboxed Tinymist language server per open editor in the worker,
  reached through authenticated routes of the app (HTTP posts and server-sent events, no
  WebSocket), with `@codemirror/lsp-client` in the editor. Completion, hover documentation,
  signature help, go to definition, find references, rename, formatting. Off where Tinymist
  is not installed or `KERNIC_LANGUAGE_SESSIONS=0`.
- Search in all files of a project (Ctrl+Shift+F): plain text, any capitalisation, grouped by
  file; a match opens the file at its place.
- Fonts in the editor: the families installed on the server are completed inside `font: "…"`,
  and the compiler's "unknown font family" warning names the font as written and says what to do.
- PDF export options: a standard (PDF/A variants, PDF/UA-1), a selection of pages, and
  accessibility tags, checked against fixed lists in the app and again in the worker.
- Quick open (Ctrl+K, or File → Go to file or heading): jump to a file or heading, or run an
  action, by typing a few letters.
- Files can be dropped anywhere on the editor screen; images dropped or pasted into a Typst
  source are stored beside it and inserted at the cursor. Dropdowns match the other fields.
- Faster preview while typing: the worker keeps one `typst watch` per recently edited project
  (same confinement and limits, bounded number, memory and idle time) and falls back to a
  compile from scratch whenever it cannot vouch for a result; pages the app already stores are
  not sent again; autosave after 0.4 s. Measured on the 75-page document: 1.2 s per edit before,
  0.4 s after, in development and in Docker.
