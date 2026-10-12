# What backup.sh and restore.sh have in common. Sourced by them, not run.
# Needs: set -eu, and the current directory to be deploy/.

say() { printf '%s\n' "$*"; }

# die <exit code> <message>: the message goes to stderr.
die() {
	code="$1"
	shift
	printf '%s\n' "$*" >&2
	exit "$code"
}

# Reads KEY=value from .env without running it as a script.
value() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1 | sed "s/^['\"]//; s/['\"]$//"; }

# A setting as Docker Compose sees it: the environment first, then .env.
setting() {
	current="$(printenv "$1" 2>/dev/null || true)"
	if [ -n "$current" ]; then printf '%s\n' "$current"; else value "$1"; fi
}

# Whether a service of the stack is running.
running() { docker compose ps --status running --services 2>/dev/null | grep -qx "$1"; }

# Runs one SQL statement in the database and prints the bare result.
sql() { docker compose exec -T postgres psql -U kernic -d kernic -tAq -c "$1"; }

# Prints a file the app image carries about itself (version.txt, migrations.txt). Images
# from before 0.2 do not have them: this fails, and the callers go on without.
release_file() {
	docker compose run --rm --no-deps -T --entrypoint cat app "/app/release/$1" 2>/dev/null
}

# Only one backup or restore runs at a time. The lock is a directory that holds the pid of
# its owner; the lock of a process that is gone is taken over. restore.sh holds the lock
# while it runs backup.sh for its safety copy, and says so with KERNIC_LOCK_HELD=1.
lock_dir="$PWD/.backup.lock"
lock_taken=0

take_lock() {
	if [ "${KERNIC_LOCK_HELD:-}" = 1 ]; then return 0; fi
	if ! mkdir "$lock_dir" 2>/dev/null; then
		holder="$(cat "$lock_dir/pid" 2>/dev/null || true)"
		if [ -z "$holder" ]; then
			# The owner may be just now writing its pid.
			sleep 1
			holder="$(cat "$lock_dir/pid" 2>/dev/null || true)"
		fi
		if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
			die 4 "Another backup or restore is running (process $holder). Try again when it has finished."
		fi
		rm -rf "$lock_dir"
		mkdir "$lock_dir" 2>/dev/null || die 4 "Could not take the lock $lock_dir."
	fi
	echo "$$" >"$lock_dir/pid"
	lock_taken=1
}

release_lock() {
	if [ "$lock_taken" = 1 ]; then rm -rf "$lock_dir"; fi
	lock_taken=0
}
