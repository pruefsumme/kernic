# Backups

A backup that sits on the same disk as the thing it protects is not a backup: it does not
survive a dead disk, a deleted server or a mistaken `docker volume rm`. This page is about
getting backups off the machine, encrypted, kept for as long as you want, and checked. The basics
(what a backup holds, restoring) are in [self-hosting.md](self-hosting.md#backup).

What you get:

- **Every night** (once you set up the timer): the database and all project files of the
  installation, in a dated folder on this machine, made while the app is stopped for under a
  minute.
- **Sent off the machine, encrypted**, to a place you choose: an S3-compatible storage such as
  Backblaze B2, a server you can reach over SSH such as a Hetzner Storage Box, Google Drive,
  Dropbox, OneDrive, Nextcloud, or another disk. [restic](https://restic.net) does the encrypting
  and the bookkeeping; [rclone](https://rclone.org) reaches the cloud services.
- **Only what changed** is sent after the first time, and the repository keeps the newest of each
  of the last 7 days, 4 weeks and 6 months, and drops the rest.
- **A weekly check** that a backup can really be restored, and an alarm from a monitor of your
  choice if a backup or a check did not happen.

## What to keep somewhere else

If the server is gone, these are all you have. Put them in a password manager, not on the server.

| What | Why |
| --- | --- |
| `KERNIC_BACKUP_PASSWORD` | Encrypts the repository. **Without it nobody can read the backups, not even you.** |
| The address of the repository, and its login (`KERNIC_BACKUP_S3_*`, the SSH key, or rclone's token) | To reach it from a new machine |
| `KERNIC_SECRET_KEY` | The Git access tokens in the database can only be read with it. A copy is also inside every snapshot, so this one is covered as long as you have the password |

## Setting up

1. Choose where the backups go (below) and fill in the matching lines of `deploy/.env`; they are
   described in `.env.example`. Generate the password with `openssl rand -hex 24` and **copy it
   somewhere safe right now.**
2. `./preflight.sh` checks what you entered.
3. `./backup.sh` makes a backup and sends it. The first time it makes the repository; if something
   is wrong it says what, and the backup stays on this machine (exit status 3). Send a folder
   again later with `./backup-upload.sh backups/<folder>`.
4. Schedule it: copy `deploy/systemd/kernic-backup.*` to `/etc/systemd/system/`, set the two paths
   in the service, and `systemctl enable --now kernic-backup.timer`. Or use cron (see
   [self-hosting.md](self-hosting.md#backup)). Do the same with `kernic-verify.*` for the weekly check.
5. **Try a restore** on another machine or a scratch installation once, from the repository alone:
   install Kernic, put the `KERNIC_BACKUP_*` lines into `deploy/.env`, run
   `./restore.sh --from-repo`. A backup nobody has restored is a hope.

### Where to send them

**Backblaze B2, Cloudflare R2, Wasabi, Amazon S3 (an S3 API).** The easiest to run without
attention: a fixed key that does not expire, and you pay by the amount stored (a thesis costs
cents). Make a bucket (private), and a key that may only use that bucket. For B2:

```
KERNIC_BACKUP_REPOSITORY=s3:https://s3.us-west-004.backblazeb2.com/my-bucket/kernic
KERNIC_BACKUP_S3_KEY_ID=...          # B2: keyID
KERNIC_BACKUP_S3_SECRET=...          # B2: applicationKey
KERNIC_BACKUP_S3_REGION=us-west-004  # the region in the endpoint
```

The endpoint is shown with the bucket. For R2, Wasabi or S3 use their endpoint in the same place.
If the service offers it, turn on versioning or object lock: then a stolen key cannot erase
the backups (see "What a break-in could do" below).

**A Hetzner Storage Box, or any server you can reach over SSH.** Also fixed credentials and
inexpensive. In the Hetzner console enable SSH support for the box (it answers on port 23), and
better make a sub-account that only this backup uses. Then, in `deploy/`:

```sh
mkdir -p backup-config/ssh && chmod 700 backup-config/ssh
ssh-keygen -t ed25519 -N '' -f backup-config/ssh/id_ed25519      # the key the job uses
ssh-keyscan -p 23 u123456.your-storagebox.de > backup-config/ssh/known_hosts
```

Install `backup-config/ssh/id_ed25519.pub` on the box as Hetzner's SSH key guide says (in normal
OpenSSH format, not RFC 4716), then:

```
KERNIC_BACKUP_REPOSITORY=sftp://u123456@u123456.your-storagebox.de:23/kernic
```

The path after the port is relative to the box's home (a single slash; a double slash would be an
absolute path). The server's key is checked against `known_hosts`: compare what `ssh-keyscan`
gave you with the fingerprints in the Hetzner console.

**Google Drive, Dropbox, OneDrive, Nextcloud and the many others rclone knows.** Convenient if you
have the space already, but these log in through a web page and hand out tokens that can expire,
so an unattended server needs care. Set up the destination once:

```sh
./backup-tool.sh rclone config        # name it, for example gdrive
```

and use `KERNIC_BACKUP_REPOSITORY=rclone:gdrive:kernic`. The login is kept in
`backup-config/rclone/rclone.conf`. On a server without a browser, answer "no" when it asks to
open one, and run the command it prints (`rclone authorize "drive"`) on a computer that has
one. For **Google Drive** in particular:

- Make your own OAuth client in the Google Cloud console and give its id and secret to rclone: the
  one that ships with rclone is being retired during 2026 and is shared with everyone, with their
  rate limits.
- Set the consent screen's publishing status to **In production**. While it says "Testing", the
  login stops working after seven days and the backups fail until you log in again. A personal
  app under 100 users needs no verification by Google, only a warning when you log in.
- Limit it to the `drive.file` scope (files rclone made) when rclone asks for the scope.
- Keep the whole `backup-config/rclone/` folder: rclone renews the login there.

Dropbox and OneDrive are set up the same way through `rclone config`; their logins have rules of
their own about expiring (not tested for this guide), so watch the first weeks of runs. If you want
to not think about it, use one of the first two.

**Another disk or a mounted share.** `KERNIC_BACKUP_REPOSITORY=/repo` and
`KERNIC_BACKUP_LOCAL_REPO=/mnt/backup-disk/kernic`. Protects against a failing disk, not against
losing the machine.

## What a run does

1. `backup.sh` copies the database and the project files into a dated folder in `deploy/backups`
   (or the directory you give it), with the app stopped, and starts the app again.
2. It then sends the folder to the repository, with the app running. The first time this takes as
   long as the data is large; later runs send what changed. A run that finds the previous one still
   sending is refused (exit status 4) and tries again at the next time.
3. Old snapshots beyond the 7 daily, 4 weekly and 6 monthly ones are removed from the repository,
   and old dated folders beyond the newest 7 from this machine.

The uploads run in their own container (`backup` in `compose.yaml`, started only for the length of
an upload). It sees the finished folder read-only and the settings of the destination, has no
access to the database or the data volume, and is the only part of Kernic on a network of its own
for this ("egress"). Nothing leaves in the clear: restic encrypts with your password before it
sends.

Each snapshot also holds a copy of the settings needed to rebuild the installation from
`deploy/.env` (the address, the image versions, the limits, `KERNIC_SECRET_KEY`), never the
passwords of the database and the worker, and never `KERNIC_BACKUP_*`. That copy exists only in the
encrypted repository; the folder on this machine does not have it.

## Checking and being told

- `./verify-backup.sh` checks the newest backup folder on this machine: checksums, that the dump can
  be read and the archive listed, that this version of Kernic knows every migration in it.
  `./verify-backup.sh --from-repo --full` does it for the repository: restic reads part of it (a
  different twentieth every day, so all of it in about three weeks), the newest snapshot is fetched
  and checked, and its database is restored into a scratch database next to the real one, which is
  dropped again. Nothing of the installation changes.
- A monitor tells you when it does not happen. Set `KERNIC_BACKUP_PING_URL` (and
  `KERNIC_BACKUP_VERIFY_PING_URL`) to the address of a check on
  [Healthchecks.io](https://healthchecks.io) (free for a few checks; you can run your own) and tell
  it how often to expect a ping: it is sent when a run starts, ends, or fails, and it e-mails you
  when it does not come. An Uptime Kuma push monitor works too (its address has a `?`: then only the
  successful end is reported, and it alarms when that is missing).
- `./backup-tool.sh restic snapshots` shows what is in the repository; `restic check` and the rest
  of restic's commands work the same way, with the right settings applied.
- Every run is in the journal of the timer, or the log you redirect cron to.

## Restoring from the repository

On the same machine: `./restore.sh --from-repo` brings back the newest snapshot (or a named one:
`--from-repo 4f2a9c1d`; `./backup-tool.sh restic snapshots` lists them). It saves what is there now
first, checks the backup against its manifest, and replaces the database and the project files.

On a new machine: install Kernic as for a new installation, **without** running the first-run
setup, put your `KERNIC_BACKUP_*` lines (and for an SSH or rclone destination the `backup-config`
folder) back into `deploy/`, run `docker compose up -d --build`, and `./restore.sh --from-repo`. If
the `KERNIC_SECRET_KEY` of the new `.env` is another than the backup was made with, it tells you and
leaves the old settings in `backups/kernic.env.from-backup`.

## What a break-in could do

- Whoever has the server has the repository's password and login (they are in `deploy/.env`) and
  can read every backup, and can also **delete or overwrite them**: restic's housekeeping needs the
  same rights as a delete. To make that not final, use the destination's own protection: object
  lock or versioning on a bucket, the snapshots a Storage Box can keep of itself (managed in
  its console; check in Hetzner's documentation what your plan includes and that the SSH login
  cannot remove them), or, where the destination supports it, an append-only key for the server and
  the housekeeping done from a second machine.
- The dated folders on the server are **not** encrypted. They hold password hashes, the encrypted
  Git tokens and every project; keep the folder private (it is, to its owner) and the number of
  copies small (`KERNIC_BACKUP_KEEP_LOCAL`).
- If you think the repository's password was seen, make a new repository with a new password: old
  snapshots stay readable with the old one.

## When it does not work

| Message | Meaning |
| --- | --- |
| "The backup was made … but not sent" (exit status 3) | The local copy is fine. The line above it says why the sending failed; fix that and run `./backup-upload.sh backups/<folder>` |
| "The repository does not accept KERNIC_BACKUP_PASSWORD" | Wrong password for that repository. There is no way around it: that is what the encryption is for |
| "cannot be reached" | The address, the login, the network. For SFTP check `backup-config/ssh/` (the key, and `known_hosts` with the server's key); for rclone `./backup-tool.sh rclone lsd gdrive:` tells you whether the login still works |
| "Another backup or restore is running" (exit status 4) | The previous run is still going (a first upload can take hours), or it died: its lock is let go by the next run |
