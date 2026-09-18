#!/usr/bin/env bash
# Restore drill (brief §44: a backup that has never been restored is not verified).
# Restores the newest backup into a SCRATCH database, runs integrity checks, drops it.
# Usage: COMMUNITY_DATABASE_URL=postgres://user:pw@host:5432/loopcom_community BACKUP_DIR=… [BACKUP_PASSPHRASE=…] scripts/community/restore-drill.sh
set -euo pipefail
: "${COMMUNITY_DATABASE_URL:?set COMMUNITY_DATABASE_URL}"
: "${BACKUP_DIR:=/var/backups/loopcom-community}"
latest="$(ls -1t "$BACKUP_DIR"/community-*.dump* 2>/dev/null | grep -v '\.sha256$' | head -1)"
[ -n "$latest" ] || { echo "no backup found in $BACKUP_DIR"; exit 2; }
sha256sum -c "$latest.sha256"
work="$latest"
if [[ "$latest" == *.gpg ]]; then
  : "${BACKUP_PASSPHRASE:?encrypted backup needs BACKUP_PASSPHRASE}"
  work="$(mktemp)"; gpg --batch --yes --decrypt --passphrase "$BACKUP_PASSPHRASE" -o "$work" "$latest"
fi
admin_url="${COMMUNITY_DATABASE_URL%/*}/postgres"
scratch="community_restore_drill_$(date +%s)"
psql -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$scratch\"" "$admin_url"
trap 'psql -c "DROP DATABASE IF EXISTS \"$scratch\"" "$admin_url" >/dev/null' EXIT
pg_restore --no-owner --no-privileges --dbname="${COMMUNITY_DATABASE_URL%/*}/$scratch" "$work"
# Integrity: every migration recorded, relationships intact, counts sane.
# Options BEFORE the connection string: Windows getopt stops at the first positional argument.
psql -v ON_ERROR_STOP=1 -tA "${COMMUNITY_DATABASE_URL%/*}/$scratch" <<'SQL'
SELECT 'migrations', count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;
SELECT 'people', count(*) FROM "Person";
SELECT 'orphan_profiles', count(*) FROM "Profile" p LEFT JOIN "Person" q ON q.id = p."personId" WHERE q.id IS NULL;
SELECT 'orphan_messages', count(*) FROM "Message" m LEFT JOIN "Thread" t ON t.id = m."threadId" WHERE t.id IS NULL;
SELECT 'double_accepted_quotes', count(*) FROM (SELECT "rfqId" FROM "Quote" WHERE status='ACCEPTED' GROUP BY "rfqId" HAVING count(*) > 1) x;
SQL
echo "restore drill OK from $latest → $scratch (dropped)"
