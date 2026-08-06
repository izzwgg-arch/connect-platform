#!/usr/bin/env bash
# ══ NUMBER → IVR POINTING STRESS ════════════════════════════════════════════
#
# The single question this answers, over and over: when a number is pointed at
# a menu, does a caller land on THAT menu — and never on any other menu, any
# other tenant, or the default fallback?
#
# Owner's report: "even though the number comes over, sometimes it is not
# pointing to the right place." So this exercises the whole journey, not just
# the steady state:
#   • re-point a live number across several menus, back and forth
#   • hand the number back to the PBX and bring it over again (the doorway
#     flip through the REAL switch routes), then check where it lands
#   • two numbers on two different tenants, hammered alternately, each of which
#     must never see the other's menus (cross-tenant isolation)
# Every check carries a NEGATIVE assertion: reaching the wrong menu, the wrong
# tenant, or connect-default-fallback is a FAILURE, not just a missing PASS.
set -uo pipefail

LK="C:/Users/izzyw/.ssh/connect2_ed25519"
PK="C:/Users/izzyw/.ssh/connect2_server2_ed25519"
LOOP="root@45.14.194.179"; PBX="root@209.145.60.79"

# tenant A — Connect Communications
A_TENANT="cmqzfigij4bt0mw13u2ulpd0t"; A_DID="8457231213"; A_MAPPING="cmsg79jlv048bll1490jrjyyd"
A_SLUG="connect_communications"
A_MENUS=("cmseuklc80001o7133ke49etw" "cmsewyudm02bon013f8svvk56" "cmsgpf6qz07gwmg13rxb6kt6o")
# tenant B — A plus center
B_TENANT="cmnlgnumi0000p9g6l7t1t0z7"; B_DID="8457823064"; B_MAPPING="cmsdsxlbo00jgoy13jlndfst4"
B_SLUG="a_plus_center"
B_MENUS=("cmsdsxl9h00j0oy13ghzto7po" "cmsdsxlac00j5oy13u09wabnz" "cmsdsxlan00jcoy13wo0xu5u2")

ROUNDS="${1:-5}"
SEC=$(ssh -i "$LK" -o IdentitiesOnly=yes "$LOOP" 'grep -m1 "^AGENT_INTERNAL_SECRET=" /opt/connectcomms/env/.env.platform | cut -d= -f2-')
PASS=0; FAIL=0; FAILED=""

prisma() { ssh -i "$LK" -o IdentitiesOnly=yes "$LOOP" "docker exec -i -w /app/packages/db app-api-1 node -e '$1'" 2>&1; }

point() { # mappingId profileId  — point a number at a menu, verified
  local want="$2" got
  for attempt in 1 2; do
    got=$(prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didRouteMapping.update({where:{id:\"$1\"},data:{ivrProfileId:\"$want\"}}).then(r=>{console.log(r.ivrProfileId);return p.\$disconnect()}).catch(e=>{console.log(\"ERR \"+e.message);process.exit(1)})" | tr -d '\r\n ')
    [ "$got" = "$want" ] && return 0
  done
  FAIL=$((FAIL+1)); FAILED="$FAILED
      - could not point mapping $1 at $want (got $got)"
  echo "    FAIL  pointing mapping $1 -> got '$got'"
  return 1
}

publish() { # tenantId profileId — publish via a no-op greeting re-set
  # NOTE: set_exit with null destinationType is REJECTED by the request schema
  # (optional enum, not nullable), which made this fail silently and skip every
  # pointing check. Re-setting the profile's CURRENT greeting is a true no-op
  # that still runs the full production publish.
  local tid="$1" prof="$2" cur r
  cur=$(prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.ivrRouteProfile.findUnique({where:{id:\"$prof\"}}).then(x=>{console.log(x&&x.pbxPromptRef?x.pbxPromptRef:\"\");return p.\$disconnect()})" | tr -d '\r\n ')
  if [ -z "$cur" ]; then
    FAIL=$((FAIL+1)); FAILED="$FAILED
      - publish skipped: menu $prof has no greeting to re-set"
    echo "    FAIL  publish (menu $prof has no greeting)"; return 1
  fi
  r=$(ssh -i "$LK" -o IdentitiesOnly=yes "$LOOP" "curl -s -m 200 -X POST http://127.0.0.1:3001/internal/agent/ivr/action -H 'x-agent-internal-secret: $SEC' -H 'content-type: application/json' -d '{\"tenantId\":\"$tid\",\"profileId\":\"$prof\",\"agentActionId\":\"point-$(date +%s%N)\",\"action\":\"set_prompt\",\"promptSlot\":\"greeting\",\"promptRef\":\"$cur\"}'")
  if echo "$r" | grep -q '"ok":true'; then return 0; fi
  FAIL=$((FAIL+1)); FAILED="$FAILED
      - publish failed for tenant $tid: $(echo "$r" | head -c 140)"
  echo "    FAIL  publish -> $(echo "$r" | head -c 120)"
  return 1
}

lands_on() { # label did wantMenu forbiddenRegex
  local label="$1" did="$2" want="$3" forbid="$4" out
  out=$(ssh -i "$PK" -o IdentitiesOnly=yes "$PBX" "bash /root/ivr-e2e.sh $did 'm${want}@connect-menu' '' 12 '$forbid'" 2>&1)
  if echo "$out" | grep -q "^PASS"; then PASS=$((PASS+1)); echo "    PASS  $label"
  else FAIL=$((FAIL+1)); FAILED="$FAILED
      - $label"; echo "    FAIL  $label"; echo "$out" | head -5 | sed 's/^/          /'; fi
}

# Everything this number must NEVER touch: the other tenant's slug, and the
# global fallback (which is where a mis-pointed number ends up).
forbidden_for() { # slugOfOtherTenant  otherMenusSpaceSeparated
  local other="$1"; shift
  local pat="connect-default-fallback|tenant=${other}"
  for m in "$@"; do pat="$pat|m${m}@connect-menu"; done
  echo "$pat"
}

mode_of() { # mappingId
  prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didRouteMapping.findUnique({where:{id:\"$1\"}}).then(m=>{console.log(m.routingMode);return p.\$disconnect()})" | tr -d '\r\n '
}

ensure_connect() { # mappingId label — a pointing test is meaningless if the
  # number is still handed back to the PBX. Establish the precondition instead
  # of assuming it: a leftover hand-back from an interrupted run sent the first
  # two checks to PBX voicemail and looked like a product failure.
  local m; m=$(mode_of "$1")
  [ "$m" = "connect" ] && return 0
  echo "    ..  $2 is on the PBX — bringing it over before testing"
  prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didSwitchSchedule.updateMany({where:{mappingId:\"$1\"},data:{status:\"pending\",activateAt:new Date(),endAt:null,activatedAt:null,endedAt:null,lastError:null}}).then(x=>{console.log(x.count);return p.\$disconnect()})" >/dev/null
  for w in 1 2 3 4 5 6; do
    sleep 20
    m=$(mode_of "$1")
    [ "$m" = "connect" ] && return 0
  done
  FAIL=$((FAIL+1)); FAILED="$FAILED
      - $2 could not be brought over to Connect (stuck on $m)"
  echo "    FAIL  $2 stuck on $m"
  return 1
}

echo "########## NUMBER→IVR POINTING STRESS — $ROUNDS rounds ##########"
for r in $(seq 1 "$ROUNDS"); do
  echo "═══ round $r/$ROUNDS ═══"
  ensure_connect "$A_MAPPING" "A number"
  ensure_connect "$B_MAPPING" "B number"

  # ── A: point across every menu, each must land exactly there ──────────────
  for i in "${!A_MENUS[@]}"; do
    want="${A_MENUS[$i]}"
    others=""
    for j in "${!A_MENUS[@]}"; do [ "$j" != "$i" ] && others="$others ${A_MENUS[$j]}"; done
    point "$A_MAPPING" "$want" && publish "$A_TENANT" "${A_MENUS[0]}" \
      && lands_on "A number -> menu $((i+1)) only" "$A_DID" "$want" "$(forbidden_for "$B_SLUG" $others)"
  done

  # ── B: same, on the other tenant ──────────────────────────────────────────
  for i in "${!B_MENUS[@]}"; do
    want="${B_MENUS[$i]}"
    others=""
    for j in "${!B_MENUS[@]}"; do [ "$j" != "$i" ] && others="$others ${B_MENUS[$j]}"; done
    point "$B_MAPPING" "$want" && publish "$B_TENANT" "${B_MENUS[0]}" \
      && lands_on "B number -> menu $((i+1)) only" "$B_DID" "$want" "$(forbidden_for "$A_SLUG" $others)"
  done

  # ── cross-tenant isolation, back to back ──────────────────────────────────
  point "$A_MAPPING" "${A_MENUS[0]}" && publish "$A_TENANT" "${A_MENUS[0]}"
  point "$B_MAPPING" "${B_MENUS[0]}" && publish "$B_TENANT" "${B_MENUS[0]}"
  lands_on "A stays on A after B published" "$A_DID" "${A_MENUS[0]}" "$(forbidden_for "$B_SLUG" "${B_MENUS[@]}")"
  lands_on "B stays on B after A published" "$B_DID" "${B_MENUS[0]}" "$(forbidden_for "$A_SLUG" "${A_MENUS[@]}")"

  # ── the doorway round trip: hand back to the PBX, bring it over again ─────
  # This is the "the number comes over but points somewhere else" path.
  sched=$(prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didSwitchSchedule.updateMany({where:{mappingId:\"$A_MAPPING\"},data:{status:\"activated\",endAt:new Date()}}).then(x=>{console.log(\"ended:\"+x.count);return p.\$disconnect()})" | tr -d '\r')
  echo "    ..  handing A back to the PBX ($sched)"
  for w in 1 2 3 4 5 6; do
    mode=$(prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didRouteMapping.findUnique({where:{id:\"$A_MAPPING\"}}).then(m=>{console.log(m.routingMode);return p.\$disconnect()})" | tr -d '\r\n ')
    [ "$mode" = "pbx" ] && break
    sleep 20
  done
  if [ "$mode" = "pbx" ]; then
    out=$(ssh -i "$PK" -o IdentitiesOnly=yes "$PBX" "bash /root/ivr-e2e.sh $A_DID 'INBOUND_ROUTE' '' 10 'connect-menu'" 2>&1)
    if echo "$out" | grep -q "^PASS"; then PASS=$((PASS+1)); echo "    PASS  handed back: caller no longer reaches any Connect menu"
    else FAIL=$((FAIL+1)); FAILED="$FAILED
      - hand-back left the caller on Connect"; echo "    FAIL  hand-back"; echo "$out" | head -4 | sed 's/^/          /'; fi
  else
    FAIL=$((FAIL+1)); FAILED="$FAILED
      - hand-back never completed (still $mode)"; echo "    FAIL  hand-back never completed (mode=$mode)"
  fi

  # bring it back over, pointed at a SPECIFIC menu, and check where it lands
  target="${A_MENUS[1]}"
  point "$A_MAPPING" "$target"
  prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didSwitchSchedule.updateMany({where:{mappingId:\"$A_MAPPING\"},data:{status:\"pending\",activateAt:new Date(),endAt:null,activatedAt:null,endedAt:null,lastError:null}}).then(x=>{console.log(\"armed:\"+x.count);return p.\$disconnect()})" >/dev/null
  echo "    ..  bringing A back over to Connect"
  for w in 1 2 3 4 5 6; do
    mode=$(prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didRouteMapping.findUnique({where:{id:\"$A_MAPPING\"}}).then(m=>{console.log(m.routingMode);return p.\$disconnect()})" | tr -d '\r\n ')
    [ "$mode" = "connect" ] && break
    sleep 20
  done
  if [ "$mode" = "connect" ]; then
    publish "$A_TENANT" "${A_MENUS[0]}"
    others=""; for j in "${!A_MENUS[@]}"; do [ "${A_MENUS[$j]}" != "$target" ] && others="$others ${A_MENUS[$j]}"; done
    lands_on "came over -> lands on the menu it was pointed at" "$A_DID" "$target" "$(forbidden_for "$B_SLUG" $others)"
  else
    FAIL=$((FAIL+1)); FAILED="$FAILED
      - switch back to Connect never completed (still $mode)"; echo "    FAIL  switch back never completed (mode=$mode)"
  fi
done

# leave both numbers on their normal menus
point "$A_MAPPING" "${A_MENUS[0]}" && publish "$A_TENANT" "${A_MENUS[0]}"
point "$B_MAPPING" "${B_MENUS[0]}" && publish "$B_TENANT" "${B_MENUS[0]}"

echo "################################################################"
echo "TOTAL: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -gt 0 ] && { echo "FAILURES:$FAILED"; exit 1; }
echo "ALL GREEN"
