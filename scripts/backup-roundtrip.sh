#!/bin/sh
# Tries backup and restore on a running Kernic from deploy/, end to end:
#
#   scripts/backup-roundtrip.sh --replace-everything
#
# It backs the installation up, damages it, restores it, and checks that accounts, projects,
# the database migrations and every project file are back as they were. It also restores a
# backup of the older kind, and checks that a second backup is refused while one runs and
# that a backup that is killed starts the app again.
#
# THE RESTORES REPLACE EVERYTHING in that installation, so the flag says so. For the
# pipeline (after the browser tests, so that there is data) and for a test installation;
# never for one that holds work.
set -eu
[ "${1:-}" = --replace-everything ] || {
	echo "usage: scripts/backup-roundtrip.sh --replace-everything   (replaces all data of the installation in deploy/)" >&2
	exit 2
}
cd "$(dirname "$0")/../deploy"
# shellcheck source=../deploy/backup-lib.sh
. ./backup-lib.sh

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
failures=0
check() {
	# check <what> <command...>
	what="$1"
	shift
	if "$@"; then say "  ok    $what"; else say "  FAIL  $what"; failures=$((failures + 1)); fi
}

port="$(setting KERNIC_HTTP_PORT)"
url="http://localhost:${port:-80}"
files_hash='cd /data && find projects -type f | LC_ALL=C sort | xargs sha256sum | sha256sum'

# With no data in the installation there is nothing to prove anything with: make an account
# and a project, the way a person would (this is for a fresh test installation).
seed() {
	jar="$work/cookies"
	post() { # post <path> <fields...>
		path="$1"
		shift
		curl -sS -b "$jar" -c "$jar" -o /dev/null -D "$work/headers" -H "origin: $url" \
			-H 'x-forwarded-proto: http' -H 'accept: text/html' "$@" "$url$path"
	}
	post /setup --data-urlencode "setupToken=$(setting KERNIC_SETUP_TOKEN)" \
		--data-urlencode 'displayName=Round Trip' --data-urlencode 'email=roundtrip@example.org' \
		--data-urlencode 'password=round trip passphrase'
	workspace="$(curl -fsS -b "$jar" "$url/" | sed -n 's/.*name="workspace" value="\([^"]*\)".*/\1/p' | head -n 1)"
	[ -n "$workspace" ] || die 1 "Could not set up a test account at $url."
	post '/?/create' --data-urlencode 'name=Round trip' --data-urlencode 'template=report' \
		--data-urlencode "workspace=$workspace"
	project="$(sed -n 's/^[Ll]ocation: .*\/\([^/[:space:]]*\)[[:space:]]*$/\1/p' "$work/headers" | head -n 1)"
	[ -n "$project" ] || die 1 "Could not make a test project."
	post "/api/projects/$project/files/notes.typ" -X PUT -H 'content-type: text/plain' \
		-H 'x-kernic-base-hash: none' --data-binary 'Written before the backup.'
}

# What must come back: counts, the migrations, and a hash over every file of every project.
# The app is stopped meanwhile, so that nothing is being written.
state() {
	docker compose stop app >/dev/null
	printf 'accounts=%s\nprojects=%s\nmigrations=%s\nfiles=%s\n' \
		"$(sql 'SELECT count(*) FROM users')" "$(sql 'SELECT count(*) FROM projects')" \
		"$(sql 'SELECT string_agg(name, chr(44) ORDER BY name) FROM schema_migrations')" \
		"$(docker compose run --rm --no-deps -T --entrypoint sh app -c "$files_hash")"
	docker compose up -d --wait --no-recreate --no-deps app >/dev/null
}

same_as_before() { [ "$(state)" = "$before" ]; }
healthy() { curl -fsS "$url/healthz" >/dev/null; }

if [ "$(sql 'SELECT count(*) FROM projects')" = 0 ]; then
	[ "$(sql 'SELECT count(*) FROM users')" = 0 ] ||
		die 1 "There are accounts but no project: make a project first, or start from an empty installation."
	say "Making a test account and project..."
	seed
fi

say "Taking a backup..."
before="$(state)"
printf '%s\n' "$before" | sed 's/^/  /'
started="$(date +%s)"
./backup.sh "$work/backups"
say "  (the app was stopped and started again within $(($(date +%s) - started)) seconds, checks included)"
for dir in "$work"/backups/*/; do
	backup="${dir%/}"
done

say "The backup:"
manifest_migrations="$(sed -n 's/^migrations=//p' "$backup/manifest.txt")"
database_migrations="$(sql 'SELECT string_agg(name, chr(44) ORDER BY name) FROM schema_migrations')"
dump_mode="$(stat -c %a "$backup/database.dump")"
folder_mode="$(stat -c %a "$backup")"
check "database.dump, projects.tar and manifest.txt are there" \
	sh -c "test -s '$backup/database.dump' && test -s '$backup/projects.tar' && test -s '$backup/manifest.txt'"
check "the folder and the files in it are private to their owner" [ "$folder_mode $dump_mode" = "700 600" ]
check "the manifest names the migrations the database has" [ "$manifest_migrations" = "$database_migrations" ]

say "Damaging the installation, then restoring it (a safety copy is taken first)..."
sql "UPDATE projects SET name = 'damaged ' || name"
docker compose run --rm --no-deps -T --entrypoint sh app -c 'rm -rf /data/projects/*/tree' >/dev/null
./restore.sh "$backup" --yes
check "the safety copy of the damaged state was made" sh -c "ls -1 backups | grep -q -- '-pre-restore\$'"
check "accounts, projects, migrations and every file are as before" same_as_before
check "the app answers" healthy

say "Wiping everything, then restoring onto the empty installation..."
docker compose stop app >/dev/null
docker compose exec -T postgres psql -U kernic -d kernic -q -c 'SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;'
docker compose run --rm --no-deps -T --entrypoint sh app -c 'rm -rf /data/projects /data/artifacts /data/imports' >/dev/null
./restore.sh "$backup" --yes
check "accounts, projects, migrations and every file are as before" same_as_before
check "the app answers" healthy

say "Restoring a backup of the older kind (projects.tar.gz, no manifest)..."
mkdir "$work/old"
cp "$backup/database.dump" "$work/old/"
gzip -c "$backup/projects.tar" >"$work/old/projects.tar.gz"
sql "UPDATE projects SET name = 'damaged ' || name"
./restore.sh "$work/old" --yes --no-safety-backup
check "accounts, projects, migrations and every file are as before" same_as_before

say "Keeping only the newest backups..."
KERNIC_BACKUP_KEEP_LOCAL=1 ./backup.sh "$work/kept" >/dev/null
KERNIC_BACKUP_KEEP_LOCAL=1 ./backup.sh "$work/kept" --label to-keep >/dev/null
sleep 1 # folders are named by the second
KERNIC_BACKUP_KEEP_LOCAL=1 ./backup.sh "$work/kept" >/dev/null
dated=0
for dir in "$work"/kept/????????-??????; do
	if [ -d "$dir" ]; then dated=$((dated + 1)); fi
done
labelled=0
for dir in "$work"/kept/*-to-keep; do
	if [ -d "$dir" ]; then labelled=$((labelled + 1)); fi
done
check "of three backups, one dated and the labelled one are left" [ "$dated $labelled" = "1 1" ]

say "Two at once, and a backup that is killed..."
mkdir .backup.lock
echo "$$" >.backup.lock/pid
status=0
./backup.sh "$work/refused" >/dev/null 2>&1 || status=$?
rm -rf .backup.lock
check "a backup is refused while another one holds the lock (exit status 4)" [ "$status" = 4 ]

real_docker="$(command -v docker)"
mkdir "$work/stub"
cat >"$work/stub/docker" <<EOF
#!/bin/sh
# The real docker, except that the database dump takes a few seconds.
case "\$*" in *pg_dump*) sleep 8 ;; esac
exec "$real_docker" "\$@"
EOF
chmod +x "$work/stub/docker"
PATH="$work/stub:$PATH" ./backup.sh "$work/killed" >/dev/null 2>&1 &
backup_pid=$!
waited=0
while running app && [ "$waited" -lt 60 ]; do
	sleep 1
	waited=$((waited + 1))
done
kill -TERM "$backup_pid"
status=0
wait "$backup_pid" || status=$?
check "a backup that is killed ends with status 143" [ "$status" = 143 ]
check "and the app is running again" running app
check "and no unfinished copy is left" sh -c "! ls -a '$work/killed' | grep -q '^.partial-'"
check "and the lock is let go" sh -c "! test -e .backup.lock"
check "and the app answers" healthy

echo
if [ "$failures" -eq 0 ]; then
	echo "Backup and restore work: everything came back as it was."
else
	echo "$failures check(s) failed." >&2
	exit 1
fi
