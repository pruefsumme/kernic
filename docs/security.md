# Security, safety and reliability review

Reviewed on 11 October 2026 against the code at that date. This is a self-review by the
project's developer, not an independent audit. It states what was checked and how, what was
fixed, and what remains open. "Tested" means there is an automated test or a recorded manual
check; anything else is marked as reasoning only.

The standard applied: Kernic will hold long-lived personal work such as a thesis, on a server
shared with other people. Work must not be lost, and one person must not be able to read or
change another's.

## What is being protected, and from whom

| Asset | Threat |
| --- | --- |
| Project files and their history | Loss (crash, bad edit, failed upgrade, disk loss); access by another account |
| Accounts and sessions | Password guessing, session theft, cross-site requests |
| The server itself | Hostile documents, archives, uploads and packages that try to read files, reach the network, exhaust resources or run code |
| Other people's browsers | Uploaded or rendered content that runs script in Kernic's origin |

Trusted: the host, Docker, the operator, PostgreSQL, the reverse proxy. Not trusted: every
signed-in user's files, and everything fetched from outside (packages).

## Controls and the evidence for them

### Other accounts

- Every project route resolves the project through one function that requires membership of
  the project's workspace, and answers "not found" otherwise.
- **Tested:** a second account tries 23 routes of another user's project — files, uploads,
  compile, job status, rendered pages, PDF, ZIP, history, diff, restore, import status and
  preview, and the editor, settings and import pages — and gets 404 on each; rename, delete,
  confirming the other user's import, and creating projects or imports in the other user's
  workspace are refused; the owner's files and history are unchanged afterwards
  (`e2e/authorization.spec.ts`).
- **Tested:** a disabled account loses its session on the next request and cannot sign in.
- Shared workspaces: several people reach the same projects, each in a role (viewer, editor,
  owner) that is looked up for every request. People join through single-use links that an
  owner creates; only a hash of a link is stored, and ownership is never handed out by link.
  A workspace always keeps an owner. **Tested** with two accounts
  (`e2e/workspaces.spec.ts`): before joining, the project and the workspace answer "not
  found"; a viewer can open but not save; made an editor, they can; a link works once and can
  be withdrawn; an editor cannot manage members; the last owner cannot leave; a removed member
  loses the project and the workspace on their next request.

### Sign-in and sessions

- Passwords: scrypt (N=2^15, r=8, p=3), salted, parameters stored with the hash. Minimum length
  10. Sign-in attempts are limited per address and per account; unknown addresses take as long
  as wrong passwords.
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` over HTTPS
  (**tested** in the Docker stack); only a SHA-256 of the token is stored. 30 days, extended on
  use. Sign-out deletes the session (**tested**).
- First-run setup needs a token from the server log; attempts are limited; setup closes for good
  once an account exists (**tested**).
- Accounts are created by invitation: an administrator creates a single-use link (7 days) and
  the person chooses their own name and password, so no password is ever known to an
  administrator. Password resets work the same way (24 hours) and sign the account out
  everywhere. Only hashes of the links are stored. **Tested:** a link works once; a disabled
  account is signed out at once and cannot sign in; people who are not administrators get "not
  found" on the administration pages and their actions.
- Changing a password requires the current one, is rate-limited, and ends every other session.
  Each person can see their sessions and end any of them. **Tested.**
- Sign-ins (including failed ones), account changes, password changes, project deletions,
  restores and imports are written to an append-only activity log that administrators can read.
- Requests that change anything must carry Kernic's own `Origin` (**tested**, including a
  request with no `Origin` at all).

### Hostile documents

- The compiler runs in a separate worker that has no database access and no application
  secrets. In the Docker deployment the container is read-only, has no capabilities, runs
  unprivileged, and is on a network with no route out. **Tested** inside the running container:
  no internet, no DNS, no connection to the database, no writable root, empty capability sets.
- Limits per compile: wall time, CPU time, address space, output size, page count, open files.
  **Tested:** an endless computation, a 4 GB allocation, a 60-page document against a 20-page
  limit, and 179 MB of output against a 1 MB limit each fail with a specific message, and the
  worker serves the next request.
- Export options become compiler arguments. Only a standard from a fixed list and a page
  selection of digits, commas and hyphens are accepted, by the app and again by the worker.
  **Tested** with option-like and shell-like values at both levels.
- **Tested:** documents cannot read `/proc/self/environ`, `/etc/passwd` or anything else
  outside their project, by absolute path or by `..`.
- Each compile is additionally confined to its own files: with `bubblewrap` in development,
  and with Landlock (through `setpriv`) in the Docker image, where bubblewrap cannot run. The
  worker checks at startup that the confinement is actually enforced and refuses to start
  otherwise. **Tested** with a stand-in compiler that tries to read the worker's cache and
  system files and to write into its sources: all denied under Landlock, all possible without
  it. Also checked inside the running container.
- While a project is edited, its compiler stays running between preview compiles (`typst watch`,
  at most two projects by default). Such a compiler runs under the same confinement and limits,
  on its own copy of one project, and is ended with the worker. What it returns must equal a
  compile from scratch, so the worker keeps strict control: the compiler is stopped while its
  files are replaced, its messages are read while it is stopped, and if a compile started that
  the worker did not ask for, or anything else is not as expected, the compiler is discarded
  and the document is compiled from scratch. **Tested** in all three confinement modes: every
  state in a series of edits (including errors, removed pages, files that appear, disappear or
  turn into folders, packages added later, six simultaneous requests and forty random edits) is
  compiled both ways and compared page by page and message by message; a killed compiler, a
  compiler that was made to compile behind the worker's back, a compile over the time limit and
  a compiler over its memory allowance are each handled. Also run in the Docker deployment.

- Editor assistance runs the Tinymist language server, one per open editor, under the same
  confinement and limits as a compiler and on its own copy of the project. The editor does not
  talk to it directly: the worker passes on only a fixed list of requests (completion, hover,
  definition, references, rename, formatting and the document notifications), so the server's
  commands that export files or start previews cannot be reached; it sets the project root and
  the server's settings itself; and it translates file addresses, so the editor only ever
  names `file:///project/…` and never learns where the copy lies. The app in front of it ties
  each connection to one person and one project. **Tested** in all three confinement modes:
  export and preview commands are refused and write nothing, addresses outside the project
  (plain, with `..`, percent-encoded) are refused, settings and root sent by the editor are
  ignored, nothing the editor receives contains a path of the worker, and another account
  gets "not found" for a project's assistance routes.

### Uploads, archives, packages

- Paths: one validator for every path; rejects `..`, absolute paths, backslashes, control
  characters and `.git`. Symbolic links in a project are never followed. **Tested** at unit
  level and through the HTTP API with encoded traversal attempts.
- ZIP import: entry count, per-file and total size checked before writing; symbolic links,
  system files and Git metadata skipped; entries pointing outside the archive reject the whole
  archive; encrypted archives rejected. **Tested.**
- Packages: fetched by the app only, from one configured host, `preview` namespace only, no
  redirects; size and count limits; only regular files unpacked. **Tested** with a package that
  ships a symbolic link to a server file.
- Version history: Git runs without user or system configuration, hooks or transports;
  checkpoint identifiers are validated and must belong to the project. **Tested** with hostile
  `.gitattributes`/`.gitconfig`, option-like file names and non-checkpoint identifiers.

### Content shown in the browser

- Project files and rendered pages are served with `Content-Security-Policy: default-src
  'none'; sandbox` and `nosniff`; HTML uploads are served as plain text. **Tested.**
- Documentation shown on hover comes from the document and its packages as Markdown, which
  may contain HTML. Only plain formatting elements, `class` and web links survive; scripts,
  images, styles and event handlers are removed. **Tested** with a doc comment carrying an
  image with an error handler and a script.
- The chosen look (theme and accent hue) is kept in a cookie that scripts may read, and the
  server writes it into each page. Only a theme from a fixed list and a number are accepted;
  anything else gives the default. **Tested** with markup in the cookie.
- App pages carry a content security policy (scripts only from Kernic itself), `X-Frame-Options:
  DENY`, `Cross-Origin-Opener-Policy`, `Referrer-Policy` and `Permissions-Policy`. The
  end-to-end tests fail on any policy violation the browser reports.

### Not losing work

- Saving: content is written to a temporary file beside the project, flushed to disk, renamed
  into place, and the directory is flushed. A crash or power cut leaves the old or the new file.
  **Tested** by killing the app (`SIGKILL`) 100 times while three files were being saved and
  checkpoints created (`pnpm test:durability`): no file was ever empty or incomplete, every
  save the server had acknowledged was on disk, the Git history passed `git fsck`, and the
  restarted app served the same content and accepted new saves and checkpoints. A killed
  process is not a power cut; power loss itself was not simulated.
- Two tabs or two people: a save names the version it started from and is refused if the file
  changed meanwhile; the editor then offers both versions. **Tested.**
- Leaving the editor, losing the connection, being signed out: pending text is kept and sent
  when possible. **Tested** for navigation and offline.
- Version history: checkpoints are Git commits; restore first records the current files and
  only ever adds to history. **Tested**, including recovery of text that was never checkpointed.
- Automatic snapshots between checkpoints: taken before a round of edits, at most every ten
  minutes, and before every deletion; all kept for a day, then one per day for 30 days.
  **Tested**: a file deleted together with text that was never checkpointed is restored.
- Concurrency: saves, moves, deletes, uploads, checkpoints and restores of one project are
  serialized. **Tested** with about 2,200 saves, 190 compiles and 350 restores running at once:
  no server errors, no crash.
- Backup and restore: scripts provided; a full destroy-and-restore drill was done (see
  `self-hosting.md`).
- Upgrades: migrations run in one transaction under a lock. **Tested** against PostgreSQL: a
  failing migration leaves the database unchanged, edited migrations and databases from a newer
  version are refused, two instances starting together apply each migration once.
- An unhandled promise rejection is logged instead of stopping the server.
- Dependencies: `pnpm audit --prod` reports no known vulnerabilities (11 October 2026).

## Found and fixed during the review

1. Temporary files of in-progress saves were inside the project tree, visible to listings and
   liable to be captured in a checkpoint. Now written beside the tree.
2. A compile failed if a file changed while it was being sent to the worker. It now restarts
   from a fresh snapshot.
3. A restore could interleave with a save. All changes to a project now take one lock.
4. Saves were not flushed to disk before being acknowledged.
5. An unhandled promise rejection would have terminated the server.
6. A compiler stopped by a limit was reported as "stopped unexpectedly"; the limit is now named.
7. A worker test passed because its document had a syntax error, not because the limit worked.
8. `Cross-Origin-Opener-Policy`, `Permissions-Policy` and `Strict-Transport-Security` were missing.
9. The app closed idle connections after 5 seconds, sooner than the proxy does. A request sent on
   a connection that was just being closed failed with "The server could not be reached" (seen
   once in a test run, on an upload). The app now keeps idle connections longer than the proxy.
10. Long documents were slow to preview: every change re-sent every page (26 MB of SVG for a
    74-page document). Pages are now stored and addressed by their content and loaded only near
    the screen. Measured on a 75-page document: opening fetches 3 pages; an edit fetches only
    the pages in view that actually changed.
11. In Docker, all compiles ran as one user with access to the worker's whole file cache, so a
    compiler bug that escaped Typst's own confinement could have read other projects' files.
    Each compile is now restricted with Landlock to its own job.
12. Nothing was recorded between explicit checkpoints. The files are now recorded automatically
    before a round of edits (at most every ten minutes) and before every deletion, apart from
    the checkpoint history; a snapshot can be compared, restored and downloaded like a
    checkpoint.
13. There was no way to change a password, see one's sessions, or add people. There is now an
    account page (changing the password requires the current one and signs every other session
    out), an administrators' page to invite, disable and reset accounts through single-use
    links, and an append-only activity log.
14. Compiler messages such as "file not found" contained the directory a job ran in on the
    server. They now name the file as it is called in the project.
15. A save that was cut off by a crash left its temporary copy beside the project for good
    (found by the kill test: a few per hundred kills). They are now removed when the app starts.
16. The development server opened a new database pool on every reload of server code until
    PostgreSQL refused connections. Reloads share one pool now; production was not affected.
17. The compile queue was first come, first served, and nothing bounded what a workspace could
    store beyond the limit per project, so one account could hold up or fill a shared server.
    Compiles are now served to accounts in turn, with a cap on what one account may have
    waiting; a workspace has a storage and a project limit, shown to its people and to
    administrators.

## Open

Ordered by how much they matter for someone writing a thesis here. The researched solution for
each is in the [backlog](backlog.md).

1. **Package authenticity rests on HTTPS and first download.** The registry publishes no
   checksums to verify against. Each version is fetched once and its SHA-256 is logged.
2. **Single process.** Rate limits, the per-project lock and editor-assistance connections live
   in memory; running several app instances is not supported.
3. **Not yet exercised:** a real domain with an automatic certificate, the test suites on ARM64
   hardware (the pipeline only builds the ARM64 images), an upgrade between two released
   versions, power loss during a save.
4. **Unexplained:** one end-to-end run had every test after a history test fail quickly, as if
    the app had stopped. It did not recur in ten further runs or under the stress test, and its
    logs were not kept. Server output of test runs is now kept so that a recurrence can be read.

## How Kernic compares with typst.app for thesis work

Checked on the pinned compiler, Typst 0.15.1.

| Area | State |
| --- | --- |
| Compiler and output | The official Typst CLI; PDF export is the CLI's. No custom renderer. |
| Multi-file projects, includes, images, data files | Work; tested. |
| Bibliography | Works (`bibliography()` with `.bib`; used by the Article template). |
| Packages from Typst Universe | Work, including dependencies. Old package versions that do not support Typst 0.15 fail exactly as they do with the CLI. `@local` packages: not supported. |
| Fonts | 276 families in the Docker image: Typst's embedded fonts plus Liberation, DejaVu, Noto, Inter, Roboto, Open Sans, Lato, TeX Gyre, Latin Modern, Computer Modern Unicode, STIX, Linux Libertine, EB Garamond, Atkinson Hyperlegible, Fira Code and JetBrains Mono. Other fonts are uploaded into the project or added to the server. Not compared one by one with typst.app's selection. |
| Long documents | 74 pages with contents, 72 numbered equations, 72 tables and a bibliography: 1.1 s for the first compile and for an export, 0.4 s for each following preview. The preview loads only the pages in view and re-fetches only pages that changed. |
| Preview | Server-rendered after a pause in typing of 0.4 s; for the 74-page document the pages follow about 0.4 s later (measured, also in Docker). typst.app renders in the browser as you type, which is still faster. |
| Editor assistance | Tinymist, the language server the Typst editor extensions use: completion of functions, parameters, labels, citations, fonts and packages; documentation on hover; signature help; go to definition across files (F12); find references; rename (F2); formatting (Shift+Alt+F). Also quick open (Ctrl+K) and search in all files. Not there yet: errors as you type (they follow the compile after each save) and jumping between a place on the page and its source. |
| Collaboration, comments, sharing links | Not available. |
| PDF options | Export → "PDF with options": PDF/A-1b, 2b, 2a, 3b, 4 and PDF/UA-1, a selection of pages, and accessibility tags. A document that does not meet the chosen standard is refused with the compiler's reason. Whether a file passes an external validator such as veraPDF has not been checked. |
| Version history | Explicit checkpoints with diff and restore, plus automatic snapshots at most every ten minutes. |
