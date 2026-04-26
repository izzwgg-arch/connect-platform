#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Tenant-scoped prompt push for Connect (post-20260426 isolation migration).
#
# For every row in VitalPBX's ombu_recordings table that has an audio file on
# disk, this script uploads the bytes to Connect with the VitalPBX tenant_id
# embedded in the meta payload. Connect resolves tenant_id → Connect tenantId
# via TenantPbxLink and stores each file under a tenant-scoped directory so
# two tenants' same-named recordings can never overwrite each other.
#
# Usage on the PBX host:
#   export CONNECT_URL="https://app.connectcomunications.com/api"
#   export SECRET="<PROMPT_SYNC_SHARED_SECRET from Connect>"
#   export PBX_INSTANCE_ID="<optional, ask Connect admin>"   # omit to use first enabled
#   bash push-prompts-tenant-scoped.sh
#
# Safety:
#   - Read-only against VitalPBX: one indexed SELECT + one file per row.
#   - Does NOT delete or modify PBX recordings.
#   - If a row has no link on Connect side, upload still happens but lands
#     in the "unassigned" bucket with ownershipConfidence=unknown; tenant
#     admins will NOT see it. Super admin can reassign from the UI.
# ═══════════════════════════════════════════════════════════════════════════
set -u

: "${CONNECT_URL:?CONNECT_URL not set}"
: "${SECRET:?SECRET not set}"

PBX_META_EXTRA=""
if [ -n "${PBX_INSTANCE_ID:-}" ]; then
  PBX_META_EXTRA=",\"pbxInstanceId\":\"$PBX_INSTANCE_ID\""
fi

echo "=== Fetching recordings from ombu_recordings ==="
ROWS_FILE="$(mktemp)"
trap 'rm -f "$ROWS_FILE"' EXIT
mysql -sN ombutel -e "
  SELECT r.recording_id,
         r.tenant_id,
         r.name,
         t.path
  FROM ombu_recordings r
  JOIN ombu_tenants t ON t.tenant_id = r.tenant_id
  WHERE r.name IS NOT NULL AND r.name <> ''
  ORDER BY r.tenant_id, r.recording_id
" > "$ROWS_FILE"

count=$(wc -l < "$ROWS_FILE" | tr -d '[:space:]')
echo "Found $count recordings across linked VitalPBX tenants."
echo

ok=0; miss=0; fail=0; unlinked=0
while IFS=$'\t' read -r rid pbx_tid name tpath; do
  [ -z "$rid" ] && continue
  hash=$(printf '%s' "$rid" | md5sum | awk '{print $1}')
  file="/var/lib/vitalpbx/static/$tpath/recordings/${hash}.wav"
  base=$(printf '%s' "$name" | sed 's/ /_/g; s|^custom/||')

  if [ ! -f "$file" ]; then
    printf '  MISS     rid=%-4s pbx_tid=%-3s %s (no file on disk)\n' "$rid" "$pbx_tid" "$name"
    miss=$((miss+1))
    continue
  fi

  sha=$(sha256sum "$file" | awk '{print $1}')
  meta="{\"fileBaseName\":\"$base\",\"originalFilename\":\"$base.wav\",\"sha256\":\"$sha\",\"pbxTenantId\":\"$pbx_tid\",\"displayName\":\"$name\"$PBX_META_EXTRA}"

  resp_file=$(mktemp)
  code=$(curl -sS -o "$resp_file" -w '%{http_code}' \
    --connect-timeout 10 --max-time 60 \
    -H "x-connect-secret: $SECRET" \
    -F "file=@$file" \
    -F "meta=$meta" \
    "$CONNECT_URL/voice/ivr/prompts/upload")
  body=$(cat "$resp_file")
  rm -f "$resp_file"

  if [ "$code" = "200" ]; then
    # Check the ownershipConfidence in the response; warn on unassigned.
    conf=$(printf '%s' "$body" | grep -o '"ownershipConfidence":"[^"]*"' | head -1 | sed 's/.*"ownershipConfidence":"\([^"]*\)".*/\1/')
    if [ "$conf" = "exact" ]; then
      ok=$((ok+1))
      printf '  OK       rid=%-4s pbx_tid=%-3s %s\n' "$rid" "$pbx_tid" "$name"
    else
      unlinked=$((unlinked+1))
      printf '  UNLINK   rid=%-4s pbx_tid=%-3s %s  (Connect has no TenantPbxLink for this PBX tenant → stored under unassigned/)\n' "$rid" "$pbx_tid" "$name"
    fi
  else
    fail=$((fail+1))
    printf '  FAIL     rid=%-4s pbx_tid=%-3s %s  [HTTP %s] %s\n' "$rid" "$pbx_tid" "$name" "$code" "$body"
  fi
done < "$ROWS_FILE"

echo
echo "Done."
printf '  linked+uploaded     = %d  (ownershipConfidence=exact, visible to tenant admins)\n' "$ok"
printf '  unlinked (unassign) = %d  (no TenantPbxLink; visible to super admin only)\n' "$unlinked"
printf '  no file on disk     = %d  (skipped; PBX side has no bytes to push)\n' "$miss"
printf '  upload failures     = %d\n' "$fail"
echo
if [ "$unlinked" -gt 0 ]; then
  echo "NOTE: $unlinked recordings uploaded but have no TenantPbxLink on Connect."
  echo "      Create the missing links under Admin → PBX Instances, then re-run this"
  echo "      script; Connect will re-wire those rows and flip them to confidence=exact."
fi
