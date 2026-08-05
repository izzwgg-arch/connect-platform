#!/usr/bin/env bash
# ============================================================================
# install-connect-wake-dialplan.sh — Install the Connect Push-Wake dialplan
#                                     refactor on a VitalPBX host.
#
# This script is IDEMPOTENT — safe to re-run.
#
# What it does (in order):
#   1. Sanity checks: must be root, asterisk + curl + asterisk -rx must work.
#   2. Snapshots /etc/asterisk/extensions__60_custom.conf to .bak.<timestamp>.
#   3. Extracts any non-Connect contexts (e.g. tenant bridges like
#      [T21_app-custom-application]) from the existing file so they survive.
#   4. Writes the new Connect Option-A dialplan (with PHASE 4 push-wake
#      smart-wrapper) over /etc/asterisk/extensions__60_custom.conf.
#   5. Re-appends the preserved non-Connect contexts.
#   6. Sets ownership/permissions (asterisk:asterisk 0644).
#   7. Runs `asterisk -rx "dialplan reload"` and verifies the new context
#      [connect-dial-with-wake] is loaded.
#   8. (Optional) Calls Connect's POST /internal/pbx/publish-wake-config to
#      bootstrap the AstDB keys the wrapper reads. Requires the env vars:
#        CONNECT_API_BASE       (default: https://app.connectcomunications.com/api)
#        CONNECT_CDR_SECRET     (REQUIRED for publish step; skip if unset)
#        CONNECT_TENANT_ID      (optional — publishes per-tenant keys too)
#   9. Prints a final smoke-test snapshot of the AstDB keys.
#
# Usage:
#   chmod +x install-connect-wake-dialplan.sh
#   sudo \
#     CONNECT_CDR_SECRET="<value-from-Connect-API-env>" \
#     CONNECT_TENANT_ID="<connect-tenant-uuid-optional>" \
#     ./install-connect-wake-dialplan.sh
# ============================================================================

set -euo pipefail

step() { printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\nWARN: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# ── 1. Preflight ────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (sudo)."
command -v asterisk >/dev/null 2>&1 || die "asterisk binary not found in PATH"
command -v curl     >/dev/null 2>&1 || die "curl not installed"
asterisk -rx "core show channels count" >/dev/null 2>&1 || die "asterisk -rx not responsive — is Asterisk running?"

DIALPLAN_FILE="/etc/asterisk/extensions__60_custom.conf"
BACKUP_FILE="${DIALPLAN_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
TMP_NEW="/tmp/connect-dialplan-new.$$.conf"
TMP_PRESERVED="/tmp/connect-dialplan-preserved.$$.conf"
trap 'rm -f "$TMP_NEW" "$TMP_PRESERVED"' EXIT

CONNECT_CONTEXT_PREFIX="connect-"  # all our contexts start with this

# ── 2. Snapshot existing file ───────────────────────────────────────────────
step "[1/9] Snapshot current dialplan"
if [[ -f "$DIALPLAN_FILE" ]]; then
  cp -a "$DIALPLAN_FILE" "$BACKUP_FILE"
  echo "  ↳ backed up to $BACKUP_FILE"
else
  echo "  ↳ no existing $DIALPLAN_FILE — creating fresh"
  : > "$BACKUP_FILE"
fi

# ── 3. Extract non-Connect contexts to preserve ─────────────────────────────
# A "context" starts at a line matching ^\[name\] and continues until the next
# ^\[ or EOF. We keep any context whose name does NOT start with "connect-".
# This preserves tenant-side bridges (e.g. [T21_app-custom-application]).
step "[2/9] Preserve non-Connect contexts from existing file"
awk -v prefix="$CONNECT_CONTEXT_PREFIX" '
  /^\[/ {
    in_keep = 1
    name = $0
    sub(/^\[/, "", name)
    sub(/\].*$/, "", name)
    if (index(name, prefix) == 1) {
      in_keep = 0
    }
    if (in_keep) print
    next
  }
  { if (in_keep) print }
' "$BACKUP_FILE" > "$TMP_PRESERVED"

PRESERVED_LINES=$(wc -l < "$TMP_PRESERVED" | tr -d ' ')
PRESERVED_CONTEXTS=$(grep -c '^\[' "$TMP_PRESERVED" || true)
echo "  ↳ preserved $PRESERVED_CONTEXTS non-Connect context(s) ($PRESERVED_LINES lines)"
if [[ "$PRESERVED_CONTEXTS" -gt 0 ]]; then
  grep '^\[' "$TMP_PRESERVED" | sed 's/^/    • /'
fi

# ── 4. Write the new Connect dialplan ───────────────────────────────────────
step "[3/9] Write new Connect Option-A + push-wake dialplan"
cat > "$TMP_NEW" <<'CONNECT_DP_EOF'
; ============================================================================
; Connect Option A — Shared Tenant Router Custom Context for VitalPBX / Asterisk
; (Auto-installed by install-connect-wake-dialplan.sh — DO NOT HAND-EDIT THIS
;  FILE. Local additions belong in their own *.conf files included by Asterisk
;  or in distinct contexts that the install script preserves on next run.)
; ============================================================================

[connect-tenant-router]
exten => _X!,1,NoOp(Connect Option A router — tenant=${TENANT_SLUG} dnid=${EXTEN})
 same =>      n,GotoIf($["${TENANT_SLUG}" = ""]?missing_slug)
 same =>      n,Set(DID_TENANT=${DB(connect/didmap/${EXTEN}/tenant)})
 same =>      n,ExecIf($["${DID_TENANT}" != ""]?Set(TENANT_SLUG=${DID_TENANT}))
 same =>      n,Set(DID_MOH_CLASS=${DB(connect/didmap/${EXTEN}/moh_class)})
 same =>      n,Set(FAMILY=connect/t_${TENANT_SLUG})
 same =>      n,Set(MOH_CLASS=${DB(${FAMILY}/moh_class)})
 same =>      n,ExecIf($["${MOH_CLASS}" = ""]?Set(MOH_CLASS=${DB(${FAMILY}/active_moh_class)}))
 same =>      n,ExecIf($["${DID_MOH_CLASS}" != ""]?Set(MOH_CLASS=${DID_MOH_CLASS}))
 same =>      n,ExecIf($["${MOH_CLASS}" != ""]?Set(CHANNEL(musicclass)=${MOH_CLASS}))
 same =>      n,NoOp(Connect MOH resolved tenant=${TENANT_SLUG} did=${EXTEN} did_moh=${DID_MOH_CLASS} effective_moh=${MOH_CLASS} channel_moh=${CHANNEL(musicclass)})
 same =>      n,Set(MODE=${DB(${FAMILY}/mode)})
 same =>      n,GotoIf($["${MODE}" = ""]?fallback)
 same =>      n,Set(DEST=${DB(${FAMILY}/dest_${MODE})})
 same =>      n,GotoIf($["${DEST}" = ""]?fallback)
 same =>      n,NoOp(Connect routing tenant=${TENANT_SLUG} mode=${MODE} dest=${DEST} moh=${MOH_CLASS})
 same =>      n,Goto(${DEST})
 same =>      n(fallback),NoOp(Connect fallback — tenant=${TENANT_SLUG} mode='${MODE}' dest='${DEST}')
 same =>      n,Goto(connect-default-fallback,s,1)
 same =>      n(missing_slug),NoOp(Connect error: no TENANT_SLUG set on channel)
 same =>      n,Goto(connect-default-fallback,s,1)

exten => s,1,NoOp(Connect Option A router — tenant=${TENANT_SLUG} (no DNID))
 same =>    n,Goto(_X!,1)

[connect-default-fallback]
exten => s,1,NoOp(Connect fallback — no Option A route configured for tenant ${TENANT_SLUG})
 same =>    n,Answer()
 same =>    n,Wait(1)
 same =>    n,Playback(vm-goodbye)
 same =>    n,Hangup()

[connect-tenant-ivr]
exten => _X!,1,NoOp(Connect Phase 2 IVR — tenant=${TENANT_SLUG} dnid=${EXTEN})
 same =>      n,GotoIf($["${TENANT_SLUG}" = ""]?missing_slug)
 same =>      n,Set(DID_TENANT=${DB(connect/didmap/${EXTEN}/tenant)})
 same =>      n,ExecIf($["${DID_TENANT}" != ""]?Set(TENANT_SLUG=${DID_TENANT}))
 same =>      n,Set(DID_MOH_CLASS=${DB(connect/didmap/${EXTEN}/moh_class)})
 same =>      n,Set(FAMILY=connect/t_${TENANT_SLUG})
 same =>      n,Set(MOH_CLASS=${DB(${FAMILY}/moh_class)})
 same =>      n,ExecIf($["${MOH_CLASS}" = ""]?Set(MOH_CLASS=${DB(${FAMILY}/active_moh_class)}))
 same =>      n,ExecIf($["${DID_MOH_CLASS}" != ""]?Set(MOH_CLASS=${DID_MOH_CLASS}))
 same =>      n,ExecIf($["${MOH_CLASS}" != ""]?Set(CHANNEL(musicclass)=${MOH_CLASS}))
 same =>      n,NoOp(Connect MOH resolved tenant=${TENANT_SLUG} did=${EXTEN} did_moh=${DID_MOH_CLASS} effective_moh=${MOH_CLASS} channel_moh=${CHANNEL(musicclass)})
 same =>      n,Set(HOLD_ANNOUNCE=${DB(${FAMILY}/hold_announce)})
 same =>      n,Set(HOLD_REPEAT=${DB(${FAMILY}/hold_repeat)})
 same =>      n,Set(HOLD_REPEAT=${IF($[${LEN(${HOLD_REPEAT})}>0]?${HOLD_REPEAT}:30)})
 same =>      n,Set(GREETING=${DB(${FAMILY}/active_prompt)})
 same =>      n,Set(INVALID_PROMPT=${DB(${FAMILY}/active_prompt_invalid)})
 same =>      n,Set(TIMEOUT_PROMPT=${DB(${FAMILY}/active_prompt_timeout)})
 same =>      n,Set(RETRY_PROMPT=${DB(${FAMILY}/active_prompt_retry)})
 same =>      n,Set(T=${DB(${FAMILY}/timeout_seconds)})
 same =>      n,Set(R_MAX=${DB(${FAMILY}/max_retries)})
 same =>      n,Set(DIRECT_DIAL=${DB(${FAMILY}/direct_dial)})
 same =>      n,Set(T=${IF($[${LEN(${T})}>0]?${T}:7)})
 same =>      n,Set(R_MAX=${IF($[${LEN(${R_MAX})}>0]?${R_MAX}:3)})
 same =>      n,Set(RETRIES=0)
 same =>      n,Answer()
 same =>      n,Set(IVR_DID=${EXTEN})   ; Connect play-prompt return point
 same =>      n,Wait(1)
 same =>      n,Set(PRE_ANNOUNCE=${DB(${FAMILY}/pre_announce)})   ; Connect pre-menu announcement
 same =>      n,GotoIf($["${PRE_ANNOUNCE}" = ""]?prompt)
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PRE_ANNOUNCE}.wav)}" = "1"]?play_pre)
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PRE_ANNOUNCE}.ulaw)}" = "1"]?play_pre)
 same =>      n,NoOp(Connect pre-announce file missing ref=${PRE_ANNOUNCE} — skipping)
 same =>      n,Goto(prompt)
 same =>      n(play_pre),Playback(${PRE_ANNOUNCE})
 same =>      n(prompt),GotoIf($[${RETRIES} > 0 & ${LEN(${RETRY_PROMPT})} > 0]?play_retry)
 same =>      n,GotoIf($["${GREETING}" = ""]?default_greet)
 same =>      n,NoOp(Connect IVR greeting attempt tenant=${TENANT_SLUG} ref=${GREETING})
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${GREETING}.ulaw)}" = "1"]?play_greet)
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${GREETING}.wav)}" = "1"]?play_greet)
 same =>      n,NoOp(Connect IVR greeting file missing ref=${GREETING} — falling back to default)
 same =>      n,Goto(default_greet)
 same =>      n(play_greet),Background(${GREETING})
 same =>      n,Goto(waitdigit)
 same =>      n(play_retry),NoOp(Connect IVR retry prompt tenant=${TENANT_SLUG} ref=${RETRY_PROMPT})
 same =>      n,Background(${RETRY_PROMPT})
 same =>      n,Goto(waitdigit)
 same =>      n(default_greet),NoOp(Connect IVR default fallback — tenant=${TENANT_SLUG} ref-was=${GREETING})
 same =>      n,Playback(one-moment-please)
 same =>      n,Playback(vm-enter-num-to-call)
 same =>      n(waitdigit),WaitExten(${T})
 same =>      n,Set(RETRIES=$[${RETRIES}+1])
 same =>      n,GotoIf($[${RETRIES} >= ${R_MAX}]?exhausted_timeout)
 same =>      n,GotoIf($["${TIMEOUT_PROMPT}" = ""]?prompt)
 same =>      n,NoOp(Connect IVR timeout prompt tenant=${TENANT_SLUG} ref=${TIMEOUT_PROMPT})
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${TIMEOUT_PROMPT}.ulaw)}" = "1"]?play_timeout)
 same =>      n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${TIMEOUT_PROMPT}.wav)}" = "1"]?play_timeout)
 same =>      n,NoOp(Connect IVR timeout prompt missing ref=${TIMEOUT_PROMPT} — reprompting)
 same =>      n,Goto(prompt)
 same =>      n(play_timeout),Background(${TIMEOUT_PROMPT})
 same =>      n,Goto(waitdigit)
 same =>      n(exhausted_timeout),Set(EXIT_TYPE=${DB(${FAMILY}/dest_timeout_type)})
 same =>      n,Set(EXIT_DEST=${DB(${FAMILY}/dest_timeout)})
 same =>      n,GotoIf($["${EXIT_DEST}" = ""]?fallback)
 same =>      n,NoOp(IVR exhausted on timeout — routing tenant=${TENANT_SLUG} type=${EXIT_TYPE} dest=${EXIT_DEST})
 same =>      n,Goto(connect-exit-router,s,1)
 same =>      n(fallback),Goto(connect-default-fallback,s,1)
 same =>      n(missing_slug),NoOp(Connect error: no TENANT_SLUG set on channel)
 same =>      n,Goto(connect-default-fallback,s,1)

exten => s,1,NoOp(Connect Phase 2 IVR — tenant=${TENANT_SLUG} (no DNID))
 same =>    n,Goto(_X!,1)

exten => 0,1,Set(OPT_DIGIT=0)
 same =>    n,Goto(connect-option-router,s,1)
exten => 1,1,Set(OPT_DIGIT=1)
 same =>    n,Goto(connect-option-router,s,1)
exten => 2,1,Set(OPT_DIGIT=2)
 same =>    n,Goto(connect-option-router,s,1)
exten => 3,1,Set(OPT_DIGIT=3)
 same =>    n,Goto(connect-option-router,s,1)
exten => 4,1,Set(OPT_DIGIT=4)
 same =>    n,Goto(connect-option-router,s,1)
exten => 5,1,Set(OPT_DIGIT=5)
 same =>    n,Goto(connect-option-router,s,1)
exten => 6,1,Set(OPT_DIGIT=6)
 same =>    n,Goto(connect-option-router,s,1)
exten => 7,1,Set(OPT_DIGIT=7)
 same =>    n,Goto(connect-option-router,s,1)
exten => 8,1,Set(OPT_DIGIT=8)
 same =>    n,Goto(connect-option-router,s,1)
exten => 9,1,Set(OPT_DIGIT=9)
 same =>    n,Goto(connect-option-router,s,1)
exten => *,1,Set(OPT_DIGIT=star)
 same =>    n,Goto(connect-option-router,s,1)
exten => #,1,Set(OPT_DIGIT=hash)
 same =>    n,Goto(connect-option-router,s,1)

exten => _XXX,1,NoOp(Connect IVR direct-dial candidate — tenant=${TENANT_SLUG} exten=${EXTEN})
 same =>      n,GotoIf($["${DIRECT_DIAL}" != "1"]?block)
 same =>      n,Set(PBX_TENANT_ID=${DB(connect/t_${TENANT_SLUG}/pbx_tenant_id)})
 same =>      n,GotoIf($["${PBX_TENANT_ID}" = ""]?legacy_dial)
 same =>      n,Set(__DIAL_TARGET=T${PBX_TENANT_ID}_cos-all,${EXTEN},1)
 same =>      n,Set(__WAKE_EXT=${EXTEN})
 same =>      n,Goto(connect-dial-with-wake,s,1)
 same =>      n(legacy_dial),NoOp(No pbx_tenant_id published for tenant=${TENANT_SLUG} — falling back to from-internal)
 same =>      n,Goto(from-internal,${EXTEN},1)
 same =>      n(block),NoOp(Direct dial disabled for tenant — treating as invalid)
 same =>      n,Goto(i,1)
exten => _XXXX,1,NoOp(Connect IVR direct-dial candidate — tenant=${TENANT_SLUG} exten=${EXTEN})
 same =>       n,GotoIf($["${DIRECT_DIAL}" != "1"]?block)
 same =>       n,Set(PBX_TENANT_ID=${DB(connect/t_${TENANT_SLUG}/pbx_tenant_id)})
 same =>       n,GotoIf($["${PBX_TENANT_ID}" = ""]?legacy_dial)
 same =>       n,Set(__DIAL_TARGET=T${PBX_TENANT_ID}_cos-all,${EXTEN},1)
 same =>       n,Set(__WAKE_EXT=${EXTEN})
 same =>       n,Goto(connect-dial-with-wake,s,1)
 same =>       n(legacy_dial),NoOp(No pbx_tenant_id published for tenant=${TENANT_SLUG} — falling back to from-internal)
 same =>       n,Goto(from-internal,${EXTEN},1)
 same =>       n(block),NoOp(Direct dial disabled for tenant — treating as invalid)
 same =>       n,Goto(i,1)

exten => i,1,NoOp(Connect IVR invalid digit — tenant=${TENANT_SLUG} retries=${RETRIES})
 same =>   n,Set(RETRIES=$[${RETRIES}+1])
 same =>   n,GotoIf($[${RETRIES} >= ${R_MAX}]?exhausted_invalid)
 same =>   n,GotoIf($["${INVALID_PROMPT}" = ""]?reprompt)
 same =>   n,NoOp(Connect IVR invalid prompt tenant=${TENANT_SLUG} ref=${INVALID_PROMPT})
 same =>   n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${INVALID_PROMPT}.ulaw)}" = "1"]?play_invalid)
 same =>   n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${INVALID_PROMPT}.wav)}" = "1"]?play_invalid)
 same =>   n,NoOp(Connect IVR invalid prompt missing ref=${INVALID_PROMPT} — reprompting)
 same =>   n,Goto(reprompt)
 same =>   n(play_invalid),Background(${INVALID_PROMPT})
 same =>   n(reprompt),Goto(connect-tenant-ivr,${EXTEN},prompt)
 same =>   n(exhausted_invalid),Set(EXIT_TYPE=${DB(${FAMILY}/dest_invalid_type)})
 same =>   n,Set(EXIT_DEST=${DB(${FAMILY}/dest_invalid)})
 same =>   n,GotoIf($["${EXIT_DEST}" = ""]?fallback)
 same =>   n,NoOp(IVR exhausted on invalid — routing tenant=${TENANT_SLUG} type=${EXIT_TYPE} dest=${EXIT_DEST})
 same =>   n,Goto(connect-exit-router,s,1)
 same =>   n(fallback),Goto(connect-default-fallback,s,1)

exten => t,1,Goto(connect-tenant-ivr,${EXTEN},prompt)

[connect-option-router]
exten => s,1,NoOp(Connect option router — tenant=${TENANT_SLUG} digit=${OPT_DIGIT})
 same =>    n,Set(OPT_DEST=${DB(connect/t_${TENANT_SLUG}/opt_${OPT_DIGIT}/dest)})
 same =>    n,Set(OPT_TYPE=${DB(connect/t_${TENANT_SLUG}/opt_${OPT_DIGIT}/type)})
 same =>    n,GotoIf($["${OPT_DEST}" = ""]?fallback)
 same =>    n,NoOp(Connect option routing tenant=${TENANT_SLUG} digit=${OPT_DIGIT} type=${OPT_TYPE} dest=${OPT_DEST})
 same =>    n,GotoIf($["${OPT_TYPE}" = "external_number"]?extnum)
 same =>    n,GotoIf($["${OPT_TYPE}" = "extension"]?wake_then_dial)
 same =>    n,Goto(${OPT_DEST})
 same =>    n(wake_then_dial),Set(__DIAL_TARGET=${OPT_DEST})
 same =>    n,Set(__WAKE_EXT=${CUT(OPT_DEST,\,,2)})
 same =>    n,Goto(connect-dial-with-wake,s,1)
 same =>    n(extnum),Dial(PJSIP/${OPT_DEST},30)
 same =>    n,Hangup()
 same =>    n(fallback),Goto(connect-default-fallback,s,1)

[connect-play-prompt]
; Connect "play a recording" menu key. Reads what to play and where to go
; after from the same per-digit AstDB family the option router used:
;   connect/t_<slug>/opt_<digit>/announce → recording ref (under sounds/)
;   connect/t_<slug>/opt_<digit>/after    → Goto target after playback;
;                                           empty = replay the caller's menu
; Jumping back targets the (prompt) label so the greeting replays without
; re-running Answer/Wait or the once-per-call pre-announce.
exten => s,1,NoOp(Connect play-prompt — tenant=${TENANT_SLUG} digit=${OPT_DIGIT} did=${IVR_DID})
 same =>    n,Set(PP_REF=${DB(connect/t_${TENANT_SLUG}/opt_${OPT_DIGIT}/announce)})
 same =>    n,Set(PP_AFTER=${DB(connect/t_${TENANT_SLUG}/opt_${OPT_DIGIT}/after)})
 same =>    n,GotoIf($["${PP_REF}" = ""]?back)
 same =>    n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PP_REF}.ulaw)}" = "1"]?play)
 same =>    n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PP_REF}.wav)}" = "1"]?play)
 same =>    n,NoOp(Connect play-prompt file missing ref=${PP_REF} — returning to menu)
 same =>    n,Goto(back)
 same =>    n(play),Playback(${PP_REF})
 same =>    n,GotoIf($["${PP_AFTER}" = ""]?back)
 same =>    n,NoOp(Connect play-prompt after — dest=${PP_AFTER})
 same =>    n,Goto(${PP_AFTER})
 same =>    n(back),GotoIf($[$["${IVR_DID}" = ""] | $["${IVR_DID}" = "s"]]?bye)
 same =>    n,Set(RETRIES=0)
 same =>    n,Goto(connect-tenant-ivr,${IVR_DID},prompt)
 same =>    n(bye),Goto(connect-default-fallback,s,1)

[connect-exit-router]
exten => s,1,NoOp(Connect exit router — tenant=${TENANT_SLUG} type=${EXIT_TYPE} dest=${EXIT_DEST})
 same =>    n,GotoIf($["${EXIT_DEST}" = ""]?fallback)
 same =>    n,GotoIf($["${EXIT_TYPE}" = "terminate"]?hangup)
 same =>    n,GotoIf($["${EXIT_TYPE}" = "external_number"]?extnum)
 same =>    n,GotoIf($["${EXIT_TYPE}" = "extension"]?wake_then_dial)
 same =>    n,Goto(${EXIT_DEST})
 same =>    n(wake_then_dial),Set(__DIAL_TARGET=${EXIT_DEST})
 same =>    n,Set(__WAKE_EXT=${CUT(EXIT_DEST,\,,2)})
 same =>    n,Goto(connect-dial-with-wake,s,1)
 same =>    n(extnum),NoOp(Dialing external number ${EXIT_DEST})
 same =>    n,Dial(PJSIP/${EXIT_DEST},30)
 same =>    n,Hangup()
 same =>    n(hangup),NoOp(Terminate destination — hanging up)
 same =>    n,Hangup()
 same =>    n(fallback),Goto(connect-default-fallback,s,1)

[connect-dial-with-wake]
; Entrypoint for the IVR option / exit / direct-dial routers. Inputs UNCHANGED
; (DIAL_TARGET, WAKE_EXT, TENANT_SLUG); output UNCHANGED (Goto ${DIAL_TARGET}).
;
; CANARY GATING (default-closed): only endpoints explicitly enabled in the
; Connect-owned AstDB allowlist
;     connect/wake_canary/T<tid>_<ext> = 1
; use the new single canonical [connect-wake-core] engine (UserEvent + grace
; loop). EVERY other caller falls through to the LEGACY push-wake behavior
; (PJSIP_DIAL_CONTACTS probe + curl + Wait) so existing production IVR wake
; traffic is byte-for-byte unchanged until rollout is widened. A missing key
; (or a missing engine) = legacy. To widen scope: add another allowlist key.
exten => s,1,NoOp(Connect dial-with-wake ext=${WAKE_EXT} target=${DIAL_TARGET} tenant=${TENANT_SLUG})
 same =>   n,GotoIf($["${DIAL_TARGET}" = ""]?missing_target)
 same =>   n,GotoIf($["${WAKE_EXT}" = ""]?dial_now)
 same =>   n,Set(PBX_TENANT_ID=${DB(connect/t_${TENANT_SLUG}/pbx_tenant_id)})
 same =>   n,GotoIf($["${PBX_TENANT_ID}" = ""]?do_wake)
 same =>   n,Set(WAKE_CANARY=${DB(connect/wake_canary/T${PBX_TENANT_ID}_${WAKE_EXT})})
 same =>   n,GotoIf($[$["${WAKE_CANARY}" = "1"] & $[${DIALPLAN_EXISTS(connect-wake-core,s,1)} = 1]]?canary)
 ; ── LEGACY push-wake path (UNCHANGED production behavior) ──────────────────
 same =>   n,Set(EP_PRIMARY=T${PBX_TENANT_ID}_${WAKE_EXT})
 same =>   n,Set(EP_SECONDARY=T${PBX_TENANT_ID}_${WAKE_EXT}_1)
 same =>   n,Set(CONTACTS_PRIMARY=${PJSIP_DIAL_CONTACTS(${EP_PRIMARY})})
 same =>   n,Set(CONTACTS_SECONDARY=${PJSIP_DIAL_CONTACTS(${EP_SECONDARY})})
 same =>   n,NoOp(Wake-skip probe ext=${WAKE_EXT} primary='${CONTACTS_PRIMARY}' secondary='${CONTACTS_SECONDARY}')
 same =>   n,GotoIf($[$[${LEN(${CONTACTS_PRIMARY})} > 0] | $[${LEN(${CONTACTS_SECONDARY})} > 0]]?dial_now)
 same =>   n(do_wake),Set(WAKE_URL=${DB(connect/system/wake_api_url)})
 same =>   n,Set(WAKE_SECRET=${DB(connect/system/wake_api_secret)})
 same =>   n,Set(WAKE_WAIT=${DB(connect/system/wake_wait_secs)})
 same =>   n,Set(WAKE_WAIT=${IF($[${LEN(${WAKE_WAIT})}>0]?${WAKE_WAIT}:6)})
 same =>   n,Set(PBX_TENANT_CODE=${DB(connect/t_${TENANT_SLUG}/pbx_tenant_code)})
 same =>   n,GotoIf($["${WAKE_URL}" = ""]?wait_only)
 same =>   n,Set(WAKE_PAYLOAD={"pbxCallId":"${LINKEDID}"\,"pbxVitalTenantId":"${PBX_TENANT_CODE}"\,"extensionNumber":"${WAKE_EXT}"\,"fromNumber":"${CALLERID(num)}"\,"fromDisplay":"${CALLERID(name)}"})
 same =>   n,NoOp(Wake POST url=${WAKE_URL} payload=${WAKE_PAYLOAD})
 same =>   n,Set(WAKE_RESP=${SHELL(curl --silent --show-error --max-time 3 -X POST '${WAKE_URL}' -H 'content-type: application/json' -H 'x-cdr-secret: ${WAKE_SECRET}' -d '${WAKE_PAYLOAD}' 2>&1)})
 same =>   n,NoOp(Wake response: ${WAKE_RESP})
 same =>   n(wait_only),Wait(${WAKE_WAIT})
 same =>   n(dial_now),NoOp(Dial-with-wake forwarding to ${DIAL_TARGET})
 same =>   n,Goto(${DIAL_TARGET})
 ; ── CANARY path: single canonical engine (UserEvent + grace loop) ─────────
 same =>   n(canary),NoOp(Connect dial-with-wake CANARY → connect-wake-core tid=${PBX_TENANT_ID} ext=${WAKE_EXT})
 same =>   n,Set(__CONNECT_WAKE_DONE=1)
 same =>   n,Gosub(connect-wake-core,s,1(${PBX_TENANT_ID},${WAKE_EXT},1))
 same =>   n,Goto(${DIAL_TARGET})
 same =>   n(missing_target),NoOp(Connect dial-with-wake — DIAL_TARGET not set, falling back)
 same =>   n,Goto(connect-default-fallback,s,1)

[connect-wake-core]
; THE single canonical wake/grace engine. Gosub subroutine; ALWAYS Return()s so
; the caller decides where to go next.
;   ARG1 = numeric VitalPBX tenant id (TID, e.g. 2)
;   ARG2 = extension (EXT, e.g. 110)
;   ARG3 = wake-enabled flag (1 = may wake, anything else = probe-then-return)
; Identity-agnostic: the caller passes tenant id + extension; the engine performs
; NO slug/identity discovery. It is the SOLE owner of: contact probe, warm/cold
; decision, wake emission, ringback, the grace loop, and the grace deadline.
; The wake is a NON-BLOCKING AMI UserEvent (ConnectWake) consumed by the Connect
; telephony service — there is NO synchronous HTTP on the call path. The only
; AstDB read is the caller-INDEPENDENT system grace constant (defaults to 20s).
exten => s,1,NoOp(connect-wake-core tid=${ARG1} ext=${ARG2} wake=${ARG3} state=${CHANNEL(state)})
 same =>   n,Set(TID=${ARG1})
 same =>   n,Set(EXT=${ARG2})
 same =>   n,GotoIf($[$["${TID}" = ""] | $["${EXT}" = ""]]?done)
 ; ── App-reported Do-Not-Disturb short-circuit (Connect-owned mobile-app DND —
 ; NOT the native VitalPBX feature-code DND, which is a separate, unrelated
 ; mechanism). Runs BEFORE the contact probe so a fresh DND=1 never emits
 ; ConnectWake, never starts Playtones, and never enters the grace loop — it
 ; Returns immediately, identical in shape to the (done) no-op exit, so native
 ; VitalPBX call routing (dial / no-answer / voicemail) is the only thing that
 ; runs next.
 ;
 ; FAILS OPEN on every ambiguous case (missing key, "0", missing/malformed
 ; timestamp, future timestamp, or a timestamp older than DND_TTL_SECS) by
 ; falling through to (probe) — the exact unchanged wake/grace/ringback path.
 ; DND_TTL_SECS bounds how long a flag can suppress wake if the app crashes or
 ; is uninstalled before clearing it; 72h is deliberately generous (DND is a
 ; rare, deliberate user action, not a per-call heartbeat) while still
 ; guaranteeing the extension cannot be silently blackholed forever.
 ;
 ; Keys (written by apps/telephony's dnd-publish route, reported by the mobile
 ; app via POST /mobile/dnd-status):
 ;   connect/dnd/T<tid>_<ext>     = "1" | "0"
 ;   connect/dnd_ts/T<tid>_<ext>  = unix epoch seconds of the last report
 same =>   n,Set(DND_TTL_SECS=259200)
 same =>   n,Set(APP_DND=${DB(connect/dnd/T${TID}_${EXT})})
 same =>   n,GotoIf($["${APP_DND}" != "1"]?probe)
 same =>   n,Set(APP_DND_TS=${DB(connect/dnd_ts/T${TID}_${EXT})})
 same =>   n,GotoIf($[${LEN(${APP_DND_TS})} = 0]?probe)
 same =>   n,GotoIf($["${APP_DND_TS}" != "${FILTER(0-9,${APP_DND_TS})}"]?probe)
 same =>   n,Set(APP_DND_AGE=$[${EPOCH} - ${APP_DND_TS}])
 same =>   n,GotoIf($[${APP_DND_AGE} < 0]?probe)
 same =>   n,GotoIf($[${APP_DND_AGE} > ${DND_TTL_SECS}]?probe)
 same =>   n,NoOp(connect-wake-core app DND active ext=${EXT} age=${APP_DND_AGE}s — skipping wake/grace/ringback, handing back immediately)
 same =>   n,Return()
 same =>   n(probe),Set(EP_PRIMARY=T${TID}_${EXT})
 same =>   n,Set(EP_SECONDARY=T${TID}_${EXT}_1)
 same =>   n,Set(CONTACTS_PRIMARY=${PJSIP_DIAL_CONTACTS(${EP_PRIMARY})})
 same =>   n,Set(CONTACTS_SECONDARY=${PJSIP_DIAL_CONTACTS(${EP_SECONDARY})})
 same =>   n,NoOp(connect-wake-core probe ext=${EXT} primary='${CONTACTS_PRIMARY}' secondary='${CONTACTS_SECONDARY}')
 same =>   n,Set(WARM=${IF($[$[${LEN(${CONTACTS_PRIMARY})} > 0] | $[${LEN(${CONTACTS_SECONDARY})} > 0]]?1:0)})
 same =>   n,GotoIf($["${ARG3}" != "1"]?done)
 ; ── single wake emission: warm AND cold reach here exactly once (fire-and-forget) ──
 same =>   n,UserEvent(ConnectWake,Tenant: ${TID},Extension: ${EXT},CallId: ${IF($["${CHANNEL(linkedid)}" != ""]?${CHANNEL(linkedid)}:${UNIQUEID})},From: ${CALLERID(num)})
 same =>   n,GotoIf($["${WARM}" = "1"]?warm)
 ; ── cold endpoint only: ringback + grace loop ──
 same =>   n,Set(GRACE=${DB(connect/system/wake_grace_secs)})
 same =>   n,Set(GRACE=${IF($[${LEN(${GRACE})} > 0]?${GRACE}:20)})
 ; Unanswered legs (direct dial) get standard early-media 180 ringback.
 same =>   n,ExecIf($["${CHANNEL(state)}" != "Up"]?Progress())
 same =>   n,ExecIf($["${CHANNEL(state)}" != "Up"]?Ringing())
 ; Already-answered legs (e.g. arriving via the IVR) are past SIP answer and
 ; cannot send a 180, so inject an in-band ringback cadence for the grace wait —
 ; otherwise the caller hears dead air until the endpoint registers or grace
 ; expires. Stopped on every cold exit below before the caller Dials.
 same =>   n,ExecIf($["${CHANNEL(state)}" = "Up"]?Playtones(ring))
 same =>   n,Set(GRACE_LEFT=${GRACE})
 same =>   n(loop),GotoIf($[${GRACE_LEFT} <= 0]?expired)
 same =>   n,Wait(1)
 same =>   n,Set(CONTACTS_PRIMARY=${PJSIP_DIAL_CONTACTS(${EP_PRIMARY})})
 same =>   n,Set(CONTACTS_SECONDARY=${PJSIP_DIAL_CONTACTS(${EP_SECONDARY})})
 same =>   n,GotoIf($[$[${LEN(${CONTACTS_PRIMARY})} > 0] | $[${LEN(${CONTACTS_SECONDARY})} > 0]]?registered)
 same =>   n,Set(GRACE_LEFT=$[${GRACE_LEFT} - 1])
 same =>   n,Goto(loop)
 same =>   n(registered),NoOp(connect-wake-core contact registered during grace ext=${EXT})
 same =>   n,StopPlaytones()
 same =>   n,Return()
 same =>   n(expired),NoOp(connect-wake-core grace expired ext=${EXT})
 same =>   n,StopPlaytones()
 same =>   n,Return()
 same =>   n(warm),NoOp(connect-wake-core warm — live contact ext=${EXT} (ConnectWake emitted fire-and-forget, no grace wait))
 same =>   n,Return()
 same =>   n(done),NoOp(connect-wake-core no-op ext=${EXT} reason=missing-args-or-wake-disabled)
 same =>   n,Return()

[connect-hold-announce]
exten => s,1,NoOp(Connect hold announce — tenant=${TENANT_SLUG})
 same =>    n,GotoIf($["${TENANT_SLUG}" = ""]?hangup)
 same =>    n,Set(FAMILY=connect/t_${TENANT_SLUG})
 same =>    n,ExecIf($["${HOLD_ANNOUNCE}" = ""]?Set(HOLD_ANNOUNCE=${DB(${FAMILY}/hold_announce)}))
 same =>    n,ExecIf($["${HOLD_REPEAT}" = ""]?Set(HOLD_REPEAT=${DB(${FAMILY}/hold_repeat)}))
 same =>    n,Set(HOLD_REPEAT=${IF($[${LEN(${HOLD_REPEAT})}>0]?${HOLD_REPEAT}:30)})
 same =>    n,ExecIf($[${HOLD_REPEAT} < 10]?Set(HOLD_REPEAT=10))
 same =>    n,GotoIf($["${HOLD_ANNOUNCE}" = ""]?hangup)
 same =>    n,Answer()
 same =>    n(loop),Playback(${HOLD_ANNOUNCE})
 same =>    n,Wait(${HOLD_REPEAT})
 same =>    n,Goto(loop)
 same =>    n(hangup),Hangup()

; ── Connect sub-file includes (this file is the include hub for Connect dialplan)
; MOH shim is a core Connect feature and MUST be re-included on every regen of
; this file (its absence silently breaks tenant MOH). The cos-wake overlay is an
; OPTIONAL canary file, so it uses #tryinclude (no error if it is absent or has
; been rolled back).
#include extensions__65_connect_tenant_moh.conf
#tryinclude extensions__66_connect_cos_wake.conf
CONNECT_DP_EOF

# ── 5. Append preserved non-Connect contexts ────────────────────────────────
step "[4/9] Append preserved non-Connect contexts"
if [[ -s "$TMP_PRESERVED" ]]; then
  printf '\n;; ── Preserved non-Connect contexts (auto-restored from backup) ──\n' >> "$TMP_NEW"
  cat "$TMP_PRESERVED" >> "$TMP_NEW"
  echo "  ↳ appended"
else
  echo "  ↳ none to preserve"
fi

# ── 6. Install + permissions ────────────────────────────────────────────────
step "[5/9] Install new dialplan + set permissions"
mv "$TMP_NEW" "$DIALPLAN_FILE"
chown asterisk:asterisk "$DIALPLAN_FILE"
chmod 0644 "$DIALPLAN_FILE"
echo "  ↳ wrote $DIALPLAN_FILE ($(wc -l < "$DIALPLAN_FILE" | tr -d ' ') lines)"

# ── 7. Reload Asterisk dialplan ────────────────────────────────────────────
step "[6/9] Reload Asterisk dialplan"
RELOAD_OUT="$(asterisk -rx 'dialplan reload' 2>&1 || true)"
echo "  ↳ $RELOAD_OUT"

# Verify the new contexts are loaded. The contact-probe now lives ONLY in the
# canonical [connect-wake-core] engine; [connect-dial-with-wake] is a thin
# wrapper that Gosubs it. Verify both.
step "[7/9] Verify [connect-wake-core] + [connect-dial-with-wake] are loaded"
CORE_OUT="$(asterisk -rx 'dialplan show connect-wake-core' 2>&1 || true)"
WRAP_OUT="$(asterisk -rx 'dialplan show connect-dial-with-wake' 2>&1 || true)"
if echo "$CORE_OUT" | grep -q "PJSIP_DIAL_CONTACTS" \
   && echo "$WRAP_OUT" | grep -q "connect-wake-core"; then
  echo "  ↳ OK — [connect-wake-core] engine + thin [connect-dial-with-wake] wrapper loaded"
else
  warn "Wake contexts not correctly loaded after reload. Output was:"
  echo "  --- connect-wake-core ---";      echo "$CORE_OUT" | head -20
  echo "  --- connect-dial-with-wake ---"; echo "$WRAP_OUT" | head -20
  warn "Restoring backup: $BACKUP_FILE"
  cp -a "$BACKUP_FILE" "$DIALPLAN_FILE"
  asterisk -rx "dialplan reload" >/dev/null 2>&1 || true
  die "Dialplan reload failed — restored backup."
fi

# ── 8. Bootstrap AstDB wake config via Connect API (optional) ──────────────
step "[8/9] Bootstrap AstDB wake config via Connect API"
CONNECT_API_BASE="${CONNECT_API_BASE:-https://app.connectcomunications.com/api}"
CONNECT_API_BASE="${CONNECT_API_BASE%/}"
if [[ -z "${CONNECT_CDR_SECRET:-}" ]]; then
  warn "CONNECT_CDR_SECRET not set — skipping AstDB bootstrap."
  echo "  ↳ Run later:"
  echo "      curl -sS -X POST '${CONNECT_API_BASE}/internal/pbx/publish-wake-config' \\"
  echo "        -H 'content-type: application/json' -H 'x-cdr-secret: <SECRET>' \\"
  echo "        -d '{\"tenantId\":\"<connect-tenant-uuid>\"}'"
else
  PUBLISH_BODY='{}'
  if [[ -n "${CONNECT_TENANT_ID:-}" ]]; then
    PUBLISH_BODY="{\"tenantId\":\"${CONNECT_TENANT_ID}\"}"
  fi
  PUBLISH_RESP="$(curl --silent --show-error --max-time 8 \
    -X POST "${CONNECT_API_BASE}/internal/pbx/publish-wake-config" \
    -H "content-type: application/json" \
    -H "x-cdr-secret: ${CONNECT_CDR_SECRET}" \
    -d "$PUBLISH_BODY" 2>&1 || true)"
  echo "  ↳ POST publish-wake-config → $PUBLISH_RESP"
fi

# ── 9. Smoke-test AstDB keys ───────────────────────────────────────────────
step "[9/9] Smoke-test AstDB keys"
echo "  ↳ connect/system family:"
asterisk -rx 'database show connect/system' 2>&1 | sed 's/^/      /'
if [[ -n "${CONNECT_TENANT_SLUG:-}" ]]; then
  echo "  ↳ connect/t_${CONNECT_TENANT_SLUG} pbx_tenant_* keys:"
  asterisk -rx "database show connect/t_${CONNECT_TENANT_SLUG}" 2>&1 \
    | grep -E '/pbx_tenant_(id|code)' | sed 's/^/      /' || echo "      (no pbx_tenant_* keys yet)"
fi

cat <<DONE

============================================================================
INSTALL COMPLETE.

Backup of previous dialplan: $BACKUP_FILE

Next steps:
  • Confirm a test inbound call to a Connect-routed DID:
      - Routes to [connect-tenant-ivr] (or [connect-tenant-router]).
      - Press an option that maps to an extension.
      - Watch the live console for "Wake-skip probe" / "Wake POST" NoOp lines:
            asterisk -rvvv
  • In Connect Diagnostics → Call Wake — Timeline you should see:
      WAKE_HTTP_RECEIVED → WAKE_PUSH_QUEUED → DEVICE_PUSH_RECEIVED → ...

If the AstDB bootstrap was skipped, run the curl shown in step [8/9]
once you have CONNECT_CDR_SECRET handy. The dialplan still loads but
the wake step is a no-op until 'connect/system/wake_api_url' is set.
============================================================================
DONE
