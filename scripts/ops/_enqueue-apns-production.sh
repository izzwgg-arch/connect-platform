#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# PREPARED, NOT APPLIED. Routing: SIG::CURSOR-CONNECT-01. iOS APNs push env only.
#
# Purpose: recreate the `api` and `worker` containers so they pick up the changed
# APNS_PRODUCTION value from the shared env file. This flips iOS VoIP pushes to
# Apple's PRODUCTION APNs host so a standalone (internal-distribution) iOS build
# actually wakes on incoming calls.
#
# ⚠️ THE DEPLOY QUEUE DOES NOT SET ENV VARS. It only rebuilds/recreates containers,
#    which then re-read their env_file. The value itself lives in:
#        /opt/connectcomms/env/.env.platform   (loaded by BOTH api and worker)
#    APNS_PRODUCTION is NOT in either service's docker-compose `environment:`
#    override block, so it is read straight from that env file.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS PINS THE EXACT LIVE COMMIT (do NOT hardcode a branch — esp. not main)
# ─────────────────────────────────────────────────────────────────────────────
# The queue does: fetch → checkout <ref> → build → up. So recreating a service on
# a branch REBUILDS IT FROM THAT BRANCH'S TIP. If we picked the wrong ref we would
# silently change the service's code. Two traps make a per-service *branch* unsafe:
#
#   1. `api` is currently deployed via scripts/deploy-direct.sh (which supports
#      ONLY api|portal and BYPASSES the queue). Its live code lives on branch
#      `fix/ios-fg-active-gate` (the /mobile/foreground-active gate + voice-note
#      MIME fix + loudnorm). But the deploy-QUEUE history's last recorded api job
#      is `main` (2026-06-28) — STALE. Enqueuing api on the queue's "branch" would
#      REBUILD API FROM main and revert those fixes. Confirmed live: the running
#      api container's baked /app/.build-commit is on `fix/ios-fg-active-gate`.
#
#   2. A branch tip can advance after a service was deployed, so even a "correct"
#      branch can rebuild newer code than what is actually live.
#
# Therefore this script detects each service's ACTUAL LIVE COMMIT (authoritative,
# per service) and enqueues with `commitHash` pinned to it. In the queue,
# commitHash WINS over branch (deploy-common resolve_target_commit → `git checkout
# --detach <commit>`), so the recreate builds byte-identical code — only the env
# changes. `branch` is still sent because the enqueue API requires a non-empty
# branch field, but it does not drive the checkout when commitHash is set.
#
# Authoritative live-commit source, per service (NO fallback to main — ever):
#   • Prefer the commit BAKED INTO THE RUNNING CONTAINER: /app/.build-commit
#     (apps/api/Dockerfile bakes it; correct even for direct-deployed api).
#   • Else fall back to the deploy-queue's most recent SUCCESSFUL, NON-dry-run job
#     for that service (authoritative for queue-only services like `worker`, whose
#     image does not bake .build-commit and which cannot be direct-deployed).
#   • If neither yields a commit that resolves in the clone → ABORT that service.
#
# ── PREREQUISITE (owner/Izzy action — agents must NOT edit /opt/connectcomms/env) ─
#   On the server, set in /opt/connectcomms/env/.env.platform:
#        APNS_PRODUCTION=true
#   (change the existing `APNS_PRODUCTION=false` line, or add the line if absent).
#
# ⚠️ GLOBAL EFFECT: APNS_PRODUCTION switches the APNs host for ALL iOS devices.
#    Any iOS device still on a sandbox / Metro dev-client build will STOP waking
#    on incoming calls (its sandbox token is rejected by the production host with
#    BadDeviceToken) until it is rebuilt/installed as a standalone/production
#    build and re-registers. Android/FCM is entirely unaffected (it never uses
#    the APNs VoIP path).
#
#   ROLLBACK: set APNS_PRODUCTION=false (or remove the line) in
#   /opt/connectcomms/env/.env.platform, then re-run this script with --apply to
#   recreate api + worker. That reverts VoIP delivery to the sandbox host.
#
# forceRestart:true is REQUIRED — with no code/commit change the deploy scripts
# would hit the same-commit "no_changes" skip guard and NOT recreate the
# container (so the env change would not take effect). forceRestart bypasses ONLY
# that skip guard (see ops/deploy-queue/src/commitSkip.ts: "to pick up a changed
# env var"); fetch, checkout-safety, build, health check and rollback are unchanged.
#
# Usage (run ON THE SERVER — localhost 127.0.0.1 is a trusted deploy-queue origin,
# no token needed, per AGENTS.md "Path A"):
#   bash scripts/ops/_enqueue-apns-production.sh            # DRY-RUN: detect + ECHO only, enqueues NOTHING
#   bash scripts/ops/_enqueue-apns-production.sh --apply    # REAL enqueue (recreates api + worker)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BASE="http://127.0.0.1:3910"
CLONE="${DEPLOY_REPO_ROOT:-/opt/connectcomms/app}"
SERVICES=(api worker)

DRY_RUN=true
if [[ "${1:-}" == "--apply" ]]; then
  DRY_RUN=false
fi

REASON="recreate to pick up APNS_PRODUCTION=true (iOS-only; Android unaffected); pinned to live commit so code is unchanged"
REQUESTED_BY="human:izzy"

err() { echo "ERROR: $*" >&2; }

# Detect a service's authoritative LIVE commit + a branch that contains it.
# Prints "<commit>\t<branch>\t<source>" on success; returns non-zero on failure.
# NEVER emits or defaults to `main` on failure — the caller aborts that service.
detect_live() {
  local svc="$1" commit="" branch="" src=""

  # 1) Commit baked into the RUNNING container (authoritative for api/portal;
  #    correct even when api was deployed via scripts/deploy-direct.sh).
  local bc
  bc="$(docker exec "app-${svc}-1" sh -lc 'cat /app/.build-commit 2>/dev/null' 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$bc" ]] && git -C "$CLONE" cat-file -e "${bc}^{commit}" 2>/dev/null; then
    commit="$bc"
    src="container:/app/.build-commit"
  else
    # 2) Fall back to the deploy-queue's most recent SUCCESSFUL, NON-dry-run job
    #    for this service (authoritative for queue-only services e.g. worker).
    local qjson
    qjson="$(curl -sS --connect-timeout 3 --max-time 10 "${BASE}/ops/deploy/jobs?status=success&limit=500" 2>/dev/null || true)"
    if [[ -n "$qjson" ]]; then
      local parsed
      parsed="$(printf '%s' "$qjson" | python3 -c '
import json,sys
svc=sys.argv[1]
try:
    jobs=json.load(sys.stdin).get("jobs",[])
except Exception:
    sys.exit(0)
for j in jobs:  # API returns jobs ordered created_at DESC (most recent first)
    if j.get("service")==svc and j.get("status")=="success" and not j.get("dryRun"):
        c=(j.get("deployedCommit") or j.get("commitHash") or "").strip()
        b=(j.get("branch") or "").strip()
        if c and b:
            print(c+"\t"+b)
            break
' "$svc" 2>/dev/null || true)"
      if [[ -n "$parsed" ]]; then
        commit="$(printf '%s' "$parsed" | cut -f1)"
        branch="$(printf '%s' "$parsed" | cut -f2)"
        src="deploy-queue jobs DB (last success)"
        # The pinned commit must resolve in the clone or the checkout will fail.
        if ! git -C "$CLONE" cat-file -e "${commit}^{commit}" 2>/dev/null; then
          commit=""
        fi
      fi
    fi
  fi

  # Resolve a branch that CONTAINS the pinned commit (required enqueue field;
  # commitHash still drives the actual checkout). Prefer a non-main branch so the
  # audit record is not misleading, but this never changes what gets built.
  if [[ -n "$commit" && -z "$branch" ]]; then
    branch="$(git -C "$CLONE" branch -r --contains "$commit" 2>/dev/null \
      | sed 's#^[* ]*##; s#^remotes/##; s#^origin/##' \
      | grep -vE '^(HEAD|HEAD ->)' \
      | grep -vx 'main' \
      | head -n1 | tr -d '[:space:]' || true)"
    if [[ -z "$branch" ]]; then
      # Only main contains it — use it (the commit still pins the exact code).
      branch="$(git -C "$CLONE" branch -r --contains "$commit" 2>/dev/null \
        | sed 's#^[* ]*##; s#^remotes/##; s#^origin/##' \
        | grep -vE '^(HEAD|HEAD ->)' \
        | head -n1 | tr -d '[:space:]' || true)"
    fi
  fi

  # FAIL-SAFE: no reliable live commit/branch → abort this service (never main).
  [[ -n "$commit" && -n "$branch" ]] || return 1

  printf '%s\t%s\t%s\n' "$commit" "$branch" "$src"
}

echo "=== APNS_PRODUCTION container-recreate enqueue (dryRun=${DRY_RUN}) ==="
echo "clone=${CLONE}"
echo "PRE-CHECK: confirm /opt/connectcomms/env/.env.platform has APNS_PRODUCTION=true BEFORE a real (--apply) run."
echo

FAILED=0
for SVC in "${SERVICES[@]}"; do
  echo "--- ${SVC} ---"
  if ! det="$(detect_live "$SVC")"; then
    err "could not reliably detect the LIVE commit for '${SVC}'. ABORTING this service's enqueue."
    err "  (refusing to fall back to 'main' — that could revert live code. Investigate manually.)"
    FAILED=1
    echo
    continue
  fi
  COMMIT="$(printf '%s' "$det" | cut -f1)"
  BRANCH="$(printf '%s' "$det" | cut -f2)"
  SRC="$(printf '%s' "$det" | cut -f3)"
  echo "  detected live commit : ${COMMIT}  (${COMMIT:0:12})"
  echo "  containing branch    : ${BRANCH}"
  echo "  detection source     : ${SRC}"

  body="$(printf '{"service":"%s","branch":"%s","commitHash":"%s","requestedBy":"%s","reason":"%s","forceRestart":true,"source":"manual","dryRun":false}' \
    "$SVC" "$BRANCH" "$COMMIT" "$REQUESTED_BY" "$REASON")"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "  DRY-RUN — would POST ${BASE}/ops/deploy/enqueue with:"
    echo "    ${body}"
  else
    echo "  ENQUEUEING (forceRestart=true, commit-pinned)…"
    curl -sS -X POST "${BASE}/ops/deploy/enqueue" \
      -H "Content-Type: application/json" \
      --data "$body"
    echo
  fi
  echo
done

if [[ "$DRY_RUN" == "true" ]]; then
  echo "=== DRY-RUN complete — NOTHING was enqueued. Re-run with --apply to enqueue. ==="
fi

if [[ "$FAILED" != "0" ]]; then
  err "One or more services could not be resolved; their enqueue was ABORTED (see above)."
  echo
fi

echo
echo "=== Queue status ==="
curl -sS "${BASE}/ops/deploy/status" || true
echo
echo
echo "POST-VERIFY (after a real --apply run completes):"
echo "  ssh connect \"docker exec app-api-1 printenv APNS_PRODUCTION\"      # expect: true"
echo "  ssh connect \"docker exec app-worker-1 printenv APNS_PRODUCTION\"   # expect: true"

if [[ "$FAILED" != "0" ]]; then
  exit 1
fi
