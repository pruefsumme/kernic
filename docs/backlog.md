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

### 1. Preview while typing

Jumps between page and source are in place (see "Done"). What is left of this item:

- Errors and warnings while typing, from the language server's diagnostics, merged with the
  compiler's after each save so that nothing is shown twice.
- A preview that follows each keystroke. Measured on 12 October 2026: the page changes about
  0.65 s after a keystroke on a short document, of which 0.4 s is the pause before saving, and
  about 0.75 s on a 75-page document. Following every keystroke would mean rendering in the
  browser from the language server's preview data, with a second renderer (typst.ts, WebAssembly)
  beside the compiler that makes the PDF. Not planned unless people ask for it: the page shown
  today is exactly what the export contains, and a second renderer is a large dependency.
- Jumps under bubblewrap. There the language server has a network of its own and the worker
  cannot reach its preview, so jumps are only offered under Landlock (the Docker image). A
  developer who runs the worker outside Docker has to switch the mode to try them.
- Not verified: what the preview for jumps costs with many open editors. On the 75-page
  document it added about 20 MB of memory to the language server and it renders on each change
  while it runs; it is stopped two minutes after the last jump.

### 2. Readiness for more than one app process

The per-project lock, the sign-in attempt counters, the editor-assistance connections and the
note that a push is under way live in the memory of the one app process. For several app instances behind a load balancer: PostgreSQL
advisory locks for the project lock, a small table for the counters, and connections that any
instance can serve. No broker is needed for this. Until then the documentation says "one app
instance".

BullMQ with Redis stays an option for many compile workers; it is established, but it is a
second service to run and back up, so only when a single worker is not enough.

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

- An upgrade test in the pipeline: start the previous release's images with data, upgrade, and
  run the suite. It needs a first released version to upgrade from.
- Publishing images from the pipeline (a registry and tags per release), once there is a
  licence and a first version.
- ARM64: the images are built under emulation for tags and on request; the test suites have
  not run on ARM64 hardware.
- A failed migration: start the app against a database where a migration fails half-way and
  check that it stops without leaving the schema half-changed.
- A real domain with an automatic certificate, once there is a host to try it on.
- The unexplained mass test failure: server output of test runs is now kept in `e2e/.logs/`;
  if it recurs, the cause can be read there.

### 5. Git remotes (Gitea/Forgejo)

Pushing and pulling are in place (see "Done"). Still to build, in this order:

- Create a project from a repository (clone), through the same checks and the dry run of the
  ZIP import.
- Push automatically after each checkpoint, as an option, with a visible state when the forge
  could not be reached.
- Changing the branch or the token without disconnecting; a proxy for outgoing connections;
  SSH addresses with a key per project.
- Conflicts: show the two versions side by side and allow combining them by hand; today a
  file is taken from one side whole. Binary files and conflicts around renames and folders
  are settled the same way and have not been tried beyond the simple cases.
- Not verified: Gitea, GitLab and GitHub (the protocol is the same; only Forgejo 13 and the
  stand-in forge of the tests were tried), pushing or pulling a history of several hundred
  megabytes, and `.gitattributes` in a pulled repository.

### 6. Real-time collaboration

Yjs with the CodeMirror binding and Hocuspocus behind `/collab`; authorization before a document
is loaded; presence and cursors; connections closed when access is withdrawn.

### 7. Operations

Optional S3-compatible storage, structured logs with request ids, quotas per workspace, health
details.

## Smaller items

- History: restore a single file; compare any two checkpoints.
- Re-run the import dry-run compile when a different main file is chosen.
- Replace across all files of a project (search across them exists).
- Project folders on the dashboard.
- Review comments on a shared document, for readers with a link and for members.
- A PDF download for readers with a link (needs a bound on what anonymous readers can make the
  server compile).
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
- Links for reading: an owner creates a link that shows a project's rendered pages to anyone
  who has it, without an account; with an optional end date, a record of when it was last
  opened, and a way to withdraw it.
- Shared workspaces: created by anyone, joined through single-use links in a role (viewer,
  editor, owner), with a members page to change roles, remove people, leave, rename and delete;
  a project moves between workspaces from its settings.
- Sharing a server fairly: compiles are served to accounts in turn, with a cap on what one
  account may have waiting; a workspace has a storage limit and a project limit, enforced on
  saves, uploads, imports and new projects and shown under Account and People.
- Appearance (Account, Appearance): light, dark or following the system; an accent colour from
  presets or any hue; pages softened in the dark theme. Kept per browser in a cookie and
  rendered by the server, so pages never flash in the other theme. A selection in the editor
  now stays visible on the highlighted line.
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
- Settings pages in sections: the account, a workspace and a project's settings each list their
  sections at the side (across the top on a phone) and show one at a time, as groups; the
  address names the section, so a section can be linked to and survives a reload and a form.
- Workspaces as one screen: all of them listed at the side, the personal one apart from the
  shared ones, and the chosen one beside the list with its projects, members, invitations and
  settings as tabs. The dashboard marks projects of shared workspaces and can show one
  workspace's projects alone.
- Pulling from a Git repository: fetch, then move forward or merge; a clean merge is applied,
  and for files both sides changed the person chooses a side per file. What comes in is checked
  like an upload before anything is written. Tried against Forgejo 13.0.5 and Git 2.39 (the
  version in the app image).
- Pushing checkpoints to a Git repository on a forge: an owner connects a project to a
  repository on a host the administrator allows, with an access token that is stored encrypted;
  editors push from the History panel, which shows how many checkpoints the repository lacks.
  A push only adds and never follows a redirect. Tried against Forgejo 13.0.5.
- Jumps between page and source: a click on a page opens the place in the source that printed
  it (a click beside the text means the nearest text), and Ctrl+J or the button above the
  preview scrolls to the cursor's place on the pages and marks it. A place that prints nothing
  itself, such as the start of a line or a function call, is answered by the nearest words
  before it; a heading that is also in the table of contents is shown where the preview already
  is, and asking again goes on to its next appearance. Answered by the language server's
  preview, which the worker drives itself; under Landlock and without a sandbox.
- Faster preview while typing: the worker keeps one `typst watch` per recently edited project
  (same confinement and limits, bounded number, memory and idle time) and falls back to a
  compile from scratch whenever it cannot vouch for a result; pages the app already stores are
  not sent again; autosave after 0.4 s. Measured on the 75-page document: 1.2 s per edit before,
  0.4 s after, in development and in Docker.
