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

# --- Sending backups to another place (docs/backups.md) ---

# Where the settings of the destination live (rclone's login, an SSH key, restic's cache), and
# the folder of a repository on another disk. Both are made here, owned by whoever runs the
# scripts: Docker would make them as root, and the backup job runs as this user.
backup_folders() {
	config_dir="$(setting KERNIC_BACKUP_CONFIG_DIR)"
	config_dir="${config_dir:-./backup-config}"
	local_repo="$(setting KERNIC_BACKUP_LOCAL_REPO)"
	local_repo="${local_repo:-./backup-config/repo}"
	mkdir -p "$config_dir/cache" "$config_dir/rclone" "$config_dir/ssh" "$local_repo"
	chmod 700 "$config_dir" "$config_dir/ssh" 2>/dev/null || true
}

# Builds the image of the backup job if there is none, or it has changed.
backup_image() { docker compose build --quiet backup >/dev/null; }

# backup_run [docker compose run options] backup [restic arguments]
# Runs restic, or with --entrypoint another tool of the image, in the backup job. With Docker
# as root, as the user who runs the script, so that what the job reads and writes on this
# machine is theirs and not root's (an SFTP repository needs that user in the container's list
# of users, for ssh). With rootless Docker the container's root already is that user.
backup_run() {
	# No terminal, unless backup-tool.sh asks for one (rclone config is interactive).
	tty=-T
	if [ "${KERNIC_BACKUP_TTY:-}" = 1 ]; then tty=; fi
	if ! docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
		case "$(setting KERNIC_BACKUP_REPOSITORY)" in
		sftp:*) set -- -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro "$@" ;;
		esac
		set -- --user "$(id -u):$(id -g)" "$@"
	fi
	# shellcheck disable=SC2086 # $tty is one option or nothing
	docker compose run --rm $tty "$@"
}

# What is needed to rebuild an installation, and nothing that can be made again: the key of
# the stored Git tokens, the address, the image versions, the limits. Not the passwords of the
# database and the worker, and not the settings of the backup itself. It goes into the
# encrypted repository only, never into the folder next to the backup.
write_secrets_copy() {
	if [ -f .env ]; then
		grep -E '^(KERNIC_SECRET_KEY|KERNIC_SITE_ADDRESS|KERNIC_HTTP_PORT|KERNIC_HTTPS_PORT|KERNIC_APP_IMAGE|KERNIC_WORKER_IMAGE|KERNIC_PACKAGE_REGISTRY|KERNIC_MAX_[A-Z_]*|KERNIC_GIT_HOSTS|KERNIC_WORKER_(CPUS|MEMORY)|KERNIC_COMPILE_TIMEOUT_MS|KERNIC_WARM_SESSIONS|KERNIC_LANGUAGE_SESSIONS)=' .env >"$1" || true
	else
		: >"$1"
	fi
}

# ping <setting that holds the address> <start|ok|fail>
# Tells a monitoring service (Healthchecks, Uptime Kuma, ...) how a run went; it raises the
# alarm when the "ok" does not come. A failing ping never fails the run. An address with a
# query (Uptime Kuma's push URLs) is only called for "ok".
ping() {
	address="$(setting "$1")"
	[ -n "$address" ] || return 0
	case "$address" in
	*\?*)
		[ "$2" = ok ] || return 0
		target="$address"
		;;
	*)
		case "$2" in
		start) target="$address/start" ;;
		fail) target="$address/fail" ;;
		*) target="$address" ;;
		esac
		;;
	esac
	if command -v curl >/dev/null 2>&1; then
		curl -fsS -m 10 --retry 2 -o /dev/null "$target" >/dev/null 2>&1 || true
	elif command -v wget >/dev/null 2>&1; then
		wget -q -T 10 -O /dev/null "$target" >/dev/null 2>&1 || true
	fi
}

# fetch_snapshot <snapshot or "latest"> <empty folder>: brings a snapshot of the repository
# back into the folder: stage/ (the backup) and secrets/kernic.env.
fetch_snapshot() {
	if [ "$1" = latest ]; then
		backup_run -v "$2:/out" backup restore latest --host kernic --tag kernic --target /out --quiet
	else
		backup_run -v "$2:/out" backup restore "$1" --target /out --quiet
	fi
}
