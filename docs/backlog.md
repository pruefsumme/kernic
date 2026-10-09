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

### 1. Isolate each compile inside the worker container (review item 2)

**Problem.** In Docker, all compiles run as one unprivileged user and the worker's file cache
holds files of every project. Typst confines a document to its project, but a compiler bug that
escaped that confinement could read other projects' cached files.

**Options considered.**

- *bubblewrap inside the container* — what development uses. Tested here: user namespaces are
  refused in a default Docker container (`unshare: Operation not permitted`); enabling them means
  weakening the container's seccomp profile. Rejected.
- *A different Unix user per compile* — needs `CAP_SETUID`, which the container deliberately
  does not have. Rejected.
- *gVisor or Kata as container runtime* — strong, but an operator-side requirement, not something
  the project can ship. Worth documenting as optional hardening.
- *Landlock* — a Linux security module that lets an unprivileged process restrict its own file
  access. **Chosen.**

**Solution.** Run the compiler through `setpriv --landlock-access fs --landlock-rule …` from
util-linux, which is already used for `prlimit`. Rules per compile: read and execute on system
libraries, read on fonts, the job's source and its packages, write only on the job's output
folder. Everything else, including the cache of other projects, is unreachable.

- Tested here: in `debian:13-slim` with all capabilities dropped, `no-new-privileges` and a
  non-root user, a process restricted this way could read its allowed folder and was denied
  another folder and all writes. Docker's default seccomp profile allows the Landlock system
  calls (Docker 29).
- `setpriv` gained Landlock support in util-linux 2.40; Debian 12 ships 2.38, Debian 13 ships
  2.41. The worker image therefore moves from `node:24-bookworm-slim` to `node:24-trixie-slim`
  (exists; checked).
- Steps: add a `landlock` sandbox mode beside `bwrap` and `none`; make it the default in the
  image; the worker refuses to start if the kernel lacks Landlock rather than run unconfined;
  test that a compile cannot read the blob cache or another job's folder.
- Limits: Landlock needs kernel 5.13 or newer (any current distribution). It restricts files,
  not CPU or memory, which stay with `prlimit` and the container limits.

### 2. Automatic snapshots between checkpoints (review item 1)

**Problem.** Between explicit checkpoints nothing is recorded. A wrong paste followed by an hour
of saves can only be undone back to the last checkpoint.

**Solution.** Use the Git repository each project already has, on a separate reference so the
checkpoint history (what will later be pushed to a forge) stays clean. No new dependency.

- A snapshot is a commit on `refs/kernic/snapshots`, written with Git plumbing (a temporary
  index, `git write-tree`, `git commit-tree`, `git update-ref`), without touching the branch or
  the working files.
- Taken when a file is saved and the last snapshot is older than 10 minutes, and before any
  destructive action (delete, restore, import over). Identical content produces no snapshot.
- Thinned over time: all snapshots of the last 24 hours, then one per day for 30 days;
  checkpoints are never thinned.
- Shown in the History panel as a quieter "Automatic" group, with the same diff, restore and
  ZIP download.
- Tests: snapshot cadence with a fake clock, thinning, restore from a snapshot, and that
  snapshots never appear in the checkpoint list.

### 3. Account page, user management and audit log (review items 3 and 7)

**Solution.** Built on what exists (scrypt, the sessions table); no new dependency.

- Account page: change name and password (the current password is required; all other sessions
  are signed out), list sessions with last use and sign each out.
- Administrators: create an account by **invitation link** (single use, expires, stored hashed)
  rather than by choosing someone's password; disable and re-enable accounts; reset a password
  by sending a new link.
- `audit_events` table, append-only: who, what, on which object, from which address, when.
  Recorded: sign-in success and failure, setup, account creation and disabling, password
  change, project deletion, restore, import, membership changes. An admin page lists and
  filters them.
- Later, single sign-on against Gitea/Forgejo or another provider with `openid-client`, the
  widely used certified OpenID Connect client for Node. Not verified here.

### 4. UI polish

The layout and flow are settled; make it more pleasant to look at and smoother.

- Visual refinement: spacing rhythm, typography details, icon consistency, hover, active and
  focus states, empty and loading states, dialog and menu styling.
- Motion with intent and restraint: panel open and close, menu and dialog entrance, preview
  page updates (cross-fade instead of a hard swap), save and compile state changes. All of it
  respecting `prefers-reduced-motion`.
- Perceived speed: skeletons that match the layout, optimistic file-tree updates.
- A review of every screen at desktop, tablet and phone widths after the changes.

### 5. Faster preview while typing (parity with typst.app)

**Problem.** The preview follows a save by about a second for a long document, because every
compile starts cold.

**Options considered.**

- *Compile in the browser with typst.ts* — instant, but its releases trail the official compiler
  (pre-release builds against release candidates), so preview and exported PDF could differ, and
  it puts a second renderer in the product. Not now.
- *Tinymist's preview server* — incremental, renders only the visible part, and supports
  jumping between source and page. The right long-term answer together with item 6, but it is a
  second process per open project with its own protocol. Later.
- *The official CLI in watch mode* — **chosen as the first step.** One long-lived
  `typst watch` per open project keeps the compiler's incremental state.

**Solution.** The worker keeps a warm `typst watch` per recently active project (bounded count,
closed after idle minutes), fed by the same file snapshots, under the same sandbox and limits.
Cold compiles remain for exports and for the first compile.

- Tested here: the 75-page test document compiles in 844 ms cold and in 220–245 ms on each
  following edit in watch mode, with the official CLI.
- Then shorten the autosave delay for the preview, so the page follows typing within about half
  a second.
- Risk to check when building: detecting "this compile is finished" reliably from watch mode's
  output, and memory held per warm project.

### 6. Editor assistance and source-to-page jumps with Tinymist

Hover documentation, go-to-definition, formatting, rename and diagnostics while typing; clicking
a place on a page jumps to its source and back.

- Tinymist is the language server the Typst community and editor extensions use; its releases
  follow the compiler's. Tested here: the installed build offers `tinymist lsp` and
  `tinymist preview` (with partial rendering).
- Browser side: `@codemirror/lsp-client`, behind the existing editor adapter, over a WebSocket.
- Server side: one Tinymist process per open project in a container with the same isolation as
  the compile worker (item 1), no network, bounded count and memory. It sees project files
  through the language-server protocol, not a shared volume.
- Not verified: resource use per session, and how Tinymist's preview is best embedded.

### 7. Fonts (parity with typst.app)

**Problem.** The image has Typst's embedded fonts plus Liberation, DejaVu and Noto. Documents
written elsewhere often name other families and fall back silently.

**Solution.** Distribution packages only, so every font has a clear licence and update path.
Available in Debian 13 (checked): Inter, Roboto, Open Sans, Lato, Montserrat, TeX Gyre,
Latin Modern, Computer Modern Unicode, STIX, Linux Libertine, EB Garamond, Fira Code, JetBrains
Mono, Atkinson Hyperlegible, and Noto CJK (91 MB, so as an optional image variant). Not packaged
there: IBM Plex, Source Serif/Sans, Libertinus (embedded in Typst anyway), New Computer Modern
(embedded).

- Add the packaged set to the worker image; keep the documented mount for further fonts.
- Show the server's font families in the editor (from `typst fonts`), complete them inside
  `font: "…"`, and turn the compiler's "unknown font family" warning into a message that says
  how to add the font.

### 8. PDF export options

Expose what the compiler already supports: PDF standard (PDF/A variants, PDF/UA), page ranges
and tagged PDF, in an export dialog. The worker accepts them as a fixed list of allowed values,
never as free-form arguments.

### 9. Fair compile queue, and readiness for more than one app process (review items 5 and 6)

No broker needed for this; PostgreSQL covers it.

- Fairness: the claim query picks the oldest queued job of the account with the fewest running
  jobs; at most two running compiles per account; a per-account limit on compile requests.
- More than one process: replace the in-memory project lock with PostgreSQL advisory locks, and
  the in-memory attempt counters with a small table. Until then the documentation keeps saying
  "one app instance".
- BullMQ with Redis stays an option for many workers; it is established, but it is a second
  service to run and back up, so only when a single worker is not enough.

### 10. Package trust (review item 4)

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

### 11. Checks not yet exercised (review items 8 and 9)

- A CI pipeline (Forgejo Actions or GitHub Actions; the repository has none yet) that runs unit
  and end-to-end tests and builds both images for x86-64 and ARM64.
- An upgrade test: start the previous release's images with data, upgrade, and run the suite.
- A durability test: kill the app with `SIGKILL` in a loop while saving and verify that no file
  is ever empty or half-written; the same for the database with a failed migration.
- A real domain with an automatic certificate, once there is a host to try it on.
- The unexplained mass test failure: server output of test runs is now kept in `e2e/.logs/`;
  if it recurs, the cause can be read there.

### 12. Git remotes (Gitea/Forgejo)

Connect a project to a repository on a forge: push checkpoints, pull and merge changes made
elsewhere, import a project by cloning. Allow-listed hosts, scoped tokens stored as secrets, no
hooks, limits on size and time, Git run outside the compile worker.

### 13. Team access

Team workspaces in the interface, invitations, roles, share links. Builds on item 3.

### 14. Real-time collaboration

Yjs with the CodeMirror binding and Hocuspocus behind `/collab`; authorization before a document
is loaded; presence and cursors; connections closed when access is withdrawn.

### 15. Operations

Optional S3-compatible storage, structured logs with request ids, quotas per workspace, health
details.

## Smaller items

- History: restore a single file; compare any two checkpoints.
- Re-run the import dry-run compile when a different main file is chosen.
- Project-wide search and replace.
- Project folders and "move to workspace" on the dashboard.
- Share dialog (depends on team access).
- Dark theme, as an explicit choice.
- Render a thumbnail for projects that have none yet (after an upgrade or a restore).

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
