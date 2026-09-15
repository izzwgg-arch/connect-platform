# ⛔⛔ AGENT HANDOFF — the automatic support agent gets HANDS: it acts as the ticket's filer through the api, texts the owner before any change, STOP is final, GO gates system-wide changes (2026-09-14) — READ FIRST before giving the support agent any write power, touching `apps/api/src/support/actAsFilerRoutes.ts` / `supportAgentNotice.ts`, the FIX reply sweep, or `tools/loopcom-support-mcp`

Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPPORT_AGENT_FIXES_2026-09-14.md`**. Memory: [[support-agent-acts-as-the-filer]].
Izzy: *"it should be allowed to fix everything"* — bounded by the filer's own custom role (owner toggle = owner-level,
incl. billing and numbers), no tenant leakage, 10 fixes per tenant per day; tenant-only change → text him and keep
going; system-wide change → text him and wait for GO; customer told "fixed" only with proof; PowerShell on the
customer's PC through the Coworker in the Loopcom app with the user's approval pop-up.

- ✅ **Phase 1 DEPLOYED (`d1f2aa46` + `cc8211c1`, container-verified):** `POST /admin/support/escalations/:ref/act`
  replays one request through the api's own routes as the filer (app.inject, 2-min token never leaves the api).
  Identity from the user row; filer tenant must equal ticket tenant; SUPER_ADMIN filers, alarms, >7-day tickets,
  inactive filers refused; `/admin /internal /auth /ops /agent /agent-api /support /onboarding /voice/pbx/resources`
  blocked for everyone; no `token=`/`tenantContext=`; writes OFF unless `SUPPORT_AGENT_WRITES_ENABLED=1` (unset);
  10 distinct tickets/tenant/day; every call audited. Live 401 without a token on both hostnames.
- ✅ **Phase 2 DEPLOYED (`31dc0e05` inside container `12d2c318`, migration `20260914230000` applied, table present,
  0 rows)** — first attempt `33fb81a7` stopped before migrate on another session's portal heavy job and changed
  nothing; retry `928e0b0c` succeeded. `owner-notice` texts Izzy's numbers (hashed code, never
  returned); the act route refuses every write without a delivered live notice and after any STOP; STOP/GO ride the
  one existing FIX reply sweep (owner numbers only, atomic, negated go refused, STOP works after expiry). New table
  `SupportAgentNotice` (migration `20260914230000`).
- ✅ **Watcher hooked up (`84a5fc16`, api deployed, watcher restarted — handoff §7):** MCP tools `act_as_filer` /
  `post_owner_notice` / `get_owner_notices`; guardrails now allow fixing within the filer's permissions (no commit/push/
  deploy, no direct PBX write, no customer messages still stated); 10 per company per day (backstop 50); 30-min runs;
  the customer may be told "fixed" only when the audit trail shows a 2xx act write. ⛔ Restart = `Stop-Process` the node
  pid (the scheduled-task Stop/Start did NOT replace it). ⛔ **Writes still OFF** — `SUPPORT_AGENT_WRITES_ENABLED` must be
  set by Izzy (AGENTS.md rule 10) or flipped in code.
- ✅ **Phase 3 — the agent can ship a CODE fix after Izzy's GO (`8bce4506`, api deployed + container-verified, watcher
  restarted; handoff §9).** The agent only STAGES (`stage_edit` / `stage_new_file` into its own
  `.claude/worktrees/support-ship-<ref>`, allowlisted paths, its own gate files/env/keys/prisma/package.json/tsconfig
  refused) and calls `request_ship` (commit by pathspec, nothing pushed). `ship.mjs` in the watcher then runs npm
  test + typecheck, texts a GO naming the commit, and only after GO: re-checks the approved commit, rebases + re-tests,
  fast-forward pushes, deploys the BRANCH through the queue, verifies container ancestry + health on both hostnames,
  reverts + redeploys on failure, texts the result (`POST …/owner-update`). 3 ships/day; interrupted ships never resume.
  ⏳ Nothing has shipped through it yet.
- ⏳ **NOT BUILT:** phase 4 customer conversation, phase 5 Coworker bridge (desktop build), read-only SSH keys (a PBX
  write). ⛔ Writes as the filer still OFF (`SUPPORT_AGENT_WRITES_ENABLED`).
- ⛔ **Incident 22:29Z:** Izzy's office IP `50.48.58.53` auto-banned by nginx (req/min>600 + 404>60/5m) by an open Deploy
  Center tab polling a 404 deploy-job log; expires 23:29Z; close the tab first. Handoff §8.
- ⛔ **3GTH9M WAS worked automatically** (claimed 20:33Z, report 20:45Z, widget update delivered 20:46Z, unread) — the
  ticket MCP tool's "NOBODY HAS INVESTIGATED THIS YET" ignores agent runs and misled the second session; and nothing
  alerts Izzy when a report says a code fix is needed. Both ⏳ unfixed.
- ⛔ **Coworker facts:** live on real customer PCs (Trust's office IP 66.250.99.208 ~570 hellos); `computer_powershell`
  asks under SAFE/TRUSTED, runs without asking under AUTONOMOUS; its shell denylist (services, firewall, installs,
  users, restart, HKLM policy, encoded commands) is a desktop floor, not a setting.
- ⛔ **Trap:** a `Write` tool payload decodes `\u` escapes into real bytes — the phase-1 regex became literal control
  chars and git stored the file as BINARY. Use `[0-9]`/`[a-z]`/char codes in tool-written source; scan for control bytes.
