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

(To run the images of a release instead of building them, see "Published images" below.)

Edit `.env`:

- `KERNIC_SITE_ADDRESS` — where people will open Kernic:
  - `kernic.example.org`: a domain. Caddy obtains and renews a certificate automatically.
  - `localhost`: this machine only, with a locally trusted certificate.
  - `:80`: plain HTTP. Use this only behind another proxy that provides TLS, or on a network you
    trust; sign-in cookies are then not restricted to HTTPS.
- `POSTGRES_PASSWORD` and `KERNIC_WORKER_TOKEN` — two different random values. Generate each with
  `openssl rand -hex 32`.

Check the machine and the file before the first start; it changes nothing:

```sh
./preflight.sh
```

Then build and start:

```sh
docker compose up -d --build
```

The first build downloads the pinned Typst release and verifies its checksum.

### On a server on the internet

What a first installation on a VPS needs, in order:

1. **A kernel of 5.13 or newer** (`uname -r`; every current Debian, Ubuntu and Fedora has one).
   The compile worker uses Landlock and refuses to start without it. Most VPS providers allow
   this; a few container-based ones (OpenVZ, LXC without nesting) do not. `./preflight.sh`
   checks it.
2. **A domain** with an `A` (and `AAAA`) record pointing at the server, *before* the first
   start: Caddy asks for a certificate when it starts and a missing record makes it wait and
   retry. Put the domain in `KERNIC_SITE_ADDRESS`.
3. **Ports 80 and 443** open to the internet, and nothing else: the database, the worker and the
   app are not published. If a firewall runs on the machine (`ufw`, `firewalld`) allow those two
   (and your SSH port). Docker publishes ports around some firewalls, so check from outside with
   `nmap` or a port-scan website rather than trusting the firewall's own list.
4. `.env` with two different random values (`openssl rand -hex 32` for `POSTGRES_PASSWORD` and
   `KERNIC_WORKER_TOKEN`), then `./preflight.sh`, then `docker compose up -d --build`.
5. **The first account.** Open the address, read the setup token with
   `docker compose logs app | grep -i "setup token"`, create the administrator. Do this at once:
   until an account exists, whoever knows the token can claim the server. After that
   registration is closed; people join through invitation links you create under Administration.
6. **A backup that runs by itself.** `deploy/backup.sh` stops the app for a few seconds, so run
   it at a quiet hour from cron, and copy the result off the machine:
   `15 3 * * * cd /path/to/kernic/deploy && ./backup.sh /var/backups/kernic`. Try a restore on
   another machine once (see "Restore"); a backup nobody has restored is a hope.
7. **After the first start**, in this order: open the address over HTTPS (padlock, no
   warning), sign in, create a project from a template, see the preview appear, export a PDF.
   If the preview never appears, `docker compose logs worker` says why.

Kernic sends no e-mail: invitation and password-reset links are shown to the administrator, who
passes them on.

### Published images

A release publishes the app and worker images (x86-64 and ARM64) to the GitHub container
registry, so a server needs no source code and no build. In `.env`:

```sh
KERNIC_APP_IMAGE=ghcr.io/<owner>/kernic-app:<version>
KERNIC_WORKER_IMAGE=ghcr.io/<owner>/kernic-worker:<version>
```

Then `docker compose pull && docker compose up -d --no-build`. Use the same version for both.
While the repository is private, the images are private too: create a personal access token
with only `read:packages` and run `docker login ghcr.io -u <your user>` once on the server.
The files needed besides the images are the ones in `deploy/` (`compose.yaml`, `Caddyfile`,
`.env`, the scripts).

### First sign-in

A new installation has no accounts. Creating the administrator requires a **setup token**, so
that whoever reaches a fresh server first cannot claim it:

```sh
docker compose logs app | grep -i "setup token"
```

Open Kernic in a browser, enter the token and create the administrator account. The token changes
on every restart and stops working once an account exists. To choose the token yourself, set
`KERNIC_SETUP_TOKEN` in `.env` before the first start.

### Adding people

There is no public sign-up. As an administrator, open the account menu (top right) → **People**,
enter the person's email address and create an invitation link. Kernic does not send email: copy
the link and pass it on yourself. With it the person chooses their own name and password; the
link works once and expires after 7 days. The same page disables accounts and creates password
reset links. **Activity log** in the same menu shows sign-ins and account changes.

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
| `KERNIC_MAX_WORKSPACE_MB` | `2000` | Most megabytes of project files in one workspace. Each person has a workspace of their own. See "Sharing a server" below. |
| `KERNIC_MAX_WORKSPACE_PROJECTS` | `200` | Most projects in one workspace. |
| `KERNIC_MAX_WAITING_COMPILES` | `20` | Most compiles one account may have waiting or running at once. |
| `KERNIC_GIT_HOSTS` | empty | Git forges that projects may push their checkpoints to: host names separated by commas. Empty turns this off. See "Git repositories" below. |
| `KERNIC_SECRET_KEY` | empty | Encrypts stored access tokens; at least 32 characters. Required when `KERNIC_GIT_HOSTS` is set. |
| `KERNIC_WORKER_CPUS` | `2` | CPU limit of the compile worker. |
| `KERNIC_WORKER_MEMORY` | `4g` | Memory limit of the compile worker. |
| `KERNIC_COMPILE_TIMEOUT_MS` | `20000` | A compile is stopped after this time. |
| `KERNIC_WARM_SESSIONS` | `2` | Projects whose compiler stays running between preview compiles. `0` turns this off. See below. |
| `KERNIC_LANGUAGE_SESSIONS` | `4` | Open editors that get assistance from a language server at once. `0` turns this off. See below. |

### Sharing a server

When several people use one installation, no one of them should be able to take it all.

- **Compiles** are served in turn: when a place becomes free, it goes to the account with the
  fewest compiles running, and among those to the job that has waited longest. One account can
  have at most `KERNIC_MAX_WAITING_COMPILES` compiles waiting or running; a further request is
  refused with a message until some have finished.
- **Storage:** the files of all projects in a workspace may add up to `KERNIC_MAX_WORKSPACE_MB`,
  and a workspace may hold `KERNIC_MAX_WORKSPACE_PROJECTS` projects. Growth beyond that is
  refused with a message that names what is used; making things smaller always works. The
  version history and the rendered pages of a project are not counted. Everyone sees their own
  use under **Account**, and administrators see everyone's under **People**.
- **Editor assistance:** each person can have three editors assisted at once, out of
  `KERNIC_LANGUAGE_SESSIONS` on the whole server.

To size the disk, multiply `KERNIC_MAX_WORKSPACE_MB` by the number of accounts you expect and
add room for history, rendered pages and the database.

### Preview speed and memory

While a project is being edited, the worker keeps its compiler running, so that the preview of a
long document follows an edit in a few tenths of a second instead of compiling from the start
each time. Such a compiler holds what it computed in memory: a few hundred megabytes for a
document of 75 pages, and it is replaced once it holds more than 1 GB. It is stopped after ten
minutes without edits, or earlier if more projects are being edited than `KERNIC_WARM_SESSIONS`
allows; the project edited longest ago gives way.

Plan about 1 GB of `KERNIC_WORKER_MEMORY` for each warm compiler, on top of 2 GB for everything
else. On a small server, set `KERNIC_WARM_SESSIONS=1` or `0`. PDF export always compiles from
the start.

### Editor assistance

Completion of functions, labels, citations and fonts, documentation on hover, go to definition,
rename and formatting come from [Tinymist](https://github.com/Myriad-Dreamin/tinymist), the
Typst language server, which is part of the worker image. One runs per open editor, confined
like a compiler to a copy of that project, and it is stopped ten minutes after the editor last
used it or when the editor is closed.

A click on a page of the preview opens the place in the source that printed it, and Ctrl+J
(or the button above the preview) shows where the cursor's place is on the pages. For this the
worker runs the language server's preview for that editor while jumps are being used, and stops
it two minutes after the last one. It listens on a port inside the worker's container only.

`KERNIC_LANGUAGE_SESSIONS` bounds how many editors are assisted at the same time; each person
can have up to three. When all places are taken, a further editor works without assistance and
says so; a place is given up by an editor that has been quiet for two minutes. Plan about
100 to 300 MB of `KERNIC_WORKER_MEMORY` per place, more for very long documents, and note that
a language server compiles as its editor types, within the worker's CPU limit. For many
simultaneous writers, raise the number together with `KERNIC_WORKER_CPUS` and
`KERNIC_WORKER_MEMORY`; on a small server, lower it.

If you raise `KERNIC_MAX_PROJECT_MB` above 200, also raise `BODY_SIZE_LIMIT` of the app (set in
`apps/web/Dockerfile`, default `256M`) by adding it under `app.environment` in `compose.yaml`;
it must stay larger than the project limit.

### Git repositories

A project keeps its checkpoints in a Git repository of its own on the server. It can also push
them to a repository on a forge such as Forgejo or Gitea, so that the history exists in a second
place and can be read with any Git tool.

This is off until you name the forges the server may connect to:

```sh
KERNIC_GIT_HOSTS=git.example.org,codeberg.org
KERNIC_SECRET_KEY=<output of: openssl rand -hex 32>
```

- **Hosts.** The server opens these connections itself, so it only connects to hosts on this
  list, over HTTPS. A forge that is only reachable without TLS, for example one on the same
  private network, is written with its protocol and port: `http://forgejo:3000`. Addresses for
  SSH (`git@…`) are not supported. A forge that answers with a redirect is not followed.
- **The key.** People enter an access token for their repository; it is stored encrypted with
  `KERNIC_SECRET_KEY`. Keep the key with your backups. If it is lost or changed, the stored
  tokens cannot be read; projects then have to be disconnected and connected again. Nothing
  else depends on it.
- **In the app.** An owner of a workspace connects a project under Settings → Git repository,
  with the address of an empty repository, a branch and an access token that may write to it.
  The server tries the address and the token before it stores them. Everyone who may edit the
  project can then push and pull from the History panel. A push only adds: if the branch on the
  forge holds commits the project does not have, nothing is pushed and the panel says so; pull
  them first.
- **What is sent.** The checkpoints, with the names and e-mail addresses of the people who made
  them. Automatic snapshots stay on the server.
- **Pulling.** The branch is fetched and merged with the project. If the project has nothing
  the repository lacks, it just moves forward. Otherwise the two are merged; where both changed
  different parts they are combined, and where both changed the same file the person pulling
  chooses between the two versions of that file, one choice per file. Their own files are
  recorded as a checkpoint first, so a pull can be undone by restoring it. Files in a
  repository that a project cannot hold (links, submodules, names with odd characters, files
  over the limits above) are refused as a whole.
- **Disk.** A pull brings the repository's whole history into the project's own repository,
  which is kept next to its files and is not counted in the workspace's storage. A fetch that
  would add more than twice `KERNIC_MAX_PROJECT_MB` (at least 64 MB) is refused and removed.
  Git 2.38 or newer is needed in the app's image; the one in the image is.

- **Cloning.** On the dashboard, "Clone from Git" makes a project from a repository. It is
  fetched, checked like an uploaded ZIP archive (what it needs, what is missing, whether it
  compiles) and shown to you before anything is created. The project then has the repository's
  own history. With an access token it is connected to the repository, in step with it, so
  the first push is a plain fast-forward; without one (a public repository) it is only cloned.
  A repository with no `.typ` file, or with links or submodules in it, is refused.

### Fonts

Documents can use the fonts built into Typst (Libertinus Serif, New Computer Modern, DejaVu Sans
Mono), the families installed in the worker image (Liberation, DejaVu, Noto, Inter, Roboto, Open
Sans, Lato, TeX Gyre, Latin Modern, Computer Modern Unicode, STIX, Linux Libertine, EB Garamond,
Atkinson Hyperlegible, Fira Code, JetBrains Mono), and any font files uploaded into the project
itself. `docker compose exec worker typst fonts` lists every family. To make more fonts available to every project, put the font
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

`deploy/backup.sh` saves both. It stops the app while it copies them, so that the two are of
the same moment (usually well under a minute), and starts it again, whatever happens:

```sh
cd deploy
./backup.sh /path/to/backups
```

Each run makes a dated folder, such as `20261012-031500`, with:

| File | What it is |
| --- | --- |
| `database.dump` | the database |
| `projects.tar` | the project files with all their checkpoints |
| `manifest.txt` | what made it: Kernic's version, the database migrations, checksums, sizes |

The folder only gets its name once it is complete and has been checked (the dump is read back
and the archive listed); a run that fails leaves nothing behind, and the exit status says so.
Only one backup or restore runs at a time; a second one is refused (exit status 4). The files
are readable only by their owner. Rendered preview pages, unfinished imports and downloaded
packages are not included: they are made again when they are needed.

The oldest dated folders are removed beyond `KERNIC_BACKUP_KEEP_LOCAL` (default 7; 0 keeps
everything). Only folders named like these, holding a backup, are ever removed, and folders you
label (`./backup.sh --label before-the-viva`) never are.

**Two things are not in a backup and must be kept elsewhere:**

- `deploy/.env`. It holds `KERNIC_SECRET_KEY`: the access tokens people entered for their Git
  repositories (see above) can only be read with it. Without it, projects have to be
  connected to their repositories again; nothing else depends on it.
- The backup itself, on another machine: a backup on the same disk does not survive losing the
  disk, and neither does one on the same server survive losing the server.

To send backups off the machine, encrypted, to cloud storage, another server or another disk,
and to have them checked: see **[backups.md](backups.md)**.

Run it on a schedule, for example nightly with cron, and look at the log now and then:

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

It checks the backup against its manifest first (the checksums, and that this installation knows
every database migration the backup has: a backup made by a newer Kernic is refused with the
version to install), asks for confirmation, **saves what is there now** as a backup labelled
`pre-restore` in `deploy/backups`, restores the database and the project files, and starts Kernic.
People sign in with the accounts and passwords from the backup. If it stops halfway, run it
again: a restore can be repeated, and the message says where the copy of the previous state is.
`--no-safety-backup` skips the safety copy; `--yes` skips the question.

Backups made by the 0.1.0 scripts (`projects.tar.gz`, no manifest) can be restored too.

This procedure is tried by the pipeline on every change (`scripts/backup-roundtrip.sh`): it backs
up a running installation, damages it, restores it, wipes it and restores it again onto the empty
one, and restores a backup of the older kind; each time accounts, projects, database migrations
and every project file must be as they were. It also checks that a backup that is killed starts
the app again. Test it on your own machine once before you rely on it.

## Upgrade

New versions are announced as [releases](https://github.com/pruefsumme/kernic/releases) on GitHub
(subscribe to its feed, or watch the repository for releases). What changed, and **what you have to
do**, is in [CHANGELOG.md](../CHANGELOG.md), under "Upgrade notes" of every version you skip.

```sh
cd deploy
git fetch --tags && git checkout v<version>     # the new files (a detached HEAD is normal here)
# with published images, also set the same <version> in KERNIC_APP_IMAGE and KERNIC_WORKER_IMAGE in .env
./upgrade.sh
```

`upgrade.sh` checks the machine and `.env`, builds or pulls the new app and worker images (nothing
is stopped yet), shows the version, the database migrations that will be applied and the upgrade
notes, and asks. Then it makes a backup labelled `pre-upgrade` (and sends it off the machine, if
that is set up), starts the new version and waits until it is healthy. If that does not work, it
says how to go back. `./upgrade.sh --yes` skips the question.

Afterwards: sign in, open a project, see the preview, and look at `docker compose logs app` for
errors. The backup of before is kept in `deploy/backups`.

Things to know:

- **Update the files together with the images.** An image alone is not an upgrade: `compose.yaml`
  names the settings the app and worker get, so a new image with an old `compose.yaml` can miss a
  new setting. That is why you check out the files of the version you run. `upgrade.sh` lists
  settings that are in `.env.example` but not in your `.env` (their defaults apply).
- **Keep your own changes out of `compose.yaml` and `Caddyfile`:** put them in
  `compose.override.yaml` next to them, which Compose reads as well and a checkout never touches.
  Otherwise `git checkout` refuses to switch, or an upgrade loses them.
- **Name the version in the image tags** (`:0.2.0`), not `:latest`, so that you know what runs and
  can go back to it. To follow the newest version of the files, `git checkout main && git pull`
  (a bare `git pull` does not work after checking out a tag).
- **The proxy and database images are not upgraded by this.** They are `caddy:2-alpine` and
  `postgres:18-alpine`; pull them on purpose, after a backup:
  `docker compose pull proxy postgres && docker compose up -d`. A new major version of PostgreSQL
  needs a dump and a restore, never an image swap.
- **Without the script**, the same by hand: `./backup.sh backups`, new files, then
  `docker compose up -d --build --wait` (or with images: `docker compose pull app worker && docker
  compose up -d --no-build --wait`).

### Going back

Database migrations are applied automatically when the app starts, in one transaction: if one
fails the app stops with an error and the database is left as it was (`docker compose logs app`
says why). They only go forward. An older version **refuses** a database that a newer one has
changed ("downgrades are not supported") and does not touch it. So:

1. Put the old files and image tags back (`git checkout v<old version>`, the old tags in `.env`).
2. If the new version never ran, or it applied no migration: `docker compose up -d --wait`.
3. Otherwise restore the backup of before: `./restore.sh backups/<the pre-upgrade folder>`. What was
   written after it is lost, which is why `upgrade.sh` makes it just before.

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
  is gone when the container stops. Inside the container, each compile is further restricted
  with Landlock to the files of its own job, so one document's compile cannot read another
  project's files even if the compiler itself were tricked. This needs a host kernel of 5.13 or
  newer; the worker refuses to start if the restriction is not enforced.
- **Packages.** Only the app talks to the package registry. A package's code runs inside the
  same sandbox as the document that imports it.
- **Network.** Only the proxy publishes ports. The database and the worker are not reachable from
  outside the Compose networks. The one other container with a way out is the backup job, and
  only while it sends a backup (see [backups.md](backups.md)): it has no database access and sees
  a finished copy of the backup, read-only.
- **Sessions.** Sign-in cookies are `HttpOnly` and `SameSite=Lax`, and marked `Secure` when Kernic
  is served over HTTPS. Requests that change data must come from Kernic's own origin.
- **Accounts.** There is no public sign-up; people are invited by link. Passwords are stored as
  salted scrypt hashes.
- **Your part.** Keep `deploy/.env` private, serve Kernic over HTTPS, keep Docker and the host
  updated, and keep backups somewhere else.

A full security and reliability review is planned (see the [backlog](backlog.md)); until it is
done, expose an installation only to people you trust.
