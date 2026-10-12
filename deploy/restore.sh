#!/bin/sh
# Restores a backup made by backup.sh into this installation.
#
#   ./restore.sh <backup directory> [--yes] [--no-safety-backup]
#
# Everything currently in the database and the data volume is replaced. First a backup of
# what is there now is made (labelled "pre-restore", in ./backups), so that a restore that
# turns out to be a mistake can be undone with this same script. --no-safety-backup skips
# that. A relative directory is relative to deploy/.
#
# Backups of the older kind (projects.tar.gz, no manifest.txt) can be restored too.
# A restore can be repeated: if it stops halfway, run it again.
#
# Exit status: 0 done, 1 failed or cancelled, 2 wrong use, 4 another backup or restore is running.
set -eu
cd "$(dirname "$0")"
# shellcheck source=backup-lib.sh
. ./backup-lib.sh

source_dir=
confirmed=0
safety=1
while [ $# -gt 0 ]; do
	case "$1" in
	-h | --help)
		sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'
		exit 0
		;;
	--yes) confirmed=1 ;;
	--no-safety-backup) safety=0 ;;
	-*) die 2 "Unknown option $1 (see ./restore.sh --help)" ;;
	*) source_dir="$1" ;;
	esac
	shift
done
[ -n "$source_dir" ] || die 2 "usage: ./restore.sh <backup directory> [--yes] [--no-safety-backup]"

[ -d "$source_dir" ] || die 1 "$source_dir is not a folder."
test -s "$source_dir/database.dump" || die 1 "No database.dump in $source_dir"
if [ -f "$source_dir/projects.tar" ]; then
	files_kind=tar
	tar -tf "$source_dir/projects.tar" >/dev/null 2>&1 || die 1 "projects.tar is damaged."
elif [ -f "$source_dir/projects.tar.gz" ]; then
	files_kind=tgz
	gzip -t "$source_dir/projects.tar.gz" 2>/dev/null || die 1 "projects.tar.gz is damaged."
else
	die 1 "No projects.tar (or projects.tar.gz of the older kind) in $source_dir"
fi

# A backup that has a manifest can be checked against it, and against this installation.
manifest_value() { sed -n "s/^$1=//p" "$source_dir/manifest.txt" 2>/dev/null | head -n 1; }
if [ -f "$source_dir/manifest.txt" ]; then
	[ "$(sha256sum "$source_dir/database.dump" | awk '{print $1}')" = "$(manifest_value database_dump_sha256)" ] ||
		die 1 "database.dump does not match its checksum in manifest.txt: the backup is damaged."
	tarfile="$source_dir/projects.tar"
	[ "$files_kind" = tar ] || tarfile="$source_dir/projects.tar.gz"
	[ "$(sha256sum "$tarfile" | awk '{print $1}')" = "$(manifest_value projects_tar_sha256)" ] ||
		die 1 "The project files do not match their checksum in manifest.txt: the backup is damaged."
	bundled="$(release_file migrations.txt || true)"
	if [ -n "$bundled" ]; then
		for name in $(manifest_value migrations | tr ',' ' '); do
			printf '%s\n' "$bundled" | grep -qx "$name" ||
				die 1 "This backup was made by a newer Kernic: its database has the migration $name, which the installed version does not know. Install version $(manifest_value kernic_version) or a newer one first."
		done
	fi
fi

if [ "$confirmed" != 1 ]; then
	printf 'This replaces ALL current Kernic data with the backup in %s.\nType "restore" to continue: ' "$source_dir"
	answer=
	read -r answer || true
	[ "$answer" = restore ] || die 1 "Cancelled."
fi

take_lock
phase=preparing
safety_dir=

finish() {
	status=$?
	trap - EXIT INT TERM
	if [ "$status" -ne 0 ] && [ "$phase" != preparing ]; then
		{
			printf '\nThe restore did not finish. The database and the files may be only partly replaced, and the app may be stopped.\n'
			printf 'Run the same command again: a restore can be repeated.\n'
			if [ -n "$safety_dir" ]; then
				printf 'What was there before is saved in %s; to go back to it:  ./restore.sh %s\n' "$safety_dir" "$safety_dir"
			fi
		} >&2
	fi
	release_lock
	exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose up -d --wait postgres >/dev/null

# What is there now is saved first, unless there is nothing there (a new machine).
if [ "$safety" = 1 ] && [ -n "$(sql "SELECT to_regclass('schema_migrations')" 2>/dev/null || true)" ]; then
	say "Saving what is there now first..."
	KERNIC_LOCK_HELD=1 ./backup.sh backups --label pre-restore ||
		die 1 "The safety copy could not be made, so nothing was changed. Fix that, or use --no-safety-backup."
	for dir in backups/*-pre-restore; do # oldest first, so the last one is the one just made
		if [ -d "$dir" ]; then safety_dir="$dir"; fi
	done
fi

phase=replacing
say "Stopping the app..."
docker compose stop app >/dev/null 2>&1 || true

say "Restoring the database..."
docker compose exec -T postgres dropdb -U kernic --if-exists --force kernic
docker compose exec -T postgres createdb -U kernic kernic
docker compose exec -T postgres pg_restore -U kernic -d kernic --no-owner --exit-on-error \
	<"$source_dir/database.dump"
# Rendered pages and staged imports are not part of a backup; forget the records
# that point at them. Pages are rendered again when a project is opened.
docker compose exec -T postgres psql -U kernic -d kernic -q -c \
	"DELETE FROM compile_jobs; DELETE FROM project_imports WHERE status <> 'imported';"

say "Restoring the project files..."
if [ "$files_kind" = tar ]; then
	docker compose run --rm --no-deps -T --entrypoint sh app -c \
		'rm -rf /data/projects /data/artifacts /data/imports && tar -xf - -C /data' \
		<"$source_dir/projects.tar"
else
	docker compose run --rm --no-deps -T --entrypoint sh app -c \
		'rm -rf /data/projects /data/artifacts /data/imports && tar -xzf - -C /data' \
		<"$source_dir/projects.tar.gz"
fi

phase=starting
say "Starting Kernic..."
docker compose up -d --wait >/dev/null
say "Restore complete: $(sql 'SELECT count(*) FROM users') accounts and $(sql 'SELECT count(*) FROM projects') projects."
