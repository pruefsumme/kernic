# What sends backups to another place: restic (encrypts, deduplicates, keeps the right
# snapshots) and rclone (reaches Google Drive, Dropbox, OneDrive, WebDAV and more), and an
# SSH client for a repository on an SFTP server. Used by deploy/backup.sh through the
# `backup` service of compose.yaml; nothing in it runs unless a backup is being sent.
#
# The tools come from Alpine's own packages, so their versions follow the Alpine release
# named here rather than being pinned one by one; each run prints the version of restic.
FROM alpine:3.23
RUN apk add --no-cache restic rclone openssh-client ca-certificates tzdata
COPY restic.sh /usr/local/bin/kernic-restic
ENTRYPOINT ["/usr/local/bin/kernic-restic"]
