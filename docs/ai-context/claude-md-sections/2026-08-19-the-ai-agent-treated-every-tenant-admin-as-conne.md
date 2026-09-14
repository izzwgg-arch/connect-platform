# ⛔⛔ AGENT HANDOFF — the AI agent treated every TENANT_ADMIN as Connect staff; fortification pass FIXED it and stress-tested the platform (2026-08-19) — READ FIRST before using the agent's `role === "owner"` to authorize anything platform-wide, before adding an `/agent-api/*` admin route, or before touching the tool tiers

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_FORTIFICATION_PASS_2026-08-19.md`**
(`5b998b5c` agent privesc + `bb3ea68f` script cred scrub + `742c02e7` realtime
fail-closed, on `feat/ivr-migration-takeover`. **agent REBUILT + container-verified;
realtime DEPLOYED + verified; `/api/metrics` denied at nginx on both vhosts.** No
migration, no PBX write, no tenant row, no env value changed.)
Izzy, 2026-08-19: *"make sure we're 100% fortified, no backdoors, and stress test
the fuck out of it."*

- ⛔⛔ **THE ONE REAL LIVE HOLE, and it is the "admin-mode ≠ Connect-staff" class
  in the agent's OWN surface, fail-OPEN.** `verifyPortalJwt` maps **TENANT_ADMIN →
  role "owner"** (admin mode, correct since 2026-08-06), and `/agent-api/*` is
  public via nginx — but `requireOwner` (`role === "owner"`) and the chat tool
  tier `toolRoleFor("owner") → "internal"` treated that as **Connect staff**. So
  any of **9 live TENANT_ADMINs** could run raw read-only SQL against BOTH
  production databases via the `investigate` chat tool (NOT tenant-scoped),
  overwrite the platform's global LLM keys (`/agent/admin/secrets`), and
  read/write other tenants' agent policies/approvals/activity/incidents/trainer/KB.
  ⛔ **Nobody swept the agent's own admin routes + tool tier when `isPlatformStaff`
  was added (for escalations only). `mapUserRole` answers "admin MODE?";
  `isPlatformStaff` answers "is this US?" — never use the first for a
  platform-wide or cross-tenant operation.**
- ✅ **FIX (the codebase's proven pattern):** a new **`"staff"` tool tier**
  (SUPER_ADMIN only) holds `investigate`; the chat engine gates it on
  `isPlatformStaff(platformRole)`, so a TENANT_ADMIN and the escalation researcher
  (runs on CUSTOMER text) no longer reach it. New `apps/agent/src/adminAuth.ts`
  (`resolveStaffCaller` / `resolveAdminCaller`). Secrets, approvals/activity/
  incidents, trainer, KB → **staff only**. Policies + `/agent/diag/run` → **bound
  to the caller's own tenant unless staff** (a tenant admin still manages THEIR
  OWN agent). ⛔ **SUPER_ADMIN (Izzy) keeps everything; failure direction is only
  "an admin sees less".** 39 tests (tier gating, red-team, adminAuth, source
  guards); agent suite 664/666 (2 pre-existing failures). ⏳ **Acceptance needs a
  real TENANT_ADMIN login** (see the handoff §1) — and ⛔ if any tenant-admin
  portal screen used approvals/activity/incidents/trainer it will now 403.
- ✅ **Stress test — the deployed defences refuse under load, re-proven live:**
  global rate limiter 479×200→61×429 (retry-after 46, not self-banned); login
  throttle 10×401→429 account-scoped; malformed login bodies all 4xx (no 500s);
  every privileged route 401 unauth; SQLi/traversal rejected. TLS 1.0/1.1 refused;
  SSH keys-only; `/internal/*` 403 external; VoIP.ms + SignalWire webhooks 401;
  dev-observe-token route gone; **0 ADMIN users** (3 latent findings inert).
- ✅ **Also fixed:** `/api/metrics` was **public (200, Prometheus data)** → denied
  at nginx on both vhosts (monitoring untouched — Prometheus scrapes `api:3001`
  internally). `apps/realtime` verified WS tokens against `JWT_SECRET ||
  "change-me"` → now fails closed.
- ✅✅ **THE LEAKED DB PASSWORD IS NOW ROTATED (deep pass, 2026-08-19 evening).**
  The connectcomms Postgres password (leaked in git history) was rotated live and
  the OLD one is **DEAD** (`FATAL: password authentication failed` from the docker
  network). ⛔ It lived in THREE places, all moved together: the DB role, `.env.platform`
  `DATABASE_URL`, and `infra/.env` `POSTGRES_PASSWORD`. Only **api/worker/agent**
  connect (realtime/telephony carry the env var but never connect); the docker net
  is **scram** (127.0.0.1/socket are `trust`, so a loopback verify falsely says the
  old pw works); **`backup.sh` uses the local trust socket, so it was never
  password-dependent**. `ALTER ROLE` does not drop live connections, so no outage.
  Full recipe + rollback in the handoff §5b.
- ✅✅ **DEEP PASS — every other actionable finding closed** (handoff §5b):
  **telephony** `d21fd166` (ADMIN dropped from `/ws/telephony` global; diag +
  call-control routes gated to internal/super-admin; fail-open guard closed; XFF
  last-entry; JWT min 32 — **committed, deploy pending a 0-active-calls window**,
  all latent); **api+billing** `1e6a1973` (⛔ **stored-XSS fence on CRM docs** — an
  uploaded html/svg opened as a same-origin blob stole the JWT; simulate-webhook →
  super-admin; xtoken redacted; pay-links can't overwrite a tenant's billing email);
  **portal** `c5f50104` (`javascript:`/off-origin nav guard). ⛔ Payments CORE and
  portal's big classes (open-redirect, XSS sinks, two-hostname, secrets, 401
  machinery) were all CLEARED.
- ⛔ **STILL needs Izzy (the honest ledger):** the "built but OFF" controls
  (Turnstile, per-tenant 2FA, MFA/TOTP, Cloudflare edge WAF, DMARC quarantine —
  all 0/off); platform-wide session expiry (blocked on the mobile-401 work, and
  it also retires the portal's JWT-in-query-string exposure); do NOT create an
  ADMIN-role user (arms 3 latent findings at once).
