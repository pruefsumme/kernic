#!/bin/sh
# Upgrades this installation to the version of the files in this folder.
#
#   ./upgrade.sh [--yes] [--skip-backup] [--allow-offsite-failure]
#
# First get the new version: git fetch --tags && git checkout v<version> (or git pull),
# and, if you run published images, put the new version into KERNIC_APP_IMAGE and
# KERNIC_WORKER_IMAGE in .env. Then this script, in this order, stopping where something is wrong:
#
#   1. checks the machine and .env (preflight.sh), the Compose file, and warns about settings
#      that are new and edits to compose.yaml or Caddyfile that the checkout would lose;
#   2. builds or pulls the new app and worker images. Nothing is stopped yet;
#   3. shows what changes: the version, the database migrations that will be applied, and the
#      upgrade notes of CHANGELOG.md; refuses to go back to an older version or to run on
#      a database that is newer than the files; asks;
#   4. makes a backup labelled "pre-upgrade" (and sends it off the machine, if that is set up);
#   5. starts the new version and waits until it is healthy;
#   6. if that does not work, says how to go back to what you had.
#
# The proxy and database images are not touched: they only change when you pull them yourself,
# as a step of its own. --yes skips the question. --skip-backup is for when you have just made
# one. --allow-offsite-failure goes on when the backup could not be sent off the machine.
#
# Exit status: 0 done, 1 stopped or failed, 2 wrong use, 4 a backup or restore is running.
set -eu
cd "$(dirname "$0")"
# shellcheck source=backup-lib.sh
. ./backup-lib.sh

confirmed=0
skip_backup=0
allow_offsite_failure=0
while [ $# -gt 0 ]; do
	case "$1" in
	-h | --help)
		sed -n '2,/^set -eu/p' "$0" | sed '$d; s/^# \{0,1\}//'
		exit 0
		;;
	--yes) confirmed=1 ;;
	--skip-backup) skip_backup=1 ;;
	--allow-offsite-failure) allow_offsite_failure=1 ;;
	*) die 2 "Unknown option $1 (see ./upgrade.sh --help)" ;;
	esac
	shift
done

warn() { printf '  WARN  %s\n' "$1"; }
umask 077
work="$(mktemp -d)"
take_lock
phase=checking
backup_dir=
old_app_image=
old_worker_image=
old_version=
count_before=

finish() {
	status=$?
	trap - EXIT INT TERM
	if [ "$status" -ne 0 ] && [ "$phase" = upgrading ]; then
		count_now="$(sql 'SELECT count(*) FROM schema_migrations' 2>/dev/null || true)"
		{
			printf '\nThe upgrade did not finish. To go back to what you had (%s, images %s and %s):\n\n' \
				"${old_version:-a version that does not say}" "${old_app_image:-?}" "${old_worker_image:-?}"
			printf '  1. Put the old files back: git checkout <the old version tag> in %s,\n' "$(cd .. && pwd)"
			printf '     and with published images the old tags into KERNIC_APP_IMAGE and KERNIC_WORKER_IMAGE in .env.\n'
			if [ -n "$count_now" ] && [ "$count_now" = "$count_before" ]; then
				printf '  2. No database migration was applied, so nothing is lost: docker compose up -d --wait\n'
			else
				printf '  2. The new version may have changed the database, which an older version refuses to use:\n'
				if [ -n "$backup_dir" ]; then
					printf '     ./restore.sh %s\n' "$backup_dir"
				else
					printf '     restore a backup made before the upgrade: ./restore.sh <folder>\n'
				fi
			fi
			printf '\nWhat went wrong: docker compose logs app\n'
		} >&2
	fi
	rm -rf "$work"
	release_lock
	exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

running postgres || die 1 "Kernic is not running, so there is nothing to upgrade. Start it:  docker compose up -d"

say "Checking..."
if ! ./preflight.sh >"$work/preflight" 2>&1; then
	cat "$work/preflight" >&2
	die 1 "preflight.sh found something to fix first."
fi
# The ports are in use by Kernic itself.
grep -E 'WARN' "$work/preflight" | grep -v 'already in use' | sed 's/^/ /' || true
docker compose config -q || die 1 "The Compose file does not work with this .env; see above."
if [ -f .env ] && [ -f .env.example ]; then
	new_settings=
	for key in $(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' .env.example); do
		grep -q "^$key=" .env || new_settings="$new_settings $key"
	done
	if [ -n "$new_settings" ]; then
		warn "not in your .env, so their defaults apply (see .env.example):$new_settings"
	fi
fi
if command -v git >/dev/null 2>&1 && [ -n "$(git status --porcelain -- compose.yaml Caddyfile 2>/dev/null || true)" ]; then
	warn "compose.yaml or Caddyfile has changes of yours. Keep such changes in compose.override.yaml, which Compose reads next to it and a new version never replaces."
fi

# What is running now.
app_container="$(docker compose ps -aq app | head -n 1)"
worker_container="$(docker compose ps -aq worker | head -n 1)"
[ -z "$app_container" ] || old_app_image="$(docker inspect --format '{{.Config.Image}}' "$app_container")"
[ -z "$worker_container" ] || old_worker_image="$(docker inspect --format '{{.Config.Image}}' "$worker_container")"
if running app; then
	old_version="$(docker compose exec -T app cat /app/release/version.txt 2>/dev/null | tr -d '\r\n' || true)"
fi
sql 'SELECT name FROM schema_migrations ORDER BY name' >"$work/applied"
count_before="$(sql 'SELECT count(*) FROM schema_migrations')"

if [ -n "$(setting KERNIC_APP_IMAGE)" ] || [ -n "$(setting KERNIC_WORKER_IMAGE)" ]; then
	app_tag="$(setting KERNIC_APP_IMAGE)"
	worker_tag="$(setting KERNIC_WORKER_IMAGE)"
	if [ -z "$app_tag" ] || [ -z "$worker_tag" ]; then
		die 1 "Set both KERNIC_APP_IMAGE and KERNIC_WORKER_IMAGE (the same version), or neither."
	fi
	if [ "${app_tag##*:}" != "${worker_tag##*:}" ]; then
		warn "the app and the worker are not of the same version: ${app_tag##*:} and ${worker_tag##*:}"
	fi
	case "${app_tag##*:}" in
	latest) warn "KERNIC_APP_IMAGE says :latest. Name the version (for example :0.2.0) so that you know what runs and can go back to it." ;;
	esac
	say "Pulling the new images..."
	docker compose pull app worker
else
	say "Building the new images (this can take a few minutes)..."
	docker compose build app worker
fi

new_version="$(release_file version.txt | tr -d '\r\n' || true)"
release_file migrations.txt >"$work/bundled" || : >"$work/bundled"

say
say "Installed: ${old_version:-unknown (an image from before 0.2 does not say)} ${old_app_image:+($old_app_image)}"
say "New:       ${new_version:-unknown}"
if [ -n "$old_version" ] && [ -n "$new_version" ] && [ "$old_version" != "$new_version" ]; then
	lowest="$(printf '%s\n%s\n' "$old_version" "$new_version" | sort -V | head -n 1)"
	[ "$lowest" = "$old_version" ] || die 1 "That would go back from $old_version to $new_version. Kernic's database only moves forward: to go back, restore a backup made before (see docs/self-hosting.md)."
fi
if [ -s "$work/bundled" ]; then
	unknown="$(comm -23 "$work/applied" "$work/bundled" | tr '\n' ' ')"
	[ -z "$unknown" ] || die 1 "The database has migrations that the new version does not know: $unknown. It was migrated by a newer version than the files here."
	to_apply="$(comm -13 "$work/applied" "$work/bundled" | tr '\n' ' ')"
	say "Database migrations to apply: ${to_apply:-none}"
else
	say "Database migrations to apply: unknown (the new image does not list its migrations)"
fi
if [ -n "$new_version" ] && notes="$(../scripts/changelog-section.sh "$new_version" --upgrade-notes ../CHANGELOG.md 2>/dev/null)"; then
	say
	say "Upgrade notes for $new_version:"
	printf '%s\n' "$notes" | sed 's/^/  /'
elif [ -n "$new_version" ]; then
	say "(CHANGELOG.md has no upgrade notes for $new_version.)"
fi
say

if [ "$confirmed" != 1 ]; then
	printf 'Kernic will be stopped for a minute or two. Type "upgrade" to continue: '
	answer=
	read -r answer || true
	[ "$answer" = upgrade ] || die 1 "Cancelled. Nothing was changed except the images that were built or pulled."
fi

if [ "$skip_backup" = 1 ]; then
	warn "no backup is made, as you asked"
else
	say "Making a backup first..."
	backup_status=0
	KERNIC_LOCK_HELD=1 ./backup.sh backups --label pre-upgrade || backup_status=$?
	for dir in backups/*-pre-upgrade; do # oldest first, so the last one is the one just made
		if [ -d "$dir" ]; then backup_dir="$dir"; fi
	done
	case "$backup_status" in
	0) ;;
	3)
		[ "$allow_offsite_failure" = 1 ] ||
			die 1 "The backup was made ($backup_dir) but could not be sent off the machine. Nothing was upgraded. Fix that, or go on anyway with --allow-offsite-failure."
		warn "the backup was not sent off the machine; going on, as you asked"
		;;
	*) die 1 "The backup failed, so nothing was upgraded." ;;
	esac
fi

phase=upgrading
say "Starting the new version..."
docker compose up -d --wait --wait-timeout 300
now_version="$(docker compose exec -T app cat /app/release/version.txt 2>/dev/null | tr -d '\r\n' || true)"
sql 'SELECT name FROM schema_migrations ORDER BY name' >"$work/applied_after"
applied="$(comm -13 "$work/applied" "$work/applied_after" | tr '\n' ' ')"
phase=finished
say
say "Kernic ${now_version:+$now_version }is running. Migrations applied: ${applied:-none}."
say "Look at it: sign in, open a project, see the preview. If something is wrong, docker compose logs app."
if [ -n "$backup_dir" ]; then say "The backup from before is in $backup_dir (./restore.sh $backup_dir goes back to it)."; fi
