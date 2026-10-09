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

### Sign-in and sessions

- Passwords: scrypt (N=2^15, r=8, p=3), salted, parameters stored with the hash. Minimum length
  10. Sign-in attempts are limited per address and per account; unknown addresses take as long
  as wrong passwords.
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie, `Secure` over HTTPS
  (**tested** in the Docker stack); only a SHA-256 of the token is stored. 30 days, extended on
  use. Sign-out deletes the session (**tested**).
- First-run setup needs a token from the server log; attempts are limited; setup closes for good
  once an account exists (**tested**).
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
- **Tested:** documents cannot read `/proc/self/environ`, `/etc/passwd` or anything else
  outside their project, by absolute path or by `..`.
- With `bubblewrap` (development, or a host install) each compile additionally sees only its
  own files. In Docker this inner sandbox is not available; see open item 2.

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
- App pages carry a content security policy (scripts only from Kernic itself), `X-Frame-Options:
  DENY`, `Cross-Origin-Opener-Policy`, `Referrer-Policy` and `Permissions-Policy`. The
  end-to-end tests fail on any policy violation the browser reports.

### Not losing work

- Saving: content is written to a temporary file beside the project, flushed to disk, renamed
  into place, and the directory is flushed. A crash or power cut leaves the old or the new file.
  (Reasoning and unit tests; power loss itself was not simulated.)
- Two tabs or two people: a save names the version it started from and is refused if the file
  changed meanwhile; the editor then offers both versions. **Tested.**
- Leaving the editor, losing the connection, being signed out: pending text is kept and sent
  when possible. **Tested** for navigation and offline.
- Version history: checkpoints are Git commits; restore first records the current files and
  only ever adds to history. **Tested**, including recovery of text that was never checkpointed.
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

## Open

Ordered by how much they matter for someone writing a thesis here.

1. **Nothing is recorded between checkpoints.** A bad edit followed by more saves can only be
   undone back to the last explicit checkpoint. Automatic snapshots are planned.
2. **In Docker, compiles of different projects share one unprivileged user.** Typst confines a
   document to its project; if that confinement were bypassed by a compiler bug, the process
   could read other projects' files held in the worker's cache. Options: a per-job sandbox
   inside the container (needs user namespaces enabled for it), or a per-project cache.
3. **No account self-service.** There is no page to change one's password or see and revoke
   sessions, and no interface to create further accounts.
4. **Package authenticity rests on HTTPS and first download.** The registry publishes no
   checksums to verify against. Each version is fetched once and its SHA-256 is logged.
5. **Single process.** Rate limits and the per-project lock live in memory; running several app
   instances is not supported.
6. **No fairness in the compile queue.** One account can queue compiles for many projects.
7. **No audit log** of sign-ins, access changes or deletions.
8. **Not yet exercised:** a real domain with an automatic certificate, ARM64, an upgrade
   between two released versions, power loss during a save.
9. **Unexplained:** one end-to-end run had every test after a history test fail quickly, as if
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
| Fonts | Typst's embedded fonts plus Liberation, DejaVu and Noto in the Docker image; other fonts must be uploaded into the project or added to the server. typst.app offers a larger built-in selection. |
| Long documents | 74 pages with contents, 72 numbered equations, 72 tables and a bibliography: 1.1 s to compile, 1.0 s to export. The preview loads only the pages in view and re-fetches only pages that changed. |
| Preview | Server-rendered after each save (about a second behind typing for a long document). typst.app renders in the browser as you type. |
| Editor assistance | Syntax highlighting and completion of built-in functions. No hover documentation, go-to-definition or formatting yet. |
| Collaboration, comments, sharing links | Not available. |
| PDF options (PDF/A, tagged PDF, page ranges) | Not exposed in the interface yet; the compiler supports them. |
| Version history | Explicit checkpoints with diff and restore. No automatic history yet. |
