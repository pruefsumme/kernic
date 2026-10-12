# Kernic

A self-hosted, Git-first workspace for writing [Typst](https://typst.app/docs/) documents: edit a
multi-file project in the browser, see the rendered pages next to the source, and export a PDF.

> Early development. Writing alone or in a shared workspace works and can be self-hosted; Git
> remotes (Gitea/Forgejo) and real-time collaboration are not built yet. See
> [Status](#status) and the [backlog](docs/backlog.md).

To run your own installation, see **[docs/self-hosting.md](docs/self-hosting.md)**. What has
been checked for security and data safety, and what is still open, is in
**[docs/security.md](docs/security.md)**.

## How it is put together

| Part | Where | What it does |
| --- | --- | --- |
| Web app | `apps/web` | SvelteKit (Node adapter): UI, HTTP API, sessions, project rules, compile job queue |
| Compile worker | `apps/worker` | Runs the Typst CLI on an immutable snapshot of a project, in a sandbox |
| Database | PostgreSQL | Users, sessions, workspaces, project metadata, compile jobs |
| Files | `KERNIC_DATA_DIR` | Project files and rendered pages on local disk |

Project files, uploads and the documents built from them are treated as untrusted. The worker has no
database access and none of the app's secrets. It receives files by content hash (including the
files of any packages the document imports), compiles with resource limits (`prlimit`) inside a
sandbox without network access (`bubblewrap` in development, Landlock in the Docker image), and
returns diagnostics and rendered pages. Editor assistance runs the Tinymist language server under
the same confinement.

## Development

Requirements: Node 24+, pnpm, Docker (for PostgreSQL), Git, the
[Typst CLI](https://github.com/typst/typst) and `bubblewrap` on your `PATH`, and
[Tinymist](https://github.com/Myriad-Dreamin/tinymist) for editor assistance.

```sh
pnpm install
cp .env.example .env
docker compose -f compose.dev.yaml up -d --wait   # PostgreSQL on 127.0.0.1:54329
pnpm dev                                          # app on http://localhost:5173, worker on :3101
```

On first start the app prints a **setup token** in its log. Open the app, enter the token and create
the administrator account. Database migrations run automatically at startup.

Checks:

```sh
pnpm check   # type-check both packages
pnpm lint    # prettier + eslint
pnpm test    # unit tests; the worker tests compile real documents with the Typst CLI
pnpm test:e2e  # browser tests against the production build (needs the dev PostgreSQL)
pnpm test:durability  # kills the app while it saves, again and again, and checks nothing is lost
```

The end-to-end tests build the app, start it together with a worker on separate ports, and use
their own database (`kernic_test`, created and wiped automatically) and a temporary data
directory. They need Playwright's Chromium: `pnpm --filter @kernic/web exec playwright install chromium`.

The worker and its tests need the Typst CLI, and Tinymist for editor assistance.
`scripts/install-typst-tools.sh` installs both in the versions the worker image pins, checked
against the same checksums.

Every push and pull request runs all of the above on GitHub Actions, and then the browser tests
once more against the Docker Compose stack (`.github/workflows/ci.yml`). Images for ARM64 are
built for version tags and on request.

Configuration is read from environment variables; `.env.example` lists the ones needed for
development, and `apps/web/src/env.ts` and `apps/worker/src/config.ts` describe all of them.

## Status

Working:

- First-run setup with a setup token, sign in and sign out; accounts by invitation link, an
  account page (password, sessions), administration of people and an activity log
- Projects from built-in templates (blank, article, report, letter)
- Multi-file editor: file tree, uploads (also by dropping files, and pasting images into the
  source), rename, delete, Typst syntax highlighting
- Editor assistance from the Tinymist language server, sandboxed in the worker: completion of
  functions, labels, citations and fonts, documentation on hover, go to definition, rename,
  formatting
- Quick open (Ctrl+K) for files, headings and actions; search in all files of a project
- Autosave with conflict detection: a file changed elsewhere is never overwritten silently
- Live preview through the sandboxed worker, with compiler errors and warnings linked to the
  source; the compiler stays running between edits, so long documents follow quickly
- PDF export, optionally to a standard (PDF/A, PDF/UA) or for selected pages, and ZIP download of
  all project files
- Shared workspaces: several people on the same projects as viewer, editor or owner, joined
  through invitation links; a fair compile queue and storage limits per workspace
- Links for reading: show a project's rendered pages to someone without an account
- Light and dark theme and a choice of accent colour, per browser
- Version history: checkpoints (Git commits in a repository per project), a diff of what changed,
  restore of any earlier version without losing the current one, ZIP download of a version;
  automatic snapshots in between
- Import from a ZIP archive with a dry run: the archive is unpacked aside, scanned for packages
  and missing files and compiled once; the project is only created after you confirm
- Typst Universe packages: downloaded by the app from the registry, cached, and passed to the
  sandboxed worker, which itself has no network access
- Docker Compose deployment with an isolated compile worker, and backup and restore scripts

Not built yet:

- Importing from a Git repository
- Pushing and pulling checkpoints to a Gitea/Forgejo repository
- Review comments on a shared document
- Real-time collaboration
- A preview that follows each keystroke, and jumping between a place on the page and its source

## Licence

Kernic is free software under the [GNU Affero General Public License, version 3](LICENSE)
(AGPL-3.0-only). You may run, study, modify and share it. If you run a modified version as a
network service, you must offer its users the source of your changes.

Copyright (C) 2026 pruefsumme

Kernic uses other open-source software under its own licences; the Typst compiler and the Tinymist
language server in the compile worker are Apache-2.0. "Kernic" is the name of this project and is not
covered by the licence.
