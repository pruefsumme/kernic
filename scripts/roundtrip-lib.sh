# shellcheck shell=sh disable=SC2154,SC2034 # variables set by the scripts that source this
# What the round-trip scripts share. Sourced by them, from deploy/.
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


# There must be something in the installation to back up.
ensure_data() {
	if [ "$(sql 'SELECT count(*) FROM projects')" = 0 ]; then
		[ "$(sql 'SELECT count(*) FROM users')" = 0 ] ||
			die 1 "There are accounts but no project: make a project first, or start from an empty installation."
		say "Making a test account and project..."
		seed
	fi
}
