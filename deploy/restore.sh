#!/bin/sh
# Restores a backup made by backup.sh into this installation.
#
#   ./restore.sh <backup directory> [--yes]
#
# Everything currently in the database and the data volume is replaced.
set -eu
cd "$(dirname "$0")"

source_dir="${1:?usage: ./restore.sh <backup directory> [--yes]}"
test -s "$source_dir/database.dump" || { echo "No database.dump in $source_dir" >&2; exit 1; }
gzip -t "$source_dir/projects.tar.gz" || { echo "projects.tar.gz is missing or damaged" >&2; exit 1; }

if [ "${2:-}" != "--yes" ]; then
	printf 'This replaces ALL current Kernic data with the backup in %s.\nType "restore" to continue: ' "$source_dir"
	read -r answer
	[ "$answer" = "restore" ] || { echo "Cancelled."; exit 1; }
fi

docker compose up -d --wait postgres >/dev/null
echo "Stopping the app..."
docker compose stop app >/dev/null

echo "Restoring the database..."
docker compose exec -T postgres dropdb -U kernic --if-exists --force kernic
docker compose exec -T postgres createdb -U kernic kernic
docker compose exec -T postgres pg_restore -U kernic -d kernic --no-owner --exit-on-error \
	<"$source_dir/database.dump"
# Rendered pages and staged imports are not part of a backup; forget the records
# that point at them. Pages are rendered again when a project is opened.
docker compose exec -T postgres psql -U kernic -d kernic -q -c \
	"DELETE FROM compile_jobs; DELETE FROM project_imports WHERE status <> 'imported';"

echo "Restoring project files..."
docker compose run --rm --no-deps -T --entrypoint sh app -c \
	'rm -rf /data/projects /data/artifacts /data/imports && tar -xzf - -C /data' \
	<"$source_dir/projects.tar.gz"

echo "Starting Kernic..."
docker compose up -d --wait >/dev/null
echo "Restore complete."
