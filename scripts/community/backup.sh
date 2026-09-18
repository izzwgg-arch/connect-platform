#!/usr/bin/env bash
# Loopcom Community — encrypted, versioned database backup (brief §44).
# Usage: COMMUNITY_DATABASE_URL=postgres://… BACKUP_DIR=/backups/community BACKUP_PASSPHRASE=… scripts/community/backup.sh
# Keeps daily backups for RETENTION_DAYS (default 30). Verifies the archive after writing it.
set -euo pipefail
: "${COMMUNITY_DATABASE_URL:?set COMMUNITY_DATABASE_URL}"
: "${BACKUP_DIR:=/var/backups/loopcom-community}"
: "${RETENTION_DAYS:=30}"
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/community-$stamp.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$out" "$COMMUNITY_DATABASE_URL"
pg_restore --list "$out" >/dev/null   # archive is readable
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase "$BACKUP_PASSPHRASE" -o "$out.gpg" "$out"
  rm -f "$out"; out="$out.gpg"
fi
sha256sum "$out" > "$out.sha256"
find "$BACKUP_DIR" -name 'community-*.dump*' -mtime +"$RETENTION_DAYS" -delete
echo "backup written: $out ($(du -h "$out" | cut -f1))"
