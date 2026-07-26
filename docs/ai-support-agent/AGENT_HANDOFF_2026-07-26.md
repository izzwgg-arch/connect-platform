# AI Support Agent — Session Handoff (2026-07-24 → 2026-07-26)

Branch: `feat/ai-agent` · Latest commit at handoff: `cf271656`
Production checkout: `/opt/connectcomms/app` on **loopcom** (45.14.194.179), branch `feat/ai-agent`.

This session took the AI support agent ("Shammes") from "deployed but dormant" to
"DND wired + live-enabled for Landau/T21", fixed a production TLS/WebRTC outage,
fixed Yiddish language detection, and uncovered a deeper Connect↔PBX link-sync
failure that currently blocks the first live DND write. Read this before touching
the agent or the PBX.

> Ground rules still apply (see root `CLAUDE.md`): Connect work on **loopcom only**;
> **PBX (209.145.60.79) is read-only** except one-time Izzy-approved installs;
> deploy/restart Connect services via the **deploy queue**; never touch payments/pension;
> **Izzy speaks plain English — no code jargon in chat.**

---

## 1. What shipped this session (deployed & verified live)

| Piece | State | Commit / notes |
|---|---|---|
| **TLS certificate** | Fixed — renewed, valid to **2026-10-22**, auto-renews | Root cause: cert bundled a dead `www.app.connectcomunications.com` (NXDOMAIN) that blocked Let's Encrypt renewal. Reissued for `app.connectcomunications.com` only. See memory `connect-tls-cert-autorenew`. |
| **WebRTC / softphones** | Restored | Was down *because* of the expired cert (WSS `/sip` → sbc-kamailio:7443 needs valid TLS). Fixing the cert fixed it. Not a code regression. |
| **API** | Live, healthy | commit `591b445e` (blue/green via deploy queue). Live DB migration `20260723150000_delivery_core` applied cleanly (additive). |
| **Portal** | Live, healthy | commit `9d747d39` then `cf271656`. Includes new IVR Studio + language fixes. |
| **Agent** | Live, healthy | Rebuilt several times; now at `cf271656`. Runs via `docker compose -f docker-compose.app.yml -f docker-compose.agent.yml`. NOT a deploy-queue target — rebuilt manually. |
| **Yiddish detection** | Fixed | (a) `engine.detectLanguage` now whole-sentence dominant-language (≥20% Hebrew-script letters ⇒ `yi`), so English loanwords don't flip Yiddish→English. (b) FloatingAssistant mic **always** uses Yiddish Labs auto-detect (removed the English-only browser SpeechRecognition footgun + the יי/EN toggle). |
| **Identity fail-closed bug** | Fixed | `identityContext.ts` selected `User.name` (no such column). Now derives from `displayName`/`firstName`/`lastName`. Was making the agent tell every user "I couldn't verify your account details." |

### Deploy mechanics (how to redeploy)
- **api / portal**: deploy queue on loopcom `127.0.0.1:3910`, token in `/opt/connectcomms/env/.env.deploy-queue`.
  `POST /ops/deploy/enqueue {"service":"api|portal","branch":"feat/ai-agent","requestedBy":"..."}` with header `x-deploy-queue-token`.
  Blue/green with a **public-HTTPS verify** step — if the cert is bad, the verify fails and the rollout auto-rolls-back (this is what happened before the cert fix).
- **agent**: manual. `cd /opt/connectcomms/app` → ff-merge `origin/feat/ai-agent` →
  `BUILD_COMMIT=$(git rev-parse HEAD) docker compose -f docker-compose.app.yml -f docker-compose.agent.yml build agent` →
  `... up -d --force-recreate agent`. Heavy Docker builds are serialized by `/opt/connectcomms/ops/.heavy.lock` (a live api build will make a portal/agent build wait — see the "HEAVY JOB ALREADY RUNNING" symptom).
- A **concurrent developer** pushes to `feat/ai-agent` too (branch drift). Always `git fetch` + `merge --ff-only` before building; never `git add -A`.

---

## 2. Yiddish Labs (YL) key — resolved, but note the gap

- The YL key **was valid all along**; nothing was deactivated. The agent reads
  provider keys **only at boot** (`SecretStore.get`, store→env). The agent had been
  running since **before** Izzy saved the key, so it never loaded it and silently
  fell back to OpenAI (English). **A restart fixed it.**
- **GAP (TODO):** saving a key in Assistant → API keys does **not** hot-reload the
  running agent — it only takes effect on restart. The UI implies otherwise. Fix so
  a saved key applies live (or restart the agent after key changes).
- **GAP (TODO):** the "Yiddish Labs — connected" chip only checks a key *exists*,
  not that it *works* (a revoked/placeholder key still shows "connected"). Make it
  actually ping YL.
- Key store internals: `AgentSecret` table, AES-256-GCM via `@connect/security`,
  master key env `CREDENTIALS_MASTER_KEY` (must be 64 hex chars). Agent & API master
  keys match (`sha12 2c32c452…`). Env fallback rejects placeholder-looking values
  (`/paste|your key|.../`).

---

## 3. DND (M11) — wired & live-enabled for Landau, but BLOCKED downstream

### What was done (the real fix)
The chat triage mapped `dnd → "action.A7.dnd"` — a **retired** capability that isn't
dispatchable, so every DND request failed at the provisioning backend and **never
reached the new M11 modify executor**. Fixed in `apps/agent/src/triage/orchestrator.ts`:
- `ACTION_CAPABILITY.dnd = "pbx.M11"`.
- Builds M11 single-object params: `{ tenantId: <pbxTenantId>, objectId: <ext>, feature: "DND", enable: "yes" }` (added `resolvePbxTenantId` — Connect tenant cuid → VitalPBX tenant number).
- `pbx.M11` manifest `liveEnabled: true` (first capability certified live). `manifest.test.ts` updated to expect exactly `["pbx.M11"]`.

### The M-series has FOUR independent live locks (defense in depth)
All must align for a real PBX write. Current live state on loopcom `.env.platform`:
1. `AGENT_MODIFY_ENABLED=1` ✅ (executor G0b)
2. `AGENT_PBX_LIVE_TENANTS=21` ✅ (executor G6 — Landau/T21 only; matches **PBX tenant number**, not the Connect cuid)
3. `AGENT_PBX_LIVE_WRITES=1` ✅ (ActionService `opts.live`)
4. manifest `liveEnabled:true` ✅ (modifyBackend gate) — **only pbx.M11**
Plus: `AGENT_PBX_PROTECTED_EXTS=` (empty → nothing protected; default is `"101"`).
Plus: bound capabilities still require **explicit Izzy approval** (G8) — owner is NOT
auto-approved for live PBX writes; that's intentional.

The modify executor, gate chain, snapshot/verify/auto-revert, and the PBX helper
(`/get-diversion`, `/set-diversion`) are all installed and tested. The helper on the
PBX is **v2026.07.23.5** (installed this session, surgical `.py` swap — keeps routes +
queue-moh, adds diversion; backup at `/opt/connect-pbx-helper/*.bak-*`).

### ⛔ OPEN BLOCKER — Connect↔PBX link sync is failing (this is where DND is stuck)
`POST /internal/agent/extfeature/action` (API door, server.ts ~24380) requires the
tenant's `TenantPbxLink.status = "LINKED"`. **Landau's link is `status=ERROR`,
`lastError="PBX request failed"`**, and a **background job re-sets it to ERROR within
seconds** of any manual flip to LINKED. In fact **every** `TenantPbxLink` row is
`ERROR`. So the door returns `tenant_not_linked` and no DND write can happen.

- This is an **active, ongoing sync failure**, not a stale flag — telephony works, but
  the Connect→PBX *sync/health* request fails for all tenants.
- **Do NOT** brute-force the status (a job reverts it) or remove the door's `LINKED`
  check (that guard prevents writing to a PBX the app can't reach).
- **NEXT STEP (recommended, read-only first):** diagnose *why* the tenant↔PBX sync
  returns "PBX request failed" — check the sync job, the `PbxInstance`
  (`ombuMysqlUrlEncrypted`, API creds/URL), and whether the helper/route config
  (`resolvePbxRouteHelperConfig`) resolves for `pbxInstanceId=cmmi7huxy0000qq3igj493o5q`.
  Landau: Connect tenant `cmnlgryll000lp9paakiiyizj` ↔ pbxTenantId `21`.

### To verify DND once the link is healthy
Read path test (non-destructive) that mirrors production, run inside the agent container:
`makeExtFeatureApiClient().call({ tenantId:"21", action:"get", extension:"101", feature:"DND", agentActionId:"test" })`.
It currently fails with `tenant_not_linked`; it should return `{ok:true, state:{...}}`
once the link is LINKED. Then have Izzy ask DND in chat and **approve** the prompt.

---

## 4. Other known gaps / TODO (surfaced, not yet done)
- Only **DND (M11)** is wired from chat. The other M-capabilities (MOH M1/M2, routes
  M3, IVR M4–M7, queue M10) are built + gated but **not routed from the triage** yet
  (still mapped to retired `action.A*` or unmapped). They are NOT live-invokable from chat.
- Provider used by `/agent/chat/transcribe` is **not logged** — add observability
  (which engine handled each mic clip + detected language) so a YL failure can't hide.
- Language detection threshold is a single tunable const `YIDDISH_DOMINANCE_THRESHOLD`
  (0.2) in `engine.ts` — lower it to lean more Yiddish if needed.

---

## 5. Quick reference
- SSH: from the networked sandbox, keys in `.connect-ssh/` staged to `/tmp/*_key` mode 600.
  loopcom `root@45.14.194.179` (Connect); pbx `root@209.145.60.79` (READ-ONLY).
- Agent container `app-agent-1` (port 3920), API `app-api-1` (3001), portal `app-portal-1`.
- Postgres container `connectcomms-postgres`, user/db `connectcomms`.
- Backups made this session: `/root/deploy-prep-backups/*`, `/opt/connectcomms/env/.env.platform.bak.*`, `/opt/connect-pbx-helper/*.bak-*`.
