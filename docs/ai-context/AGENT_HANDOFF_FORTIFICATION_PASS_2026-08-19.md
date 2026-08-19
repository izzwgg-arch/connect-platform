# ⛔⛔ AGENT HANDOFF — fortification re-audit + stress test, and the ONE real live hole it found: the AI agent treated every TENANT_ADMIN as Connect staff (2026-08-19)

Izzy, 2026-08-19: *"make sure that we're 100% fortified, with no backdoors, no
nothing, and stress test the fuck out of it. and also check the MD files for what
still needs to be done."*

This was a full re-verification of the platform's deployed defences, a fresh
backdoor sweep, an audit of the two never-audited surfaces (`apps/agent`,
`apps/worker`), and a live stress test. **The platform's deployed controls all
held.** The one genuinely-reachable, live vulnerability was in `apps/agent`, and
it is now FIXED, DEPLOYED and container-verified.

Commits on `feat/ivr-migration-takeover`: `5b998b5c` (agent privesc),
`bb3ea68f` (script credential scrub), `742c02e7` (realtime fail-closed). Plus
one live nginx change (`/api/metrics` deny, both vhosts). No migration, no PBX
write, no tenant row touched, no env value changed.

---

## 1. ⛔⛔ THE HOLE — a TENANT_ADMIN was Connect staff to the agent (CRITICAL, reachable today, FIXED)

**The exact "admin-mode ≠ Connect-staff" class this repo documents at length —
but in the agent's OWN surface, in the fail-OPEN direction, and it was never
swept when `isPlatformStaff` was introduced (for escalations only) on 2026-08-19.**

The mechanism, verified at the source (not taken from an audit):
- `apps/agent/src/auth.ts:56` — `verifyPortalJwt` sets `role = mapUserRole(payload.role)`,
  and `mapUserRole` maps **TENANT_ADMIN → "owner"** (admin mode, correct since
  2026-08-06). It keeps `platformRole` beside it *specifically* to tell staff
  apart — but the routes below didn't use it.
- nginx `location /agent-api/` → `proxy_pass http://127.0.0.1:3920/agent/;` — the
  agent's admin routes are reachable from the **public internet** with a tenant
  admin's ordinary portal JWT.
- `requireOwner` = `id.role === "owner"` admitted every TENANT_ADMIN; the chat
  engine's `toolRoleFor("owner") → "internal"` handed chat the `investigate` tool;
  `investigate` is **deliberately NOT tenant-scoped** (raw SQL across both DBs).
- **9 active TENANT_ADMIN accounts, 9 different real companies.**

What a customer's own admin could do, cross-tenant:
1. **Run arbitrary read-only SQL against BOTH production databases** via the
   `investigate` chat tool (all tenants' users, invoices, calls, voicemail
   transcripts, escalations, audit; and the PBX MySQL). ⛔ The CRITICAL one.
2. **Overwrite the platform's global LLM API keys** (`POST /agent/admin/secrets`,
   one global row per key) — DoS the assistant for every tenant, or redirect all
   AI traffic onto an attacker's provider account.
3. Read/write **any tenant's** agent policies, and read every tenant's approvals,
   activity feed, incidents, trainer lessons and KB.

### The fix (matching the codebase's proven `isPlatformStaff` pattern)

- **New tool tier `"staff"`** in `tools/toolRegistry.ts` (SUPER_ADMIN only).
  `investigate` moved to it. `toolsForRole`: staff→all, internal→all-but-staff,
  customer→customer. The chat engine's `toolRoleFor(role, platformRole)` returns
  `"staff"` only when `isPlatformStaff(platformRole)` — so a TENANT_ADMIN
  ("internal") and the **escalation researcher** (runs on CUSTOMER text as role
  "internal") never reach `investigate`. ⛔ **This deliberately removes
  `investigate` from the escalation researcher** — closing the "inject SQL into
  the transcript" vector, at the cost of that researcher's cross-tenant reach.
  Reports still diagnose from the tenant-scoped reads; a tenant-scoped
  `investigate` variant for the researcher is a possible follow-up.
- **New `adminAuth.ts`** — `resolveAdminCaller` (admin mode + `isStaff` flag) and
  `resolveStaffCaller` (SUPER_ADMIN only). Fails closed.
- **STAFF-only** (inherently global / cross-tenant consoles): `/agent/admin/secrets`
  (status + write), `actions/adminRoutes.ts` approvals/activity/incidents,
  `/agent/admin/trainer/lessons` (+revoke), `/agent/kb/retrieve`.
- **Tenant-bound unless staff** (a tenant admin keeps managing THEIR OWN agent):
  `policy/adminRoutes.ts` (list scoped to caller's tenant; get/:id + POST refuse
  a foreign tenantId), `diag/routes.ts` (body tenantId must equal the caller's).

⛔ **SUPER_ADMIN (Izzy) keeps everything.** The failure direction is only "an
admin sees less" — never a data leak. Customers (role USER) were never in these
tiers.

### Proof
- 39 new/updated tests: tier gating, red-team (a TENANT_ADMIN naming `investigate`
  is refused, body never runs), `adminAuth` (SUPER_ADMIN staff / TENANT_ADMIN NOT
  staff / wrong-secret token refused), and **source guards** on every route (the
  defect is always the caller). Full agent suite **664/666** (the 2 failures are
  pre-existing: a corpus fake-db mock and an everett Yiddish/Hebrew test —
  neither touches auth or tools).
- **DEPLOYED via manual agent rebuild** (agent is in NO deploy queue): clone reset
  to `5b998b5c`, `docker compose … build agent && up -d agent`. Container-verified:
  `resolveStaffCaller` present, `investigate` `minRole:"staff"`, engine gates on
  `isPlatformStaff(platformRole)`, 0 restarts, listening, no boot errors. Live:
  every admin route 403s unauthenticated; the customer chat surface is alive
  (403 unauth, not 5xx).

⏳ **NOT PROVEN by a human**: the full positive/negative acceptance test needs a
real TENANT_ADMIN login. **5-minute acceptance**: sign in as a TENANT_ADMIN and
confirm (a) chat cannot make the assistant run a cross-tenant SQL read /
`/agent-api/admin/secrets/status` returns 403, but (b) their OWN-tenant agent
policy + a diag of their own tenant still work; and (c) Izzy (SUPER_ADMIN) still
has everything incl. `investigate` in chat. ⛔ **If any TENANT_ADMIN portal
screen used approvals/activity/incidents/trainer, it will now 403 — that screen
was showing cross-tenant data and should be redesigned; tell the next session.**

---

## 2. Live verification — every "ON and proven" control re-confirmed firing (2026-08-19)

Read from the live platform, both hostnames, from the loopcom server:
- Health/version 200 both hosts; all five security headers + HSTS + CSP +
  `no-store` on `/login`, byte-identical on both.
- `/api/internal/*` **403** externally, **401** handler from loopback (the docker
  peer path still works). VoIP.ms SMS webhook **401** (fail-closed). SignalWire
  webhook **401 no_signature** (fail-closed). Dev-observe-token route **gone**
  (401 unrouted, not a 404 handler). Forged JWT **401**.
- TLS (openssl handshake): **1.0/1.1 REFUSED, 1.2/1.3 ACCEPTED**. SSH password
  auth **refused** (keys only). `server_tokens off` (no version leak).
- Env inside `app-api-1`: `JWT_SECRET` 64, `CDR_INGEST_SECRET` 64,
  `SOLA_CARDKNOX_SIMULATE=false`, `TURNSTILE_SECRET_KEY` unset, `NODE_ENV` empty
  (expected). `GLOBAL_RATE_LIMIT_ARMED maxPerMinute=480` at boot.
- Perimeter: UFW default-deny; only 22/80/443, TURN/TURNS, WireGuard, and 3910
  restricted to `172.16/12`. No datastore ports exposed. Both app vhosts at
  parity (internal deny + security-headers include ×3, 0 auth_basic). The catch-
  all `connectcomms-platform` vhost is a **port-80 "not deployed yet" stub** — no
  proxy, harmless. `sites-available/connectcomms` drift vs enabled is the
  documented, expected trap (the enabled file is authoritative).
- DB census: **0 ADMIN-role users** (the three latent ADMIN findings are inert),
  1 SUPER_ADMIN (izzywgg@gmail.com), 9 TENANT_ADMIN, 75 USER, 1 EXTENSION_USER.
  **0 tenants on 2FA**, **0 MFA enrolments**. DMARC `p=none` both domains.
  `app.`/`sip.` DNS-only (edge WAF inert); `m.loopcom.net` does not resolve.

## 3. Stress test — the defences refuse under load

- **Global rate limiter**: 540 rapid `/api/health` from the server's own IP →
  **479 × 200 then 61 × 429**, `retry-after: 46`, and the IP was **not** banned by
  monitor.sh. Recovered after the window rolled. (⛔ Run from the SERVER — nginx
  appends the real peer as the last `X-Forwarded-For` entry.)
- **Login throttle**: 12 bad logins for a throwaway account → **10 × 401 then
  2 × 429** (`RATE_LIMITED`); a DIFFERENT throwaway account from the same IP still
  got **401** (account-scoped, not blanket). No 500s.
- **Malformed body** on `/auth/login` (short pw / empty / non-JSON / array /
  missing content-type): all **4xx**, never 500 (the login-500 fix holds).
- Every sampled privileged route (`/admin/tenants`, `/admin/users`,
  `/admin/wake-health`, `/voice/voicemail`, `/billing/platform/tenants`,
  `/crm/contacts`, `/calls/history`, `/voice/pbx/resources/tenants`) **401**
  unauthenticated. Combined pay-multi link reaches its handler (**410**). SQLi in
  login email → 401 (parameterised). Path traversal → 404.

## 4. Other fixes shipped this pass

- **`/api/metrics` was publicly reachable (200, Prometheus data, no auth).**
  Info-disclosure (route names, counters, timings — no secrets/tenant data).
  Closed with an `/api/metrics` deny in BOTH vhosts (allow loopback/docker/PBX,
  deny all), mirroring `/api/internal/`. **Prometheus scrapes `api:3001/metrics`
  on the docker network**, so external deny does not touch monitoring — verified
  the `connect_api` target still reads `health:"up"`. Now **403** on both hosts;
  internal deny + health unaffected. Backups
  `/root/nginx-*-backup-20260819T190501Z-metricsdeny.conf`.
- **`apps/realtime` verified WS tokens against `JWT_SECRET || "change-me"`** — a
  fail-open literal that is public in this repo. Now fails closed at boot (>=32
  chars), like the api (`eeec0002`). Behaviour-identical in prod (secret is 64
  chars). Deployed via the queue (`742c02e7`), container-verified: executable
  line is `const secret = process.env.JWT_SECRET;`, 0 restarts.
- **The production Postgres password was committed in plaintext** across five
  `scripts/*.sh` diagnostic one-offs (and therefore in git history / on GitHub).
  Scrubbed to require `PGPASSWORD` from the environment (`bb3ea68f`). ⛔ **This
  does NOT un-leak history — the load-bearing fix is to ROTATE the connectcomms
  DB password.** That is an outage-risk, multi-service operation (update
  `DATABASE_URL` in `.env.platform`, then restart api + worker + telephony in
  order) and is left for a coordinated window with Izzy. Postgres is loopback-
  only, so the value is not remotely usable today.

## 5. ⛔ What STILL needs a person (the honest ledger, re-read 2026-08-19)

The platform SURFACES are hardened and at parity. What remains is switches only
Izzy can flip, and one coordinated op:
- **Rotate the connectcomms DB password** (see §4 — the real fix for the leaked
  credential; outage-risk, needs a window).
- **The "built but OFF" controls** (security handoff §13.2): Cloudflare Turnstile
  (create the site + set `TURNSTILE_SECRET_KEY`, observe → read log → enforce),
  per-tenant 2FA (0 tenants on), MFA/TOTP (0 enrolments, incl. the SUPER_ADMIN),
  the Cloudflare edge WAF (blocked on the SIP proxy question), DMARC
  `p=none → quarantine` (read the `rua` reports first).
- **Session tokens still never expire** platform-wide (blocked on the mobile 401
  work — §8; a dead token today is a 401 stream that auto-bans an office).
- **Three latent `ADMIN` findings** stay inert because **0 ADMIN users exist** —
  ⛔ creating one arms raw-PBX writes (§6h), the chat routes (§6a/§6b) and
  `/ws/telephony` at once. Do not create an ADMIN-role user.
- Lower items, not changed: `POST /billing/invoices/:id/simulate-webhook` admits
  TENANT_ADMIN (bounded to their OWN invoices — consider narrowing to
  SUPER_ADMIN); Grafana default password (loopback-only); a stale
  `.env.example` comment.
- ⏳ `apps/worker` internal audit was commissioned this pass — fold its result in.

## 6. Deploy / process notes worth keeping

- The agent is a **manual rebuild** and builds the CLONE's working tree — reset
  the clone to origin first (queue idle), then `build agent && up -d agent`, then
  grep the RUNNING container. Confirmed again here.
- The shared tree moved twice mid-session (another session landed `70a6ca30`
  between my two commits). Committed with explicit pathspec (`git commit -F - --
  <paths>`) every time; never `git add -A`. My commits and theirs interleave
  cleanly; `merge-base --is-ancestor` confirmed nothing was lost.
- A source-guard NEGATIVE match on `requireOwner` first failed because it matched
  the word in my own explanatory comment — strip comments before a negative
  match (documented trap, hit again).
