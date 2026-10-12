#!/bin/sh
# Checks that a backup can be restored, without restoring it.
#
#   ./verify-backup.sh [backup folder | --from-repo [snapshot]] [--full]
#
# With no argument: the newest dated folder in ./backups. The files are checked against the
# checksums in manifest.txt, the database dump is read through, the project archive is listed,
# and the database migrations in it are compared with those of the installed version.
#
# --from-repo does this for a snapshot of the repository (KERNIC_BACKUP_REPOSITORY) instead,
# and first lets restic read part of the repository itself (KERNIC_BACKUP_CHECK_SUBSET, by
# default a twentieth that changes every day, so that all of it is read in three weeks).
#
# --full also restores the database into a scratch database next to the real one and looks
# at what came out; the scratch database is dropped again. Nothing of the installation is
# changed. KERNIC_BACKUP_VERIFY_PING_URL is told how the run went, like backup.sh's ping.
#
# Exit status: 0 the backup can be restored, 1 it cannot, 2 wrong use.
set -eu
cd "$(dirname "$0")"
# shellcheck source=backup-lib.sh
. ./backup-lib.sh

folder=
from_repo=0
snapshot=latest
full=0
while [ $# -gt 0 ]; do
	case "$1" in
	-h | --help)
		sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'
		exit 0
		;;
	--from-repo)
		from_repo=1
		if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then
			snapshot="$2"
			shift
		fi
		;;
	--full) full=1 ;;
	-*) die 2 "Unknown option $1 (see ./verify-backup.sh --help)" ;;
	*) folder="$1" ;;
	esac
	shift
done
[ "$from_repo" = 0 ] || [ -z "$folder" ] || die 2 "Give a folder or --from-repo, not both."

umask 077
fetched=
scratch_database=
cleanup() {
	status=$?
	trap - EXIT INT TERM
	if [ -n "$scratch_database" ]; then
		docker compose exec -T postgres dropdb -U kernic --if-exists --force "$scratch_database" >/dev/null 2>&1 || true
	fi
	if [ -n "$fetched" ]; then rm -rf "$fetched"; fi
	if [ "$status" -eq 0 ]; then ping KERNIC_BACKUP_VERIFY_PING_URL ok; else ping KERNIC_BACKUP_VERIFY_PING_URL fail; fi
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
ping KERNIC_BACKUP_VERIFY_PING_URL start

running postgres || die 1 "The database is not running. Start Kernic first:  docker compose up -d"

if [ "$from_repo" = 1 ]; then
	[ -n "$(setting KERNIC_BACKUP_REPOSITORY)" ] || die 2 "KERNIC_BACKUP_REPOSITORY is not set in deploy/.env. See docs/backups.md."
	backup_folders
	backup_image
	subset="$(setting KERNIC_BACKUP_CHECK_SUBSET)"
	if [ -z "$subset" ]; then
		day="$(date +%j | sed 's/^0*//')"
		subset="$((day % 20 + 1))/20"
	fi
	say "Letting restic read $subset of the repository..."
	backup_run backup check --read-data-subset="$subset" || die 1 "The repository did not pass restic's check."
	mkdir -p backups
	fetched="$PWD/backups/.fetched-$(date +%Y%m%d-%H%M%S)"
	mkdir "$fetched"
	say "Fetching the snapshot $snapshot..."
	fetch_snapshot "$snapshot" "$fetched"
	folder="$fetched/stage"
elif [ -z "$folder" ]; then
	for dir in backups/????????-??????; do # oldest first
		if [ -f "$dir/database.dump" ]; then folder="$dir"; fi
	done
	[ -n "$folder" ] || die 1 "There is no backup in ./backups to check."
fi

say "Checking $folder"
[ -d "$folder" ] || die 1 "$folder is not a folder."
problems=0
bad() {
	say "  FAIL  $1"
	problems=$((problems + 1))
}
good() { say "  ok    $1"; }
manifest_value() { sed -n "s/^$1=//p" "$folder/manifest.txt" 2>/dev/null | head -n 1; }

if [ -s "$folder/database.dump" ]; then
	if docker compose exec -T postgres pg_restore -f /dev/null <"$folder/database.dump" 2>/dev/null; then
		good "the database dump can be read through"
	else
		bad "the database dump is damaged"
	fi
else
	bad "there is no database.dump"
fi

archive=
if [ -f "$folder/projects.tar" ]; then
	archive="$folder/projects.tar"
	if tar -tf "$archive" >/dev/null 2>&1; then good "the project archive can be listed"; else bad "projects.tar is damaged"; fi
elif [ -f "$folder/projects.tar.gz" ]; then
	archive="$folder/projects.tar.gz"
	if gzip -t "$archive" 2>/dev/null; then good "the project archive can be read (the older kind)"; else bad "projects.tar.gz is damaged"; fi
else
	bad "there is no projects.tar"
fi

if [ -f "$folder/manifest.txt" ]; then
	if [ -s "$folder/database.dump" ] &&
		[ "$(sha256sum "$folder/database.dump" | awk '{print $1}')" = "$(manifest_value database_dump_sha256)" ]; then
		good "the database dump matches its checksum"
	else
		bad "the database dump does not match its checksum"
	fi
	if [ -n "$archive" ] && [ "$(sha256sum "$archive" | awk '{print $1}')" = "$(manifest_value projects_tar_sha256)" ]; then
		good "the project archive matches its checksum"
	else
		bad "the project archive does not match its checksum"
	fi
	bundled="$(release_file migrations.txt || true)"
	unknown=
	if [ -n "$bundled" ]; then
		for name in $(manifest_value migrations | tr ',' ' '); do
			printf '%s\n' "$bundled" | grep -qx "$name" || unknown="$unknown $name"
		done
		if [ -z "$unknown" ]; then
			good "the installed version knows every database migration in the backup"
		else
			bad "the backup has migrations the installed version does not know:$unknown"
		fi
	fi
else
	say "  note  no manifest.txt: a backup of the older kind has nothing to check checksums against"
fi

if [ "$full" = 1 ] && [ -s "$folder/database.dump" ]; then
	scratch_database="kernic_verify"
	docker compose exec -T postgres dropdb -U kernic --if-exists --force "$scratch_database" >/dev/null 2>&1 || true
	docker compose exec -T postgres createdb -U kernic "$scratch_database"
	if docker compose exec -T postgres pg_restore -U kernic -d "$scratch_database" --no-owner --exit-on-error \
		<"$folder/database.dump" >/dev/null 2>&1; then
		restored="$(docker compose exec -T postgres psql -U kernic -d "$scratch_database" -tAq -c \
			"SELECT string_agg(name, chr(44) ORDER BY name) FROM schema_migrations" 2>/dev/null || true)"
		accounts="$(docker compose exec -T postgres psql -U kernic -d "$scratch_database" -tAq -c 'SELECT count(*) FROM users' 2>/dev/null || true)"
		projects="$(docker compose exec -T postgres psql -U kernic -d "$scratch_database" -tAq -c 'SELECT count(*) FROM projects' 2>/dev/null || true)"
		good "the database restores into a scratch database: $accounts accounts, $projects projects"
		if [ -f "$folder/manifest.txt" ] && [ "$restored" != "$(manifest_value migrations)" ]; then
			bad "the restored database has other migrations than the manifest says"
		fi
	else
		bad "the database does not restore into a scratch database"
	fi
fi

if [ "$problems" -gt 0 ]; then
	die 1 "$problems problem(s): this backup cannot be relied on."
fi
say "This backup can be restored."
