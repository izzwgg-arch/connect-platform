#!/usr/bin/env bash
# ── Teach the Connect IVR real submenu navigation ────────────────────────────
#
# ⛔ PBX WRITE. Run on the PBX host (209.145.60.79) as root, under Izzy's
#    mandate (2026-08-06: "navigating between keys should work properly").
#
# Why: "press N → another menu" keys were DEAD. The Studio stored them as
# Goto(connect-tenant-ivr,<profileId>,1) — but that context only matches digit
# extens, so a cuid exten matched nothing, ever. And menus were tenant-global
# (one active_prompt), so there was nothing for a submenu to read anyway.
#
# The fix is two-sided and deliberately ADDITIVE:
#   • Connect now publishes EVERY menu under connect/t_<slug>/menu/<id>/* and
#    rewrites ivr-type refs to Goto(connect-menu,m<id>,1) at publish time.
#   • This patch appends THREE new contexts that read those families:
#       [connect-menu]               — the submenu engine (exten = m-<id>)
#       [connect-menu-option-router] — digit dispatch inside a submenu
#       [connect-menu-play-prompt]   — per-menu "play a recording" keys
#    NOTHING in the existing contexts is edited. Until Connect publishes the
#    new families and refs, these contexts are unreachable dead weight — the
#    same inert-until-published rollout the play-prompt patch used.
#
# The m- exten prefix is LOAD-BEARING: without it, a digit press inside a menu
# is a prefix of the menu-id pattern and Asterisk holds every keypress for the
# inter-digit timeout. Do not "clean it up".
#
# Discipline (same as every dialplan touch on this box):
#   • timestamped backup next to the file
#   • idempotent — refuses to double-apply
#   • verifies the context is visible after reload, restores backup if not
#   • `dialplan reload` only, never a full restart, never Apply Changes
#
set -euo pipefail

FILE="/etc/asterisk/extensions__60_custom.conf"
STAMP="$(date +%Y%m%dT%H%M%SZ)"

[ -f "$FILE" ] || { echo "FATAL: $FILE not found"; exit 1; }

if grep -q "\[connect-menu\]" "$FILE"; then
  echo "Already applied — $FILE has [connect-menu]. Nothing done."
  exit 0
fi

cp -a "$FILE" "$FILE.bak.connect-menu.$STAMP"
echo "Backup: $FILE.bak.connect-menu.$STAMP"

cat >> "$FILE" <<'DIALPLAN'

[connect-menu]
; Connect submenu engine (2026-08-06). exten = m<IVR profile id> (hyphen-free: Asterisk strips - in patterns); reads the
; per-menu AstDB family connect/t_<slug>/menu/<id>/* that Connect publishes.
; Entered via Goto(connect-menu,m<id>,1) from any option/exit router. The
; m- prefix keeps single digit presses from prefix-colliding with this
; pattern (which would add inter-digit-timeout lag to every keypress).
exten => _m.,1,NoOp(Connect submenu — tenant=${TENANT_SLUG} menu=${EXTEN})
 same =>       n,GotoIf($["${TENANT_SLUG}" = ""]?dead)
 same =>       n,Set(MENU_FAMILY=connect/t_${TENANT_SLUG}/menu/${EXTEN:1})
 same =>       n,Set(CUR_MENU=${EXTEN})
 same =>       n,Set(M_GREETING=${DB(${MENU_FAMILY}/prompt)})
 same =>       n,Set(M_INVALID_PROMPT=${DB(${MENU_FAMILY}/prompt_invalid)})
 same =>       n,Set(M_TIMEOUT_PROMPT=${DB(${MENU_FAMILY}/prompt_timeout)})
 same =>       n,Set(M_RETRY_PROMPT=${DB(${MENU_FAMILY}/prompt_retry)})
 same =>       n,Set(M_T=${DB(${MENU_FAMILY}/timeout_seconds)})
 same =>       n,Set(M_RMAX=${DB(${MENU_FAMILY}/max_retries)})
 same =>       n,Set(M_T=${IF($[${LEN(${M_T})}>0]?${M_T}:7)})
 same =>       n,Set(M_RMAX=${IF($[${LEN(${M_RMAX})}>0]?${M_RMAX}:3)})
 same =>       n,Set(M_RETRIES=0)
 ; An empty greeting does NOT mean a dead menu — only an UNPUBLISHED one does.
 ; max_retries is written for every published menu, so it is the "this menu
 ; exists" marker. Without this split, a customer who creates a menu and hasn't
 ; recorded its greeting yet drops callers to goodbye (proven live 2026-08-06).
 same =>       n,Set(M_PUBLISHED=${DB(${MENU_FAMILY}/max_retries)})
 same =>       n,GotoIf($["${M_GREETING}" = ""]?nogreet)
 same =>       n(prompt),GotoIf($[${M_RETRIES} > 0 & ${LEN(${M_RETRY_PROMPT})} > 0]?try_retry)
 same =>       n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_GREETING}.ulaw)}" = "1"]?play_greet)
 same =>       n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_GREETING}.wav)}" = "1"]?play_greet)
 same =>       n,NoOp(Connect submenu greeting missing ref=${M_GREETING} — generic)
 same =>       n,Playback(one-moment-please)
 same =>       n,Goto(waitdigit)
 same =>       n(play_greet),Background(${M_GREETING})
 same =>       n,Goto(waitdigit)
 same =>       n(try_retry),GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_RETRY_PROMPT}.ulaw)}" = "1"]?play_retry)
 same =>       n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_RETRY_PROMPT}.wav)}" = "1"]?play_retry)
 same =>       n,Goto(play_greet)
 same =>       n(play_retry),Background(${M_RETRY_PROMPT})
 same =>       n(waitdigit),WaitExten(${M_T})
 ; No t exten in this context ON PURPOSE — WaitExten timeout falls through
 ; here so the retry counter actually increments.
 same =>       n,Set(M_RETRIES=$[${M_RETRIES}+1])
 same =>       n,GotoIf($[${M_RETRIES} >= ${M_RMAX}]?exhausted)
 same =>       n,GotoIf($["${M_TIMEOUT_PROMPT}" = ""]?prompt)
 same =>       n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_TIMEOUT_PROMPT}.ulaw)}" = "1"]?play_to)
 same =>       n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_TIMEOUT_PROMPT}.wav)}" = "1"]?play_to)
 same =>       n,Goto(prompt)
 same =>       n(play_to),Background(${M_TIMEOUT_PROMPT})
 same =>       n,Goto(waitdigit)
 same =>       n(exhausted),Set(EXIT_TYPE=${DB(${MENU_FAMILY}/dest_timeout_type)})
 same =>       n,Set(EXIT_DEST=${DB(${MENU_FAMILY}/dest_timeout)})
 same =>       n,GotoIf($["${EXIT_DEST}" = ""]?fallback)
 same =>       n,NoOp(Connect submenu exhausted on timeout — type=${EXIT_TYPE} dest=${EXIT_DEST})
 same =>       n,Goto(connect-exit-router,s,1)
 same =>       n(fallback),Goto(connect-default-fallback,s,1)
 same =>       n(nogreet),GotoIf($["${M_PUBLISHED}" = ""]?dead)
 same =>       n,NoOp(Connect submenu ${CUR_MENU} has no greeting recorded yet - serving its keys)
 same =>       n,Playback(one-moment-please)
 same =>       n,Goto(waitdigit)
 same =>       n(dead),NoOp(Connect submenu ${EXTEN} unpublished or no slug — tenant fallback)
 same =>       n,Goto(connect-default-fallback,s,1)

exten => 0,1,Set(OPT_DIGIT=0)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 1,1,Set(OPT_DIGIT=1)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 2,1,Set(OPT_DIGIT=2)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 3,1,Set(OPT_DIGIT=3)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 4,1,Set(OPT_DIGIT=4)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 5,1,Set(OPT_DIGIT=5)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 6,1,Set(OPT_DIGIT=6)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 7,1,Set(OPT_DIGIT=7)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 8,1,Set(OPT_DIGIT=8)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => 9,1,Set(OPT_DIGIT=9)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => *,1,Set(OPT_DIGIT=star)
 same =>    n,Goto(connect-menu-option-router,s,1)
exten => #,1,Set(OPT_DIGIT=hash)
 same =>    n,Goto(connect-menu-option-router,s,1)

exten => i,1,NoOp(Connect submenu invalid — menu=${CUR_MENU} retries=${M_RETRIES})
 same =>   n,Set(M_RETRIES=$[${M_RETRIES}+1])
 same =>   n,GotoIf($[${M_RETRIES} >= ${M_RMAX}]?exhausted_i)
 same =>   n,GotoIf($["${M_INVALID_PROMPT}" = ""]?back)
 same =>   n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_INVALID_PROMPT}.ulaw)}" = "1"]?play_i)
 same =>   n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${M_INVALID_PROMPT}.wav)}" = "1"]?play_i)
 same =>   n,Goto(back)
 same =>   n(play_i),Background(${M_INVALID_PROMPT})
 same =>   n(back),Goto(connect-menu,${CUR_MENU},prompt)
 same =>   n(exhausted_i),Set(EXIT_TYPE=${DB(${MENU_FAMILY}/dest_invalid_type)})
 same =>   n,Set(EXIT_DEST=${DB(${MENU_FAMILY}/dest_invalid)})
 same =>   n,GotoIf($["${EXIT_DEST}" = ""]?fb)
 same =>   n,Goto(connect-exit-router,s,1)
 same =>   n(fb),Goto(connect-default-fallback,s,1)

[connect-menu-option-router]
; Digit dispatch inside a submenu — reads ${MENU_FAMILY}/opt_<digit>/* set by
; [connect-menu]. An unconfigured digit is treated as invalid (replay the
; menu), NOT as a hangup — submenu callers always have somewhere to go.
exten => s,1,NoOp(Connect submenu option — menu=${CUR_MENU} digit=${OPT_DIGIT})
 same =>    n,Set(OPT_DEST=${DB(${MENU_FAMILY}/opt_${OPT_DIGIT}/dest)})
 same =>    n,Set(OPT_TYPE=${DB(${MENU_FAMILY}/opt_${OPT_DIGIT}/type)})
 same =>    n,GotoIf($["${OPT_DEST}" = ""]?invalid)
 same =>    n,NoOp(Connect submenu routing menu=${CUR_MENU} digit=${OPT_DIGIT} type=${OPT_TYPE} dest=${OPT_DEST})
 same =>    n,Set(M_RETRIES=0)
 same =>    n,GotoIf($["${OPT_TYPE}" = "external_number"]?extnum)
 same =>    n,GotoIf($["${OPT_TYPE}" = "extension"]?wake_then_dial)
 same =>    n,Goto(${OPT_DEST})
 same =>    n(wake_then_dial),Set(__DIAL_TARGET=${OPT_DEST})
 same =>    n,Set(__WAKE_EXT=${CUT(OPT_DEST,\,,2)})
 same =>    n,Goto(connect-dial-with-wake,s,1)
 same =>    n(extnum),Dial(PJSIP/${OPT_DEST},30)
 same =>    n,Hangup()
 same =>    n(invalid),Goto(connect-menu,i,1)

[connect-menu-play-prompt]
; Per-menu "play a recording" key — same contract as [connect-play-prompt]
; but reads ${MENU_FAMILY} opt keys and returns to the submenu, not the top
; menu. Connect rewrites recording dests inside menu families to point here.
exten => s,1,NoOp(Connect submenu play-prompt menu=${CUR_MENU} digit=${OPT_DIGIT})
 same =>    n,Set(PP_REF=${DB(${MENU_FAMILY}/opt_${OPT_DIGIT}/announce)})
 same =>    n,Set(PP_AFTER=${DB(${MENU_FAMILY}/opt_${OPT_DIGIT}/after)})
 same =>    n,GotoIf($["${PP_REF}" = ""]?back)
 same =>    n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PP_REF}.ulaw)}" = "1"]?play)
 same =>    n,GotoIf($["${STAT(e,/var/lib/asterisk/sounds/${PP_REF}.wav)}" = "1"]?play)
 same =>    n,NoOp(Connect submenu play-prompt file missing ref=${PP_REF} — back to menu)
 same =>    n,Goto(back)
 same =>    n(play),Playback(${PP_REF})
 same =>    n,GotoIf($["${PP_AFTER}" = ""]?back)
 same =>    n,NoOp(Connect submenu play-prompt after dest=${PP_AFTER})
 same =>    n,Goto(${PP_AFTER})
 same =>    n(back),Set(M_RETRIES=0)
 same =>    n,Goto(connect-menu,${CUR_MENU},prompt)
DIALPLAN

echo "Contexts appended. Reloading dialplan…"
asterisk -rx "dialplan reload" >/dev/null

# The play-prompt patch's 1s verify raced the reload and self-rolled-back on a
# false negative (2026-08-05, twice). Give the reload real room: up to 4
# checks, 3s apart, before declaring failure.
VISIBLE=""
for attempt in 1 2 3 4; do
  sleep 3
  if asterisk -rx "dialplan show connect-menu" 2>/dev/null | grep -q "Context .connect-menu."; then
    VISIBLE=yes
    break
  fi
  echo "verify attempt $attempt: not visible yet…"
done
if [ "$VISIBLE" = "yes" ]; then
  echo "OK: [connect-menu] is live in the running dialplan."
else
  echo "FATAL: [connect-menu] not visible after reload — RESTORING BACKUP."
  cp -a "$FILE.bak.connect-menu.$STAMP" "$FILE"
  asterisk -rx "dialplan reload" >/dev/null
  exit 1
fi
if asterisk -rx "dialplan show connect-menu-option-router" 2>/dev/null | grep -q "OPT_DIGIT"; then
  echo "OK: [connect-menu-option-router] live."
else
  echo "WARN: option router not visible — inspect manually."
fi
echo "Done. Submenus stay inert until Connect publishes menu families + m- refs."