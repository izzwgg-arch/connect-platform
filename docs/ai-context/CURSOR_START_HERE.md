# CURSOR_START_HERE — Read me first, every chat

> **This is the entry document for every Cursor / Opus / agent session in this repo.**
> Read this BEFORE you start coding, BEFORE you read any other ai-context doc, and BEFORE
> you scan the repo. It exists to keep token cost low and keep telephony stable.

---

## 0. Mission

Connect Communications is a **multi-tenant business voice + messaging platform** built on
top of a self-hosted **VitalPBX** (Asterisk). Most regressions in this codebase come from
agents wandering across the repo, touching telephony/PBX/WebRTC code with no evidence,
or "refactoring" while fixing a bug.

Your job is to be **narrow, surgical, and conservative**. The platform is in production.

---

## 1. Per-chat checklist (do these in order)

1. **Read this file first** (`docs/ai-context/CURSOR_START_HERE.md`).
2. **Read `AGENTS.md` at the repo root** — hard rules on deployments, the deploy queue,
   and forbidden server commands.
3. **Read only the relevant ai-context docs**, not all of them. Use the routing table in
   section 3 below.
4. **Confirm the task category**:
    - UI / styling / copy
    - Portal API call / dashboard logic
    - Mobile (React Native / Expo)
    - Telephony (AMI / ARI / SIP / WebRTC / call counting)
    - PBX (VitalPBX / Asterisk / dialplan)
    - Worker / background jobs / scheduling
    - Database / Prisma / migrations
    - Deployment / Docker / nginx / firewall
    - Documentation / guardrails only
5. **Identify risk level** using `SAFE_CHANGE_ZONES.md` (LOW / MEDIUM / HIGH / EXTREME).
6. **List files likely needed** before opening more than two of them.
7. **Do NOT code yet** — first state, in plain language, the **root cause** (for bugs)
   or the **implementation plan** (for features).
8. **Do NOT modify unrelated files.** No "while I'm here" cleanups.
9. **For telephony / PBX / mobile-call bugs**, require evidence first:
    - VitalPBX live snapshot or `pbx-snapshot.txt`
    - `GET /forensic`, `GET /diagnostics`, `GET /telephony/calls`
    - Mobile logcat / structured `[CALL_TIMELINE]` log lines
    - Wake/diag DB rows (`mobileDeviceCallWakeDiagnostics`)
    Without evidence, **stop and ask**, do not guess.
10. **For production-impacting changes**, include a rollback plan in your write-up.
11. **At the end of the change**, summarize:
    - what changed (files + reason)
    - what was deliberately NOT changed
    - how to verify
    - how to revert

---

## 2. Hard "do not" rules (skim every chat)

- **Do not deploy manually.** All deploys go through the queue (`POST /ops/deploy/enqueue`
  or `POST /internal/deploy/auto`). See `AGENTS.md`.
- **Do not run `prisma migrate` directly.** Only the `api` deploy job runs migrations.
- **Do not edit `/etc/nginx`, `/etc/ssh`, firewall rules, or env files under
  `/opt/connectcomms/env/`** — server infra is out of bounds.
- **Do not refactor** while fixing bugs. Surgical changes only.
- **Do not change VitalPBX behavior** without a snapshot + validation plan.
- **Do not poll the PBX aggressively** when AMI/ARI events already deliver state.
  **Do not add new `VitalPbxClient.getAriBridgedActiveCalls` loops in `apps/api`** —
  live bridged rows come from the **telephony Redis snapshot** (`pbxLiveAriSlice.ts`)
  with rare direct-ARI fallback only. Telephony poller interval is env-tuned (default
  **5 s**); see `DEBUGGING.md` § PBX CPU profiling and `TELEPHONY.md` § ARI.
- **Do not count `Local/...` / helper / `Down` channels as active calls.** The truth is
  in `apps/telephony/src/telephony/state/CallStateStore.ts::getActive()` and in
  `normalizeCallEvent.ts` (`isHelperChannel`, `hasValidBridgedParticipants`).
- **Do not break tenant isolation.** Tenant scoping flows from JWT → telephony WS filter
  → portal/mobile state. If you touch any of those, prove isolation still holds.

---

## 3. Doc routing table — load only what you need

| Task category | Read these docs |
|---|---|
| UI / copy / layout only | `SAFE_CHANGE_ZONES.md`, `AI_WORKFLOW_RULES.md`, `TOKEN_COST_HOTSPOTS.md` |
| Portal API page / form | `ARCHITECTURE.md`, `SERVICES.md` (api + portal sections), `API_ROUTES.md` |
| Backend route lookup (any `app.<verb>(...)`) | `API_ROUTES.md` (jump table for `apps/api/src/server.ts`) |
| Mobile (React Native) | `SERVICES.md` (mobile), `TELEPHONY.md` (mobile call section), `MOBILE_CALL_TIMELINE.md`, `KNOWN_ISSUES.md` (Mobile calling) |
| Mobile call bug (push / wake / ring / answer) | `MOBILE_CALL_TIMELINE.md` first, then `docs/ai-templates/mobile-call-debug.md` |
| Telephony / live calls / KPI | `TELEPHONY.md`, `DEBUGGING.md`, `KNOWN_ISSUES.md` |
| Voicemail fleet stale-risk / audit gap | `VOICEMAIL_FLEET_STALE_RISK.md`, then `DEBUGGING.md` § voicemail **9b** |
| PBX / VitalPBX / dialplan | `TELEPHONY.md`, `RULES.md`, `KNOWN_ISSUES.md`, plus `docs/pbx/*` and `docs/VITALPBX_ARI_SETUP.md` |
| AstDB / IVR / MOH publish | `ASTDB_KEYS.md` first, then `docs/pbx/option-a-runtime-keys.md` |
| Worker / cron / SMS / billing | `SERVICES.md` (worker), `ARCHITECTURE.md` |
| Database / schema | `DATA_MODEL.md` first (cheat sheet), then `ARCHITECTURE.md` (data flow), then `packages/db/prisma/schema.prisma` |
| Deployment / Docker / CI | `DEPLOYMENT.md`, `AGENTS.md`, `docs/safe-deploy-queue.md` (for slow deploys, use structured `[phase]` timings + `queue_wait` + `build_diag` before changing scripts) |
| WebSockets / realtime | `ARCHITECTURE.md`, `TELEPHONY.md` (broadcast section) |
| Test coverage questions | `TEST_INVENTORY.md` |
| Repo navigation / why-is-this-file-so-big | `TOKEN_COST_HOTSPOTS.md`, `REPO_HYGIENE.md` |
| Generic bug investigation | `docs/ai-templates/bug-investigation.md` |
| Telephony bug | `docs/ai-templates/telephony-debug.md` |
| Mobile call bug | `docs/ai-templates/mobile-call-debug.md` |
| New feature ask | `docs/ai-templates/feature-request.md` |
| Deployment-related ask | `docs/ai-templates/deployment-change.md` |
| Big UI redesign | `docs/ai-templates/ui-redesign.md` |

If a task spans categories, read at most **3** docs. If you find yourself loading more,
stop and ask the user to scope.

---

## 4. Project shape, in one screen

- **Monorepo** managed by pnpm + Turbo. Workspaces:
    - `apps/api` (Fastify, port **3001**) — backend, REST, auth, billing, PBX integration.
    - `apps/portal` (Next.js, port **3000**) — web UI.
    - `apps/realtime` (WS, port **3002**) — minimal JWT-authed WebSocket service.
    - `apps/telephony` (Express + WS, port **3003**) — AMI/ARI client, BLF/calls/queues
      WebSocket broadcaster, CDR ingest source.
    - `apps/worker` (BullMQ + cron-like setIntervals) — SMS, voicemail sync, PBX CDR sync,
      IVR/MOH scheduling, billing automation, call invite expiry, push notifications.
    - `apps/mobile` (Expo / React Native) — softphone (jssip + react-native-callkeep +
      VoIP push), voicemail, chat, contacts.
    - `apps/desktop` (Electron) — Windows desktop wrapper.
    - `apps/frontend-legacy/portal-v2-legacy` — legacy portal, reference only.
    - `packages/db` (Prisma, Postgres).
    - `packages/shared` — phone/E.164, MOH runtime class, chat helpers.
    - `packages/integrations` — VitalPBX, WirePBX, Twilio, VoIP.ms, Sola/Cardknox.
    - `packages/security` — credential crypto.
    - `ops/deploy-queue` — local SQLite-backed deploy queue.
- **External services**: VitalPBX (Asterisk) on `209.145.60.79`, AMI :5038, ARI :8088,
  WSS WebRTC on :8089. Postgres + Redis are infra-side.
- **Deploys**: queue-only. Compose file is `docker-compose.app.yml`.

---

## 5. When in doubt

- If you cannot reproduce a bug from logs, **stop and ask for a snapshot**.
- If a change might cross more than one of `auth / tenant / telephony / billing /
  mobile call state / deploy`, **ask the user to confirm scope first**.
- For Cardknox/SOLA billing changes, use the shared resolver (`resolveBillingGatewayConfig`)
  and preserve effective-source precedence (`tenant override -> main tenant -> env/global -> missing`);
  do not add a second resolver in worker or route handlers.
- Prefer `dryRun: true` for any deploy enqueue.
- Prefer reading 5 small files over 1 huge one. `apps/api/src/server.ts` is ~30k LOC —
  use `Grep` with the exact route, do not read it whole.
- See `TOKEN_COST_HOTSPOTS.md` for a per-file load-risk table and "do not load" rules.

---

## 6. Repo hygiene quick facts

- **Root scratch is gone.** All `_check-*`, `_diag*`, `tmp_*`, `tmp-*`,
  `pbx-*.txt`, `pbx_*.json`, `trace*.txt`, `*.wipbackup`, and similar
  diagnostic artifacts live in `_repo_archive/diagnostics/`. Do not
  load anything from there. See `REPO_HYGIENE.md`.
- **`.cursorignore`** excludes the archive plus `apps/desktop/release/`
  (~576 MB Electron output) and all build outputs. Do not work around it.
- **Some root-level scripts are deliberately UNKNOWN** (e.g. `db-check*.sh`,
  `verify-db.sh`, `check_*.sql`, `dashboard.bundle`). They were left in
  place by the stabilization pass because their names did not
  unambiguously identify them as scratch. See the UNKNOWN list in
  `REPO_HYGIENE.md` before moving any of them.
