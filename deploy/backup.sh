#!/bin/sh
# Backs up a Kernic installation: the database and all project files.
#
#   ./backup.sh [directory]      default directory: ./backups
#
# The app is stopped for the duration (usually a few seconds) so that the
# database and the files are captured at the same moment, then started again.
set -eu
cd "$(dirname "$0")"

target="${1:-backups}/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$target"

echo "Stopping the app..."
docker compose stop app >/dev/null
trap 'echo "Starting the app..."; docker compose up -d --wait app >/dev/null 2>&1' EXIT

echo "Saving the database..."
docker compose exec -T postgres pg_dump -U kernic -d kernic --format=custom >"$target/database.dump"

# Rendered pages and staged imports are left out: both are recreated on demand.
echo "Saving project files..."
docker compose run --rm --no-deps -T --entrypoint tar app -czf - -C /data projects \
	>"$target/projects.tar.gz"

# Fail loudly rather than leave a backup that cannot be restored.
test -s "$target/database.dump"
gzip -t "$target/projects.tar.gz"

echo "Backup written to $target"
