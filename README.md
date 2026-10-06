# Kernic

A self-hosted, Git-first workspace for writing [Typst](https://typst.app/docs/) documents: edit a
multi-file project in the browser, see the rendered pages next to the source, and export a PDF.

> Early development. The single-user editing loop works; Git checkpoints, team sharing, real-time
> collaboration and the production deployment are not built yet. See [Status](#status).

## How it is put together

| Part | Where | What it does |
| --- | --- | --- |
| Web app | `apps/web` | SvelteKit (Node adapter): UI, HTTP API, sessions, project rules, compile job queue |
| Compile worker | `apps/worker` | Runs the Typst CLI on an immutable snapshot of a project, in a sandbox |
| Database | PostgreSQL | Users, sessions, workspaces, project metadata, compile jobs |
| Files | `KERNIC_DATA_DIR` | Project files and rendered pages on local disk |

Project files, uploads and the documents built from them are treated as untrusted. The worker has no
database access and none of the app's secrets. It receives files by content hash, compiles with
resource limits (`prlimit`) inside a `bubblewrap` sandbox without network access, and returns
diagnostics and rendered pages.

## Development

Requirements: Node 24+, pnpm, Docker (for PostgreSQL), the [Typst CLI](https://github.com/typst/typst)
and `bubblewrap` on your `PATH`.

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
```

The end-to-end tests build the app, start it together with a worker on separate ports, and use
their own database (`kernic_test`, created and wiped automatically) and a temporary data
directory. They need Playwright's Chromium: `pnpm --filter @kernic/web exec playwright install chromium`.

Configuration is read from environment variables; `.env.example` lists the ones needed for
development, and `apps/web/src/env.ts` and `apps/worker/src/config.ts` describe all of them.

## Status

Working:

- First-run setup with a setup token, sign in and sign out
- Projects from built-in templates (blank, article, report, letter)
- Multi-file editor: file tree, uploads, rename, delete, Typst syntax highlighting and completion
- Autosave with conflict detection: a file changed elsewhere is never overwritten silently
- Live preview through the sandboxed worker, with compiler errors and warnings linked to the source
- PDF export and ZIP download of all project files

Not built yet:

- Importing existing projects (ZIP, Git) with a dry-run check
- Git checkpoints and Gitea/Forgejo integration
- Team workspaces in the UI, sharing and review
- Typst packages from Typst Universe (the sandbox has no network access)
- Tinymist language server features, real-time collaboration
- Production Docker Compose deployment, backup and upgrade guides
