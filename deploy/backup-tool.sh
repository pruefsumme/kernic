#!/bin/sh
# Runs restic or rclone with the settings of the backups (docs/backups.md), for what the
# scripts do not do for you:
#
#   ./backup-tool.sh restic snapshots          what is in the repository
#   ./backup-tool.sh restic check              check the repository
#   ./backup-tool.sh rclone config             set up a destination such as Google Drive
#   ./backup-tool.sh rclone listremotes
#
# They run in the same container as the uploads, with the folder of settings
# (KERNIC_BACKUP_CONFIG_DIR) and the repository's password from deploy/.env.
set -eu
cd "$(dirname "$0")"
# shellcheck source=backup-lib.sh
. ./backup-lib.sh

tool="${1:-}"
[ -n "$tool" ] || die 2 "usage: ./backup-tool.sh restic|rclone <arguments>"
shift
backup_folders
backup_image
# These are typed at: a terminal, if there is one.
if [ -t 0 ]; then KERNIC_BACKUP_TTY=1; export KERNIC_BACKUP_TTY; fi
case "$tool" in
restic) backup_run backup "$@" ;;
rclone) backup_run --entrypoint rclone backup "$@" ;;
*) die 2 "Only restic and rclone: ./backup-tool.sh restic|rclone <arguments>" ;;
esac
