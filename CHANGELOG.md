# Changes

## Unreleased

**Backup and restore**
- `backup.sh` stops the app only while it copies, and always starts it again, also when it is
  interrupted; only one backup or restore runs at a time; the folder appears complete or not at
  all, with a `manifest.txt`; files are private to their owner; old dated folders are removed
  (`KERNIC_BACKUP_KEEP_LOCAL`, default 7).
- `restore.sh` checks a backup against its manifest, refuses one from a newer Kernic, saves the
  current state first (`pre-restore`) and says how to go back if it stops halfway.
- The pipeline backs up, damages and restores a running installation on every change.

**Upgrade notes**
- The backup folder holds `projects.tar` (not compressed) instead of `projects.tar.gz`, and is
  bigger as a result. Backups of the older kind can still be restored.
- `backup.sh` now removes dated folders beyond the newest 7 in the backup directory it is given.
  Set `KERNIC_BACKUP_KEEP_LOCAL=0` in `deploy/.env` to keep everything as before.

## 0.1.0

The first release. Kernic is a self-hosted workspace for writing Typst documents in the
browser, with the sandboxed compile worker, accounts and shared workspaces, version history
and Git remotes. It has been checked by its own test suites (unit, browser against the
production build, browser against the Docker Compose deployment) and by hand on Forgejo 13; it
has not yet had long use by real people on a real server.

**Writing**
- Multi-file editor with autosave and conflict detection, file tree, uploads and pasted images,
  Typst syntax highlighting, quick open (Ctrl+K), search in all files.
- Editor assistance from the Tinymist language server (completion, documentation, go to
  definition, rename, formatting), run in the same sandbox as the compiler.
- Live preview from a warm compiler, with errors linked to the source, and jumps between a
  place on a page and its place in the source (under Landlock, as in Docker).
- PDF export, optionally to PDF/A or PDF/UA or for selected pages; ZIP download of a project.
- Typst Universe packages, fetched by the app and passed to the worker, which has no network.
- Import from a ZIP archive or a Git repository with a dry run before anything is created.

**People**
- First-run setup with a setup token; accounts by invitation link; an administrator's page for
  people and an activity log.
- Shared workspaces with viewer, editor and owner roles, joined by single-use links; storage
  and compile limits per workspace and a fair compile queue; links for reading a project
  without an account.
- Light and dark themes and an accent colour, per browser.

**History and Git**
- Checkpoints (Git commits in a repository per project), automatic snapshots, diff, restore
  without losing the current state.
- Push, pull and clone against a Git forge (Forgejo, Gitea) that the administrator allows;
  files changed on both sides are settled by choosing a version per file.

**Running it**
- Docker Compose deployment (proxy, app, isolated worker, PostgreSQL) for x86-64 and ARM64,
  `deploy/preflight.sh`, backup and restore scripts, published images.

**Known limits** (details in `docs/backlog.md` and `docs/security.md`)
- One app process: several instances behind a load balancer are not supported yet.
- No real-time collaboration: two people in one file get a conflict warning, not a merge.
- The preview follows a pause in typing of 0.4 s, not each keystroke.
- No e-mail: invitation and reset links are passed on by the administrator.
- Not yet exercised: ARM64 on real hardware, a real domain with an automatic certificate, an
  upgrade between two releases (there was no earlier release).
