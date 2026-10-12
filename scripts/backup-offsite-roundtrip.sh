#!/bin/sh
# shellcheck disable=SC2154,SC2034 # the variables of roundtrip-lib.sh
# Tries sending backups to another place and getting them back, on a running Kernic from
# deploy/, with the three kinds of destination that need no account anywhere:
#
#   scripts/backup-offsite-roundtrip.sh --replace-everything
#
#   - a restic repository on another disk (/repo),
#   - a repository reached through rclone (here rclone's "local" kind: it proves the rclone
#     program, the bridge to restic and the folder of settings),
#   - an S3 server (rclone serves one for the test), which is how Backblaze B2, Cloudflare R2,
#     Wasabi and Amazon S3 are reached.
#
# For each: a backup is sent, checked, and restored onto a damaged installation. A wrong
# password must leave the local backup in place and say so (exit status 3). The restores
# REPLACE EVERYTHING in the installation, so the flag says so: for the pipeline and for a test
# installation, never for one that holds work.
set -eu
[ "${1:-}" = --replace-everything ] || {
	echo "usage: scripts/backup-offsite-roundtrip.sh --replace-everything   (replaces all data of the installation in deploy/)" >&2
	exit 2
}
cd "$(dirname "$0")/../deploy"
# shellcheck source=roundtrip-lib.sh
. ../scripts/roundtrip-lib.sh

s3_server=kernic-s3-roundtrip
cleanup() {
	docker rm -f "$s3_server" >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT

ensure_data
before="$(state)"

export KERNIC_BACKUP_PASSWORD=roundtrip-password-0123456789
export KERNIC_BACKUP_CONFIG_DIR="$work/config"
export KERNIC_BACKUP_LOCAL_REPO="$work/repo"
export KERNIC_BACKUP_KEEP_LOCAL=2

# restic's own listing, without a terminal.
restic_tool() { ./backup-tool.sh restic "$@" </dev/null; }
snapshots() { restic_tool snapshots --json | grep -o '"short_id"' | wc -l | tr -d ' '; }

# One destination: send two backups, check what is in the repository, damage the
# installation and restore it from there, and let verify-backup.sh look at the repository.
destination() {
	say "A repository: $1"
	./backup.sh "$work/$2" >/dev/null
	./backup.sh "$work/$2" >/dev/null
	check "two backups were sent as two snapshots" [ "$(snapshots)" = 2 ]
	check "the repository holds the backup and the settings, encrypted" \
		sh -c "./backup-tool.sh restic ls latest </dev/null | grep -q '/stage/database.dump' && ./backup-tool.sh restic ls latest </dev/null | grep -q '/secrets/kernic.env'"
	check "no copy of the settings was left next to the local backup" \
		sh -c "! find '$work/$2' -name 'kernic.env' | grep -q ."
	docker compose exec -T postgres psql -U kernic -d kernic -q -c "UPDATE projects SET name = 'damaged ' || name"
	docker compose run --rm --no-deps -T --entrypoint sh app -c 'rm -rf /data/projects/*/tree' >/dev/null
	./restore.sh --from-repo --yes >/dev/null
	check "restored from the repository: accounts, projects, migrations and every file are as before" same_as_before
	check "verify-backup.sh finds the snapshot sound" ./verify-backup.sh --from-repo --full
}

export KERNIC_BACKUP_REPOSITORY=/repo
destination "on another disk" disk
check "no password, no entry: a wrong password leaves the local backup and exits with status 3" \
	sh -c 'status=0; KERNIC_BACKUP_PASSWORD=wrong-password-0123456789 ./backup.sh "$1" >/dev/null 2>&1 || status=$?; [ "$status" = 3 ]' sh "$work/disk"
check "and the app runs" running app
check "the oldest local backups were removed (two are kept)" \
	sh -c "[ \"\$(ls -d '$work'/disk/????????-?????? | wc -l | tr -d ' ')\" = 2 ]"
check "a repository nobody has a password for cannot be fetched from" \
	sh -c "! KERNIC_BACKUP_PASSWORD=wrong-password-0123456789 ./restore.sh --from-repo --yes >/dev/null 2>&1"
check "and the failed attempt changed nothing" same_as_before

mkdir -p "$work/config/rclone"
printf '[local]\ntype = local\n' >"$work/config/rclone/rclone.conf"
export KERNIC_BACKUP_REPOSITORY=rclone:local:/repo/through-rclone
destination "through rclone" rclone

say "A repository: on an S3 server"
docker run -d --name "$s3_server" --network kernic_egress --tmpfs /data \
	--entrypoint sh "${KERNIC_BACKUP_IMAGE:-kernic-backup}" -c \
	'mkdir -p /data/kernic-backups && exec rclone serve s3 /data --addr :9000 --auth-key AKIAROUNDTRIP,roundtripsecret' >/dev/null
waited=0
until docker logs "$s3_server" 2>&1 | grep -q 'Starting s3 server'; do
	waited=$((waited + 1))
	[ "$waited" -lt 30 ] || die 1 "The S3 server for the test did not start."
	sleep 1
done
export KERNIC_BACKUP_REPOSITORY="s3:http://$s3_server:9000/kernic-backups/repo"
export KERNIC_BACKUP_S3_KEY_ID=AKIAROUNDTRIP KERNIC_BACKUP_S3_SECRET=roundtripsecret KERNIC_BACKUP_S3_REGION=us-east-1
destination "on an S3 server" s3

echo
if [ "$failures" -eq 0 ]; then
	echo "Sending backups to another place works: three kinds of destination, each restored from."
else
	echo "$failures check(s) failed." >&2
	exit 1
fi
