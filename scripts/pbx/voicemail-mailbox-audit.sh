#!/bin/bash
# Voicemail mailbox audit — run ON THE PBX. Read-only.
#
# WHY THIS EXISTS (2026-08-23): Fixup Group ext 103 and McNamara Lion ext 101
# had been unable to receive a voicemail since the day each was created — two
# and four months. Neither customer reported it, because it never worked once,
# so there was no "it stopped" for them to notice, and Connect's voicemail
# screen shows an empty list either way. Nothing anywhere compared what the
# configuration INTENDS against what Asterisk actually LOADED.
#
# Two independent failure classes, both silent:
#
#   A. enabled='no' in ombu_extensions_vm. The schema default is 'no', so an
#      extension created without explicitly switching voicemail on gets none.
#      Both casualties were hand-created in the panel with the box unticked.
#      (The sign-up wizard is immune — it sends vm_enabled: "yes" explicitly.)
#
#   B. enabled='yes' but the mailbox is absent from Asterisk. A mailbox line
#      written into a tenant file that has no [context] header loads NOTHING,
#      reloads rc=0, and logs nothing at any layer.
#
# Exit 0 = clean. Exit 1 = either class.
#
# ⛔ Class A MUST fail too, and that is the whole point: pre-fix, class B was
# SILENT here — enabled='yes' was 122 and Asterisk had loaded 122, so the two
# casualties matched perfectly by being excluded from both sides. The signal
# that would actually have caught this incident is a non-allowlisted
# enabled='no'. A check that only failed on class B would have watched this
# happen for four months and reported OK every time.
#
# Deliberate exclusions go in the allowlist, which is the reviewed record of
# "we meant this" — not silence.
set -uo pipefail

ALLOWLIST_DISABLED="${VM_AUDIT_ALLOW_DISABLED:-gesheft:898}"   # tenant:ext, comma-separated

intended=$(mysql -N -e "select count(*) from ombutel.ombu_extensions_vm where enabled='yes';" 2>/dev/null)
loaded=$(asterisk -rx "voicemail show users" 2>/dev/null | grep -oE '^[0-9]+ voicemail users' | grep -oE '^[0-9]+')

echo "voicemail mailbox audit"
echo "  intended (database enabled='yes') : ${intended:-?}"
echo "  loaded   (asterisk)               : ${loaded:-?}"

rc=0

# ── class B: intended but not loaded — the fatal one ────────────────────────
asterisk -rx "voicemail show users" 2>/dev/null | awk 'NR>1 && NF>2 {print $1"|"$2}' | sort -u > /tmp/.vm_loaded.$$
mysql -N -e "select concat(substring_index(v_ctx.mailbox,'@',-1),'|',e.extension), t.name, e.name
             from ombutel.ombu_extensions_vm v
             join ombutel.ombu_extensions e on e.extension_id=v.extension_id
             join ombutel.ombu_extensions v_ctx on v_ctx.extension_id=v.extension_id
             join ombutel.ombu_tenants t on t.tenant_id=e.tenant_id
             where v.enabled='yes' and v_ctx.mailbox<>'' and v_ctx.mailbox is not null;" 2>/dev/null \
  > /tmp/.vm_intended.$$

missing=0
while IFS=$'\t' read -r key tname ename; do
  [ -z "${key:-}" ] && continue
  if ! grep -qxF "$key" /tmp/.vm_loaded.$$; then
    [ "$missing" -eq 0 ] && echo "" && echo "  CANNOT RECEIVE VOICEMAIL (enabled in the database, absent from Asterisk):"
    echo "    $tname  ext ${key##*|}  \"$ename\""
    missing=$((missing+1)); rc=1
  fi
done < /tmp/.vm_intended.$$

# ── class A: switched off — report for review ───────────────────────────────
off=$(mysql -N -e "select concat(t.name,':',e.extension,'  \"',e.name,'\"')
                   from ombutel.ombu_extensions_vm v
                   join ombutel.ombu_extensions e on e.extension_id=v.extension_id
                   join ombutel.ombu_tenants t on t.tenant_id=e.tenant_id
                   where v.enabled='no' order by t.name;" 2>/dev/null)
if [ -n "$off" ]; then
  echo ""
  echo "  voicemail switched OFF (review — some are deliberate):"
  while read -r line; do
    [ -z "$line" ] && continue
    keyshort=$(echo "$line" | awk '{print $1}')
    case ",$ALLOWLIST_DISABLED," in
      *",${keyshort%% *},"*) echo "    $line   [allowlisted]" ;;
      *) echo "    $line   <<< NOT allowlisted — is this intended?"; rc=1 ;;
    esac
  done <<< "$off"
fi

rm -f /tmp/.vm_loaded.$$ /tmp/.vm_intended.$$
[ "$rc" -eq 0 ] && echo "" && echo "  OK — every intended mailbox is loaded."
exit $rc
