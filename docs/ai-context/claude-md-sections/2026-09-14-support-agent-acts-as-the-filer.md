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
- ⏳ **NOT BUILT:** phase 3 system lane (own worktree, tests, GO → push/deploy, verify, rollback), phase 4 customer
  conversation, phase 5 Coworker bridge (needs a desktop build for a forced-approval flag), watcher MCP tools + per-tenant
  cap + guardrail rewrite + read-only SSH keys. Nothing has been sent through `/act` by the watcher.
- ⛔ **3GTH9M WAS worked automatically** (claimed 20:33Z, report 20:45Z, widget update delivered 20:46Z, unread) — the
  ticket MCP tool's "NOBODY HAS INVESTIGATED THIS YET" ignores agent runs and misled the second session; and nothing
  alerts Izzy when a report says a code fix is needed. Both ⏳ unfixed.
- ⛔ **Coworker facts:** live on real customer PCs (Trust's office IP 66.250.99.208 ~570 hellos); `computer_powershell`
  asks under SAFE/TRUSTED, runs without asking under AUTONOMOUS; its shell denylist (services, firewall, installs,
  users, restart, HKLM policy, encoded commands) is a desktop floor, not a setting.
- ⛔ **Trap:** a `Write` tool payload decodes `\u` escapes into real bytes — the phase-1 regex became literal control
  chars and git stored the file as BINARY. Use `[0-9]`/`[a-z]`/char codes in tool-written source; scan for control bytes.
