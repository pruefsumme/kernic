#!/bin/sh
# Sends a finished backup to the repository named in deploy/.env (KERNIC_BACKUP_REPOSITORY).
#
#   ./backup-upload.sh <backup folder>
#
# backup.sh runs this after it has made the folder, so that the app is only stopped for the
# copy and not for the upload. To send a folder again, for example after the network was
# down: ./backup-upload.sh backups/20261012-031500
#
# The folder is read, and sent encrypted, by the "backup" job of compose.yaml: a container
# that has the folder (read-only), the settings of the destination and the internet, and
# nothing of the database or the project files. Snapshots beyond KERNIC_BACKUP_KEEP_DAILY,
# _WEEKLY and _MONTHLY (7, 4, 6) are removed from the repository afterwards.
#
# Exit status: 0 done, 1 failed, 2 not set up.
set -eu
cd "$(dirname "$0")"
# shellcheck source=backup-lib.sh
. ./backup-lib.sh

[ $# -eq 1 ] || die 2 "usage: ./backup-upload.sh <backup folder>"
folder="$1"
[ -f "$folder/manifest.txt" ] || die 1 "$folder is not a backup made by backup.sh (no manifest.txt)."
stage="$(cd "$folder" && pwd)"

repository="$(setting KERNIC_BACKUP_REPOSITORY)"
[ -n "$repository" ] || die 2 "KERNIC_BACKUP_REPOSITORY is not set in deploy/.env. See docs/backups.md."
password="$(setting KERNIC_BACKUP_PASSWORD)"
[ "${#password}" -ge 12 ] ||
	die 2 "KERNIC_BACKUP_PASSWORD must be set, 12 characters or more (openssl rand -hex 24). It encrypts the backups: keep a copy of it outside this server."

for name in KEEP_DAILY KEEP_WEEKLY KEEP_MONTHLY; do
	case "$(setting "KERNIC_BACKUP_$name")" in
	*[!0-9]*) die 2 "KERNIC_BACKUP_$name must be a number." ;;
	esac
done
daily="$(setting KERNIC_BACKUP_KEEP_DAILY)"
weekly="$(setting KERNIC_BACKUP_KEEP_WEEKLY)"
monthly="$(setting KERNIC_BACKUP_KEEP_MONTHLY)"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
write_secrets_copy "$work/kernic.env"
version="$(sed -n 's/^kernic_version=//p' "$stage/manifest.txt" | head -n 1)"

backup_folders
backup_image
# Not "docker compose run backup restic ...": the entrypoint is restic already.
restic() {
	backup_run -v "$stage:/stage:ro" -v "$work/kernic.env:/secrets/kernic.env:ro" backup "$@"
}

say "Using $(restic version)"
# Does the repository exist? restic answers 10 when there is none, and 12 for a wrong password.
status=0
restic cat config >/dev/null 2>"$work/error" || status=$?
case "$status" in
0) ;;
10)
	say "Making the repository (the first time)..."
	restic init --repository-version 2 >/dev/null
	;;
12) die 1 "The repository does not accept KERNIC_BACKUP_PASSWORD. Nothing was sent." ;;
*)
	cat "$work/error" >&2
	die 1 "The repository (a ${repository%%:*} one) cannot be reached; see above. Nothing was sent."
	;;
esac

say "Sending the backup..."
restic backup /stage /secrets --host kernic --tag kernic --tag "v${version:-unknown}" \
	--ignore-inode --ignore-ctime --quiet

say "Removing the snapshots that are no longer wanted..."
restic forget --host kernic --tag kernic \
	--keep-daily "${daily:-7}" --keep-weekly "${weekly:-4}" --keep-monthly "${monthly:-6}" \
	--prune --quiet

say "In the repository now:"
restic snapshots --host kernic --tag kernic --compact | sed 's/^/  /'
