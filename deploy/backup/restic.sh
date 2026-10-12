#!/bin/sh
# Runs restic for Kernic's backups. It adds a cache that survives between runs (so that a
# run does not read the whole repository again), and for a repository on an SFTP server the
# key and the list of known servers from the settings folder, instead of what the container
# happens to have. Everything else is restic's own command line.
set -eu

cache=/config/cache
mkdir -p "$cache" 2>/dev/null || true
if [ -w "$cache" ]; then
	set -- --cache-dir "$cache" "$@"
else
	set -- --no-cache "$@"
fi

case "${RESTIC_REPOSITORY:-}" in
sftp:*)
	set -- -o "sftp.args=-F /dev/null -i /config/ssh/id_ed25519 -o UserKnownHostsFile=/config/ssh/known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes" "$@"
	;;
esac

exec restic "$@"
