# Self-hosting Kernic

Kernic runs on one machine with Docker Compose. Four containers make up an installation:

| Service | Image | Role |
| --- | --- | --- |
| `proxy` | `caddy:2-alpine` | The only public entry point. Terminates TLS and forwards to the app. |
| `app` | built from `apps/web` | Web interface, API, sessions, project files, compile job queue. |
| `worker` | built from `apps/worker` | Runs the Typst compiler on documents. Isolated; see [Security](#security). |
| `postgres` | `postgres:18-alpine` | Accounts, project metadata, job state. |

Everything is configured in one file, `deploy/.env`.

## Requirements

- A Linux machine (x86-64 or ARM64) with Docker Engine and the Compose plugin.
- About 1 GB of disk for the images, plus space for your projects.
- 2 GB of free memory is comfortable; the worker is limited to 4 GB by default.
- For HTTPS with an automatic certificate: a domain name pointing at the machine, and ports 80
  and 443 reachable from the internet.

## Install

```sh
git clone <this repository> kernic
cd kernic/deploy
cp .env.example .env
```

Edit `.env`:

- `KERNIC_SITE_ADDRESS` — where people will open Kernic:
  - `kernic.example.org`: a domain. Caddy obtains and renews a certificate automatically.
  - `localhost`: this machine only, with a locally trusted certificate.
  - `:80`: plain HTTP. Use this only behind another proxy that provides TLS, or on a network you
    trust; sign-in cookies are then not restricted to HTTPS.
- `POSTGRES_PASSWORD` and `KERNIC_WORKER_TOKEN` — two different random values. Generate each with
  `openssl rand -hex 32`.

Then build and start:

```sh
docker compose up -d --build
```

The first build downloads the pinned Typst release and verifies its checksum.

### First sign-in

A new installation has no accounts. Creating the administrator requires a **setup token**, so
that whoever reaches a fresh server first cannot claim it:

```sh
docker compose logs app | grep -i "setup token"
```

Open Kernic in a browser, enter the token and create the administrator account. The token changes
on every restart and stops working once an account exists. To choose the token yourself, set
`KERNIC_SETUP_TOKEN` in `.env` before the first start.

## Configuration

Set these in `deploy/.env`, then apply with `docker compose up -d`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KERNIC_SITE_ADDRESS` | — | Public address; see above. |
| `KERNIC_HTTP_PORT`, `KERNIC_HTTPS_PORT` | `80`, `443` | Host ports of the proxy. With other ports, open the HTTPS address directly: the automatic redirect from HTTP points at port 443. |
| `POSTGRES_PASSWORD` | — | Database password (internal network only). |
| `KERNIC_WORKER_TOKEN` | — | Shared secret between app and worker, at least 24 characters. |
| `KERNIC_SETUP_TOKEN` | generated | Fixed first-run token. |
| `KERNIC_MAX_FILE_MB` | `25` | Largest single file in a project. |
| `KERNIC_MAX_PROJECT_MB` | `200` | Largest project, and largest ZIP accepted for import. |
| `KERNIC_MAX_PROJECT_FILES` | `2000` | Most files and folders in a project. |
| `KERNIC_WORKER_CPUS` | `2` | CPU limit of the compile worker. |
| `KERNIC_WORKER_MEMORY` | `4g` | Memory limit of the compile worker. |
| `KERNIC_COMPILE_TIMEOUT_MS` | `20000` | A compile is stopped after this time. |

If you raise `KERNIC_MAX_PROJECT_MB` above 200, also raise `BODY_SIZE_LIMIT` of the app (set in
`apps/web/Dockerfile`, default `256M`) by adding it under `app.environment` in `compose.yaml`;
it must stay larger than the project limit.

### Fonts

Documents can use the fonts built into Typst (Libertinus Serif, New Computer Modern, DejaVu Sans
Mono), the Liberation, DejaVu and Noto families installed in the worker image, and any font files
uploaded into the project itself. To make more fonts available to every project, put the font
files in a folder next to `compose.yaml` and mount it into the worker:

```yaml
  worker:
    volumes:
      - ./fonts:/usr/local/share/fonts/extra:ro
```

### Typst packages

Documents can import packages from [Typst Universe](https://typst.app/universe)
(`#import "@preview/name:1.2.3"`), including packages that depend on other packages.

The compile worker has no network access, so the **app** downloads a package the first time a
document needs it — only from the configured registry, only from the `preview` namespace — and
passes its files to the worker. Archives are unpacked with the same care as uploads: size and
file-count limits, regular files only, nothing outside the package folder. A downloaded version
is kept in the data volume under `packages/` and never fetched again, so a document keeps
compiling against exactly the files it was written with. The log records each installation with
the archive's SHA-256.

| Variable | Default | Meaning |
| --- | --- | --- |
| `KERNIC_PACKAGE_REGISTRY` | `https://packages.typst.org` | Registry to download from. Set a mirror's URL, or `off` to disable downloads; packages already installed keep working. |

Private namespaces such as `@local` are not available. Packages are not part of a backup; after
a restore they are downloaded again when a document needs them.

## Backup

Two things hold your data, and a backup needs both:

- the **database** (accounts, project list, settings), and
- the **`kernic-data` volume** (the files of every project and their version history).

`deploy/backup.sh` saves both. It stops the app for a few seconds so that the two are captured at
the same moment, and starts it again:

```sh
cd deploy
./backup.sh /path/to/backups
```

Each run creates a dated folder with `database.dump` and `projects.tar.gz` (project files
including all checkpoints). Rendered preview pages
are not included; they are produced again when a project is opened. Copy the folder to another
machine: a backup on the same disk does not survive losing the disk. Also keep a copy of
`deploy/.env`.

Run it on a schedule, for example nightly with cron:

```cron
15 3 * * * cd /srv/kernic/deploy && ./backup.sh /srv/backups/kernic >> /var/log/kernic-backup.log 2>&1
```

Individual projects can also be downloaded as a ZIP archive from the editor (Export → All files)
or from the project's settings, and imported again later.

## Restore

`deploy/restore.sh` replaces **everything** in the installation with a backup:

```sh
cd deploy
docker compose up -d --build      # on a new machine: install first, do not run setup
./restore.sh /path/to/backups/20261011-220800
```

It asks for confirmation, restores the database and the project files, and starts Kernic. People
sign in with the accounts and passwords from the backup.

This procedure was exercised end to end: an installation with twenty projects was backed up,
removed including all volumes, reinstalled empty and restored; the project list, file contents
and compilation were verified afterwards. Test it yourself once before you rely on it.

## Upgrade

```sh
cd deploy
./backup.sh /path/to/backups       # always back up first
git pull
docker compose up -d --build
```

Database migrations are applied automatically when the app starts. They only go forward: after
an upgrade, the database cannot be used with an older version of Kernic. To go back, reinstall
the older version and restore the backup taken before the upgrade. If a migration fails, the app
stops with an error instead of starting half-migrated; `docker compose logs app` shows the reason.

## Operating

```sh
docker compose ps                  # state and health of the services
docker compose logs -f app         # follow the app log
docker compose restart app
docker compose down                # stop; data stays in the volumes
```

`GET /healthz` answers `200` with `{"ok": true, "database": true, "worker": true, …}` when the app
can reach its database. `worker: false` means editing still works but documents cannot be
compiled.

## Security

What the deployment does, and what it relies on you for.

- **Untrusted documents.** Typst files, uploads and imported archives are treated as hostile. The
  `worker` container that compiles them has a read-only file system, no Linux capabilities, runs
  as an unprivileged user, has CPU, memory, process and time limits, and is attached only to an
  internal network: it cannot reach the internet, the database or the proxy. It holds none of the
  app's secrets; the worker token only lets the app talk to it. Its scratch space is in memory and
  is gone when the container stops.
- **Packages.** Only the app talks to the package registry. A package's code runs inside the
  same sandbox as the document that imports it.
- **Network.** Only the proxy publishes ports. The database and the worker are not reachable from
  outside the Compose networks.
- **Sessions.** Sign-in cookies are `HttpOnly` and `SameSite=Lax`, and marked `Secure` when Kernic
  is served over HTTPS. Requests that change data must come from Kernic's own origin.
- **Accounts.** There is no public sign-up. Passwords are stored as salted scrypt hashes.
- **Your part.** Keep `deploy/.env` private, serve Kernic over HTTPS, keep Docker and the host
  updated, and keep backups somewhere else.

A full security and reliability review is planned (see the [backlog](backlog.md)); until it is
done, expose an installation only to people you trust.
