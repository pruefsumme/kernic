#!/bin/sh
# Backs up a Kernic installation: the database and all project files.
#
#   ./backup.sh [directory] [--label NAME] [--local-only]      default directory: ./backups
#
# Each run makes a dated folder in the directory (a relative one is relative to deploy/):
#   database.dump   the database (PostgreSQL custom format)
#   projects.tar    the project files with their whole version history
#   manifest.txt    what made it: version, database migrations, checksums, size
#
# The app is stopped while the two are copied, so that they are of the same moment; it is
# started again whatever happens (usually under a minute). The folder is only given its
# name once it is complete and has been checked, and the oldest dated folders are removed
# beyond KERNIC_BACKUP_KEEP_LOCAL (default 7, 0 keeps all). --label adds a name to the
# folder, such as "pre-upgrade"; labelled folders are never removed by this.
#
# With KERNIC_BACKUP_REPOSITORY set (docs/backups.md), the folder is then sent, encrypted, to that
# repository (backup-upload.sh) while the app is running again; --local-only skips that.
# KERNIC_BACKUP_PING_URL gets a message when a run starts and when it ends, for a monitor
# that raises the alarm when the end does not come.
#
# Not in the backup: deploy/.env. It holds KERNIC_SECRET_KEY, without which the Git access
# tokens in the database cannot be read; keep a copy of it somewhere else.
#
# Exit status: 0 done, 1 failed, 2 wrong use, 3 the backup was made but not sent, 4 another
# backup or restore is running.
set -eu
cd "$(dirname "$0")"
# shellcheck source=backup-lib.sh
. ./backup-lib.sh

base=backups
label=
local_only=0
while [ $# -gt 0 ]; do
	case "$1" in
	-h | --help)
		sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'
		exit 0
		;;
	--label)
		[ $# -ge 2 ] || die 2 "--label needs a name"
		label="$2"
		shift
		;;
	--local-only) local_only=1 ;;
	-*) die 2 "Unknown option $1 (see ./backup.sh --help)" ;;
	*) base="$1" ;;
	esac
	shift
done
case "$label" in
*[!A-Za-z0-9._-]*) die 2 "A label may only have letters, digits, dots, hyphens and underscores" ;;
esac

umask 077
take_lock
# A backup that restore.sh or upgrade.sh makes on the way is not a run to report on.
reporting=0
if [ "${KERNIC_LOCK_HELD:-}" != 1 ]; then reporting=1; fi
if [ "$reporting" = 1 ]; then ping KERNIC_BACKUP_PING_URL start; fi

stamp="$(date +%Y%m%d-%H%M%S)"
final="$base/$stamp${label:+-$label}"
partial="$base/.partial-$stamp"
stopped=0

start_app() {
	docker compose up -d --wait --no-recreate --no-deps app >/dev/null 2>&1 && return 0
	sleep 3
	docker compose up -d --wait --no-recreate --no-deps app >/dev/null
}

# Whatever happens: the app is started again, an unfinished copy is removed, the lock is let go.
finish() {
	status=$?
	trap - EXIT INT TERM
	if [ "$stopped" = 1 ] && ! start_app; then
		status=1
		printf '\nTHE APP IS STOPPED and could not be started again.\nRun this in %s:  docker compose up -d --wait\n' "$PWD" >&2
	fi
	if [ "$status" -ne 0 ]; then rm -rf "$partial"; fi
	if [ "$reporting" = 1 ]; then
		if [ "$status" -eq 0 ]; then ping KERNIC_BACKUP_PING_URL ok; else ping KERNIC_BACKUP_PING_URL fail; fi
	fi
	release_lock
	exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$base"
rm -rf "$base"/.partial-* # what a run that was killed left behind; the lock is ours
[ ! -e "$final" ] || die 1 "$final exists already."
running postgres || die 1 "The database is not running. Start Kernic first:  docker compose up -d"

say "Looking at what is installed..."
version="$(release_file version.txt | tr -d '\r\n' || true)"
migrations="$(sql 'SELECT name FROM schema_migrations ORDER BY name' 2>/dev/null | tr '\n' ',' | sed 's/,$//' || true)"
database_version="$(sql 'SHOW server_version' 2>/dev/null || true)"
app_container="$(docker compose ps -aq app 2>/dev/null | head -n 1)"
app_image=
app_image_id=
if [ -n "$app_container" ]; then
	app_image="$(docker inspect --format '{{.Config.Image}}' "$app_container")"
	app_image_id="$(docker inspect --format '{{.Image}}' "$app_container")"
fi

# Do not fill the disk while the app is stopped: the copy is about as large as the files.
need_kb="$(docker compose run --rm --no-deps -T --entrypoint du app -sk /data/projects 2>/dev/null | awk '{print $1}' || true)"
free_kb="$(df -Pk "$base" | awk 'NR==2 {print $4}')"
if [ "$free_kb" -lt $((${need_kb:-0} * 3 / 2 + 51200)) ]; then
	die 1 "Not enough room in $base: $((free_kb / 1024)) MB free, and the project files are $((${need_kb:-0} / 1024)) MB."
fi

mkdir "$partial"
if running app; then
	say "Stopping the app..."
	stopped=1
	docker compose stop app >/dev/null
fi

say "Saving the database..."
docker compose exec -T postgres pg_dump -U kernic -d kernic --format=custom >"$partial/database.dump"

# Rendered pages, staged imports and downloaded packages are left out: all three are made
# again when they are needed.
say "Saving the project files..."
docker compose run --rm --no-deps -T --entrypoint tar app -cf - -C /data projects >"$partial/projects.tar"

if [ "$stopped" = 1 ]; then
	say "Starting the app..."
	start_app
	stopped=0
fi

# Fail loudly rather than leave a backup that cannot be restored.
say "Checking the copy..."
test -s "$partial/database.dump"
docker compose exec -T postgres pg_restore -f /dev/null <"$partial/database.dump"
tar -tf "$partial/projects.tar" >/dev/null

{
	echo "format=2"
	echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	echo "label=$label"
	echo "kernic_version=${version:-unknown}"
	echo "app_image=$app_image"
	echo "app_image_id=$app_image_id"
	echo "database_version=$database_version"
	echo "migrations=$migrations"
	echo "database_dump_sha256=$(sha256sum "$partial/database.dump" | awk '{print $1}')"
	echo "projects_tar_sha256=$(sha256sum "$partial/projects.tar" | awk '{print $1}')"
	echo "projects_bytes=$(wc -c <"$partial/projects.tar" | tr -d ' ')"
	echo "host=$(uname -n)"
} >"$partial/manifest.txt"
mv "$partial" "$final"
say "Backup written to $final"

# Keep the newest dated folders. Only folders that are named like ours and hold a backup are touched.
keep="$(setting KERNIC_BACKUP_KEEP_LOCAL)"
keep="${keep:-7}"
case "$keep" in
*[!0-9]*)
	say "KERNIC_BACKUP_KEEP_LOCAL is not a number; keeping all backups this time."
	keep=0
	;;
esac
if [ "$keep" -gt 0 ]; then
	set --
	for dir in "$base"/????????-??????; do # oldest first
		if [ -f "$dir/manifest.txt" ] || [ -f "$dir/database.dump" ]; then set -- "$@" "$dir"; fi
	done
	excess=$(($# - keep))
	while [ "$excess" -gt 0 ]; do
		rm -rf "${1:?}"
		say "Removed the old backup $1"
		shift
		excess=$((excess - 1))
	done
fi

if [ "$local_only" != 1 ] && [ -n "$(setting KERNIC_BACKUP_REPOSITORY)" ]; then
	say "Sending it to the repository..."
	if ! ./backup-upload.sh "$final"; then
		die 3 "The backup was made ($final) but not sent. Send it again with:  ./backup-upload.sh $final"
	fi
elif [ -n "$(setting KERNIC_SECRET_KEY)" ]; then
	say "Remember: KERNIC_SECRET_KEY in deploy/.env is not part of this backup. Keep it somewhere else too."
fi
