# AGENT HANDOFF — Shammes AI agent / PBX M-capabilities engagement (2026-07-26 → 07-28)

This is the handoff from the Cursor chat that took the Connect AI agent ("Shammes")
from "refuses tasks / claims success that never happened" to live, verified,
end-to-end PBX capabilities. Read this fully before touching the agent, the PBX
helper, or any `pbx.M*` capability.

Owner's bar for this work (Izzy, stated repeatedly and emphatically): the agent
must ACTUALLY execute what it says it executed, end to end, on the live PBX —
no "Done" replies that change nothing. Every capability claim must be provable
in real life through the real chat.

---

## 1. What was built / fixed in this engagement (chronological)

1. **M11 DND auto-approve** — agent puts extensions in/out of DND without approval,
   all tenants present and future (owner mandate `dnd-2026-07-26`). Proven live.
2. **M1/M2 hold music (MOH)** — tenant-wide and per-extension MOH changes with
   timed expiry / scheduled windows and auto-revert (`moh-2026-07-26` mandate).
   Includes the PBX-side Phase-3B per-extension resolver (deployed) with
   device-suffix stripping (`101_1` → `101`) and trunk-leg peer fallbacks.
3. **Action lifecycle hardening** — supersede logic (new action cancels older
   pending revert timers on the same object), permanent-revert refusal (no
   infinite retry loops), transient-fetch retry (`postInternalApi`, 3 attempts).
4. **LLM-first parsing** — regex-first parsing repeatedly misread requests
   ("into main till 8:45" switched to Classic). Now an LLM extracts structured
   JSON, rigorously validated against real catalog data, with the regex parser
   as fallback. Modules: `apps/agent/src/triage/mohLlmExtract.ts`,
   `apps/agent/src/triage/pbxCfgLlmExtract.ts`.
5. **Ground-truth grounding** — last 8 executed actions are injected into the
   chat LLM's system prompt ("RECENT AUTOMATED CHANGES", built in
   `apps/agent/src/channels/identityContext.ts`) so it can no longer fabricate
   execution status.
6. **Admin model picker** — admin AI-assistant page can switch LLM models; each
   model proven working.
7. **Chat uploads** — chunked file upload through the chat widget
   (`FloatingAssistant.tsx` → `/agent/chat/upload/{init,chunk,finish}` →
   `apps/agent/src/attachments/uploadStore.ts`), MP3/playlist → MOH profile
   pipeline (API `/internal/agent/moh/upload-asset`, ffmpeg transcode + concat),
   mic-transcription cancel button.
8. **Instant PBX media sync** — API pokes the PBX helper `/media-sync`, which
   touches a trigger file watched by systemd path unit
   `connect-media-sync.path` → `connect-media-sync.service` → sync in ~2 s
   (5-min cron kept as fallback).
9. **M3 / M4 / M10 expansion (the big one)** — native VitalPBX inbound-route,
   IVR, and queue operations through chat. See §3 for exact live status.

Owner mandates now in `apps/agent/src/actions/service.ts` (`ownerMandateFor`):
`dnd-2026-07-26`, `moh-2026-07-26`, `pbxcfg-2026-07-28` (auto-approves
`pbx.M3`/`pbx.M4`/`pbx.M10`; kill switch `AGENT_PBXCFG_AUTO_APPROVE=0`).

---

## 2. THE critical PBX discovery — VitalPBX REST apply is broken; we BAKE

**VitalPBX's REST `apply_changes` endpoint on this build returns success but
never regenerates the tenant's config files.** Verified live 2026-07-28:
pending flags (`ombu_queued_changes` + `T<id>_reload_dialplan`) get consumed,
HTTP 200 "successfully applied", yet `extensions__50-21-dialplan.conf` mtime
never changes. The GUI Apply button works via a different internal mechanism
(`asterisk_reload.php` — ionCube-encoded, fatal error when invoked directly,
`vitalpbx` CLI runner also encoded; regenerating globally was judged too risky
to run unattended).

Everything routing-related is BAKED into generated files
(`/etc/asterisk/vitalpbx/extensions__50-<tenantId>-dialplan.conf`), so DB
writes alone change nothing live.

**Solution in production: the helper bakes the change directly into the
generated conf** — same guarded pattern as the MOH patcher: backup to
`/var/lib/connect-pbx-helper/backups/`, strict scope check (line count equal,
only the expected line(s) differ), atomic replace, `dialplan reload`.
`bake_route_goto()` in the helper does this for M3. If VitalPBX ever fixes the
REST regen, the bake finds the file already converged and no-ops.

Baked `Goto` formats (verified against live generated confs across tenants):

| target type        | baked Goto                                  |
|--------------------|---------------------------------------------|
| extension          | `Goto(T<t>_cos-all,<ext>,1)`                |
| custom_application | `Goto(T<t>_cos-all,<ext>,1)`                |
| queue              | `Goto(T<t>_ext-queues,<queueExt>,1)`        |
| ring_group         | `Goto(T<t>_ext-ringgroups,<rgExt>,1)`       |
| ivr                | `Goto(T<t>_app-ivr,IVR-<ivrId>,1)`          |
| time_condition     | `Goto(T<t>_app-time-condition,TC-<tcId>,1)` |

IVR welcome prompt is baked as
`same => n(welcome-background),BackGround(/var/lib/vitalpbx/static/<tenantPath>/recordings/<md5>)`
and IVR digit options as `exten => <digit>,1,...` blocks ending in a `Goto` —
both patchable with the same pattern (NOT yet implemented, see §5).

Other regen-bug facts learned the hard way:
- `apply_changes` REST requires custom HTTP verb `UPDATE` (PUT → 501).
- `ombu_modules` names are singular: `inbound_route`, `ivr`.
- Queue MEMBERS are dynamic (AstDB-backed) — member add/remove works live
  without regen. Queue MOH uses the queues-conf patcher (X4). Queue
  ANNOUNCEMENTS are baked → affected by the bug (not yet baked-patched).
- DND/CF (M11) are live AstDB keys — never needed regen.

---

## 3. Live status of each capability (as of 2026-07-28 04:40 EDT)

| Capability | Status | Proof |
|---|---|---|
| M11 DND | LIVE, proven | via chat, all tenants |
| M1 tenant MOH | LIVE, proven | incl. timed/scheduled + revert + uploads |
| M2 extension MOH | LIVE, proven | Phase-3B resolver deployed |
| M3 inbound route | **LIVE, fully proven end-to-end** | chat → DB + baked conf + `dialplan show` both directions (DID 8452510249 ↔ ext 101 / queue 1121) |
| M10 queue members | LIVE, proven | add/remove ext 101 ↔ queue "me testy", `queue show` confirmed |
| M10 queue MOH | LIVE (X4 patcher path) | patcher proven under M1 work |
| M10 queue announcement | DB write works; **NOT live** (baked, needs bake patcher) | — |
| M4 IVR | Built end-to-end but **NOT live-proven** | test tenant has no IVR; writes also need the bake fix |

---

## 4. Where everything lives

### Connect server (loopcom, 45.14.194.179)
- Agent: container `app-agent-1`, port `3920`. API: `app-api-1`, port `3001`.
  Postgres container: `connectcomms-postgres` (psql user/db `connectcomms`).
- Secrets: `/opt/connectcomms/env/.env.platform` → `AGENT_INTERNAL_SECRET`.
- Deploy api/portal: `bash scripts/deploy-direct.sh api --branch feat/ai-agent`
  (blue/green; see AGENTS.md). Agent redeploy used the compose rebuild pattern
  in `_latency_logs/_agent_rebuild_m3410.sh`.
- Chat proof harness (run ON loopcom):
  ```bash
  SEC=$(grep '^AGENT_INTERNAL_SECRET=' /opt/connectcomms/env/.env.platform | cut -d= -f2-)
  curl -s -X POST http://127.0.0.1:3920/agent/chat/message \
    -H 'Content-Type: application/json' -H "x-agent-internal-secret: $SEC" \
    -d '{"identity":{"tenantId":"<connectTenantId>","clientUserId":"<userId>","role":"customer"},"text":"..."}'
  ```

### PBX (209.145.60.79) — writes ONLY under explicit owner mandate
- Helper: `/opt/connect-pbx-helper/vitalpbx-inbound-route-helper.py`
  (**v2026.07.28.5**, repo copy `scripts/pbx/vitalpbx-inbound-route-helper.py`
  is in sync), systemd `connect-pbx-helper`, port `8799`, auth header
  `x-connect-pbx-helper-secret`, env `/etc/connect-pbx-helper.env`
  (includes `CONNECT_PBX_VITALPBX_API_KEY` extracted from Connect's encrypted
  `PbxInstance` row).
- Helper state: `/var/lib/connect-pbx-helper/` — `snapshots.sqlite3`
  (`agent_route_snapshots` with `original_destination_id` +
  `last_set_destination_id` drift guard), `backups/`, `audit.jsonl`
  (**61 GB — never grep it whole; `tail -c 30000000 | grep -a`**),
  `media-sync.trigger`.
- MariaDB `ombutel`: helper DB user `connect_route_helper` has scoped grants
  (see `_latency_logs/_pbx_grants_m3410.sh`, plus `ombu_tenants` SELECT).
- Generated confs: `/etc/asterisk/vitalpbx/extensions__50-<t>-dialplan.conf`,
  `queues__50-<t>-main.conf`. Asterisk binary full path `/usr/sbin/asterisk`
  (cron has minimal PATH).

### Repo (branch `feat/ai-agent`, latest commit `984aa60d`)
- Agent: `apps/agent/src/triage/{orchestrator,intent,mohLlmExtract,pbxCfgLlmExtract,mohTiming}.ts`,
  `apps/agent/src/pbx/ops/{m3InboundRoute,m4IvrOption,m10Queue}.ts`,
  `apps/agent/src/actions/service.ts`, `apps/agent/src/attachments/uploadStore.ts`,
  `apps/agent/src/manifest/capabilities.json`.
- API doors: `/internal/agent/{route,ivr,queue}/action`,
  `/internal/agent/moh/upload-asset` in `apps/api/src/server.ts`; schemas
  `agentRouteAction.ts` / `agentIvrAction.ts` / `agentQueueAction.ts`;
  helper client `pbxInboundRouteHelperClient.ts`. New internal paths must be
  whitelisted in `apps/api/src/jwtPublicRouteBypass.ts` or they 401.
- PBX scripts: `scripts/pbx/vitalpbx-inbound-route-helper.py`,
  `install-connect-tenant-moh-dialplan.sh`, `connect-media-sync.sh`.

### Test tenant (Landau's Home)
- Connect tenant `cmnlgryll000lp9paakiiyizj`, PBX tenant `21` (`T21`).
- Active admin user for chat proofs: `cmojl6paf00flp14dy506k3mt`
  (izzywgg@gmail.com — note `izzywgg+landau@...` is INVITED → identity
  fail-closed, don't use it).
- DID `8452510249` ("telocall", route_id 102), ext `101`, queue `1121`
  "me testy" (queue_id 5, dest row 796; ext-101 dest row 642).

---

## 5. Pending work (in priority order)

1. **M4 live proof** — blocked on a test IVR on Landau's tenant (owner must
   create one in the GUI or explicitly authorize the agent/you to create one).
   Also requires an **IVR bake patcher** (welcome BackGround line + existing
   option-block Goto replace) mirroring `bake_route_goto`; without it,
   `ivr_action` DB writes won't reach live calls (same regen bug).
2. **M10 `set_announcement` bake** — announcement fields are baked into queue
   config; needs the same treatment.
3. Consider log rotation for the helper's 61 GB `audit.jsonl` (voicemail spool
   polls dominate it).

---

## 6. Session gotchas for the next agent (this exact environment)

- This Cursor chat runs ssh/scp DIRECTLY from Windows PowerShell using keys in
  `C:\Users\izzyw\.ssh\` — that worked fine all engagement (the "sandbox-only"
  SSH rule in CLAUDE.md is for the Claude Cowork environment).
- **Piping file contents through PowerShell → ssh corrupts bytes** (one lost
  char crashed the helper with `import urllib.erro`). Deploy files with `scp`
  to a FRESH `/tmp` name, then remote `sed -i 's/\r$//'` + `python3 -m
  py_compile` BEFORE installing. Always `install -m 755` + backup + restart +
  `systemctl is-active`.
- Shell scripts piped to bash on the remote end always tail with
  `: command not found` from a trailing CRLF — harmless, but strip CRLF when
  exit codes matter.
- PowerShell mangles nested quotes/`&&`; write a local script file under
  `_latency_logs/`, pipe with `((Get-Content -Raw f) -replace "`r","")`, or scp.
- `git push origin main` is rejected; work is on `feat/ai-agent`.
- A deploy job reporting success is NOT proof code shipped — follow AGENTS.md
  post-deploy verification (log SHA + `docker exec` grep).
- Agent identity is fail-closed: INVITED users get "couldn't verify your
  account details".
- `.dockerignore` excludes `**/uploads` — that's why the upload store lives in
  `src/attachments/`, don't move it back.
