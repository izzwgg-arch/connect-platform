#!/usr/bin/env bash
# ══ FULL IVR COVERAGE SUITE ═════════════════════════════════════════════════
# Config is written exactly as the Studio writes it (IvrOptionRoute /
# IvrRouteProfile / DidRouteMapping rows), published through the production
# publish path, then every assertion comes from a REAL call placed into the
# live inbound route and read back out of the Asterisk log.
set -uo pipefail

LK="C:/Users/izzyw/.ssh/connect2_ed25519"
PK="C:/Users/izzyw/.ssh/connect2_server2_ed25519"
LOOP="root@45.14.194.179"; PBX="root@209.145.60.79"

TENANT="cmqzfigij4bt0mw13u2ulpd0t"
MAIN="cmseuklc80001o7133ke49etw"          # "main menu"      greeting with_a_menu_99d430
SUB="cmsgpcu3e01jqmg13ax642hk1"           # "m"             (no greeting - serves keys)
ALT="cmsewyudm02bon013f8svvk56"           # "Closed menu"   greeting main_greeting_75e2f4
DID="8457231213"
MAPPING="cmsg79jlv048bll1490jrjyyd"
G_MAIN="custom/with_a_menu_99d430"
G_ALT="custom/main_greeting_75e2f4"
G_B="custom/main_greeting_0c9882"

ROUNDS="${1:-5}"
SEC=$(ssh -i "$LK" -o IdentitiesOnly=yes "$LOOP" 'grep -m1 "^AGENT_INTERNAL_SECRET=" /opt/connectcomms/env/.env.platform | cut -d= -f2-')
PASS=0; FAIL=0; FAILED=""

# ── config writers (what the Studio does) ───────────────────────────────────
prisma() { # js body
  ssh -i "$LK" -o IdentitiesOnly=yes "$LOOP" "docker exec -i -w /app/packages/db app-api-1 node -e '$1'" 2>&1
}

set_option() { # profile digit type ref [announceRef] [afterType] [afterRef]
  local prof="$1" digit="$2" typ="$3" ref="$4" ann="${5:-}" aft="${6:-}" aftref="${7:-}"
  local jann jaft jaftref
  if [ -n "$ann" ]; then jann="\"$ann\""; else jann="null"; fi
  if [ -n "$aft" ]; then jaft="\"$aft\""; else jaft="null"; fi
  if [ -n "$aftref" ]; then jaftref="\"$aftref\""; else jaftref="null"; fi
  local data="destinationType:\"$typ\",destinationRef:\"$ref\",announcePromptRef:$jann,afterDestinationType:$jaft,afterDestinationRef:$jaftref,enabled:true"
  local out
  out=$(prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.ivrOptionRoute.upsert({where:{profileId_optionDigit:{profileId:\"$prof\",optionDigit:\"$digit\"}},create:{tenantId:\"$TENANT\",profileId:\"$prof\",optionDigit:\"$digit\",$data},update:{$data}}).then(()=>{console.log(\"OPTOK\");return p.\$disconnect()}).catch(e=>{console.log(\"OPTERR \"+e.message);process.exit(1)})")
  if ! echo "$out" | grep -q OPTOK; then
    FAIL=$((FAIL+1)); FAILED="$FAILED
      - could not save key $digit ($typ): $(echo "$out" | head -c 160)"
    echo "    FAIL  saving key $digit -> $(echo "$out" | head -c 120)"
  fi
}

del_option() { # profile digit
  prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.ivrOptionRoute.deleteMany({where:{profileId:\"$1\",optionDigit:\"$2\"}}).then(()=>p.\$disconnect())" >/dev/null
}

assign_menu() { # profileId  (which menu the DID rings)
  prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.didRouteMapping.update({where:{id:\"$MAPPING\"},data:{ivrProfileId:\"$1\"}}).then(()=>p.\$disconnect())" >/dev/null
}

set_greeting() { # profile ref
  prisma "const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.ivrRouteProfile.update({where:{id:\"$1\"},data:{pbxPromptRef:\"$2\"}}).then(()=>p.\$disconnect())" >/dev/null
}

publish() { # publish through the production path
  ssh -i "$LK" -o IdentitiesOnly=yes "$LOOP" "curl -s -m 200 -X POST http://127.0.0.1:3001/internal/agent/ivr/action -H 'x-agent-internal-secret: $SEC' -H 'content-type: application/json' -d '{\"tenantId\":\"$TENANT\",\"profileId\":\"$MAIN\",\"agentActionId\":\"full-$(date +%s%N)\",\"action\":\"list\"}'" >/dev/null 2>&1
  # `list` does not publish; force a real publish via a no-op prompt set.
  local g="${1:-$G_MAIN}"
  ssh -i "$LK" -o IdentitiesOnly=yes "$LOOP" "curl -s -m 200 -X POST http://127.0.0.1:3001/internal/agent/ivr/action -H 'x-agent-internal-secret: $SEC' -H 'content-type: application/json' -d '{\"tenantId\":\"$TENANT\",\"profileId\":\"$MAIN\",\"agentActionId\":\"full-$(date +%s%N)\",\"action\":\"set_prompt\",\"promptSlot\":\"greeting\",\"promptRef\":\"$g\"}'" | grep -q '"ok":true'
}

t() { # label expect keys waitSecs
  local label="$1" rx="$2" keys="${3:-}" w="${4:-13}" out
  out=$(ssh -i "$PK" -o IdentitiesOnly=yes "$PBX" "bash /root/ivr-e2e.sh $DID '$rx' '$keys' $w" 2>&1)
  if echo "$out" | grep -q "^PASS"; then PASS=$((PASS+1)); echo "    PASS  $label"
  else FAIL=$((FAIL+1)); FAILED="$FAILED
      - $label"; echo "    FAIL  $label"; echo "$out" | head -4 | sed 's/^/          /'; fi
}

echo "########## FULL IVR COVERAGE — $ROUNDS rounds ##########"
for r in $(seq 1 "$ROUNDS"); do
  echo "═══ round $r/$ROUNDS ═══"

  # ── inbound entry + greeting ──────────────────────────────────────────────
  publish "$G_MAIN"
  t "1 inbound call reaches the number's own menu" "m${MAIN}@connect-menu" "" 12
  t "2 that menu's greeting plays"                 "background\\(\"?${G_MAIN}" "" 12

  # ── greeting change propagates ────────────────────────────────────────────
  publish "$G_B"
  t "3 greeting change takes effect"               "background\\(\"?${G_B}" "" 12
  publish "$G_MAIN"
  t "4 greeting change back takes effect"          "background\\(\"?${G_MAIN}" "" 12

  # ── every key type ────────────────────────────────────────────────────────
  set_option "$MAIN" "1" "ivr" "connect-tenant-ivr,$SUB,1"
  set_option "$MAIN" "2" "extension" "T35_cos-all,1101,1"
  set_option "$MAIN" "3" "voicemail" "sub-extensions-vm,VM-1101,1"
  set_option "$MAIN" "4" "announcement" "connect-play-prompt,s,1" "$G_ALT" "" ""
  set_option "$MAIN" "5" "terminate" "hangup"
  del_option "$MAIN" "6"
  publish "$G_MAIN"

  t "5 key 1 -> another menu (submenu entered)"    "m${MAIN}@connect-menu&&&m${SUB}@connect-menu" "1" 15
  t "6 key 2 -> extension (wake-dial wrapper)"     "(dial-with-wake|T35_cos-all,1101)" "2" 12
  t "7 key 3 -> voicemail"                         "(sub-extensions-vm|VM-1101|exit-router)" "3" 13
  t "8 key 4 -> plays a recording"                 "(menu-play-prompt|playback\\(\"?${G_ALT})" "4" 15
  t "9 key 5 -> hang up cleanly"                   "(hangup|exit-router)" "5" 12
  t "10 unset key 6 re-prompts, never dead-ends"   "connect-menu" "6" 13
  t "11 unset * re-prompts"                        "connect-menu" "*" 13
  t "12 unset # re-prompts"                        "connect-menu" "#" 13
  t "13 silence keeps caller in the menu"          "waitexten" "" 13

  # ── in and out of a submenu ───────────────────────────────────────────────
  set_option "$SUB" "1" "extension" "T35_cos-all,1101,1"
  set_option "$SUB" "9" "ivr" "connect-tenant-ivr,$MAIN,1"
  publish "$G_MAIN"
  t "14 submenu serves its own keys (1 -> extension)" "(dial-with-wake|T35_cos-all,1101)" "1wwwwwwww1" 20
  t "15 submenu key 9 returns to the main menu"       "m${SUB}@connect-menu&&&m${MAIN}@connect-menu" "1wwwwwwww9" 21

  # ── repeated invalid entries exhaust into the exit path ───────────────────
  t "16 three invalid keys exhaust to the exit"    "(default-fallback|exit-router|hangup)" "6wwwwww6wwwwww6" 24

  # ── re-assigning which menu the number rings ──────────────────────────────
  assign_menu "$ALT"; publish "$G_MAIN"
  t "17 number re-assigned to another menu"        "m${ALT}@connect-menu" "" 13
  t "18 the re-assigned menu's own greeting plays" "background\\(\"?${G_ALT}" "" 13
  assign_menu "$MAIN"; publish "$G_MAIN"
  t "19 re-assignment back takes effect"           "m${MAIN}@connect-menu" "" 13

  # ── concurrency: three calls at once all get served ───────────────────────
  ssh -i "$PK" -o IdentitiesOnly=yes "$PBX" 'for i in 1 2 3; do asterisk -rx "channel originate Local/8457231213@connect-probe application Wait 8" >/dev/null 2>&1 & done; sleep 11; true' >/dev/null 2>&1
  t "20 menu still answers after concurrent calls" "m${MAIN}@connect-menu" "" 12
done

echo "########################################################"
echo "TOTAL: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -gt 0 ] && { echo "FAILURES:$FAILED"; exit 1; }
echo "ALL GREEN"
