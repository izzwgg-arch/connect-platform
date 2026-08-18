# AGENT HANDOFF — Connect security audit, Phase 0 discovery (2026-08-16)

**Scope of this session:** read-only discovery across the server, network, TLS,
DNS, SSH and the application's authentication layer, plus **one** code fix
(committed + pushed, **NOT deployed**). No infrastructure was modified. No PBX
interaction of any kind. No Cloudflare change.

Commit: `192837b5` on `feat/ivr-migration-takeover`.

---

## 0. The one-line summary

Connect's **server perimeter is in better shape than expected** (UFW default-deny,
every datastore bound to loopback, modern TLS, fail2ban active, good git hygiene).
Its **application authentication layer is the weak half**: no MFA anywhere, session
tokens that never expire, and — until this session — a brute-force limiter that had
never once executed in production.

⛔ **The premise of the mandate's "Cloudflare as the shield" does not hold today:
Cloudflare is the DNS provider but the application is NOT proxied through it.**
`app.connectcomunications.com` resolves straight to the origin.

---

## 1. ⛔ FIXED THIS SESSION — the login limiter was dead code

`/auth/login` guarded its per-account limiter with:

```ts
const loginRateLimitEnabled = process.env.NODE_ENV === "production" || ...
```

**The api container sets no NODE_ENV.** Proven in the running container, not
inferred:

```
docker exec app-api-1       -> NODE_ENV=[]
docker exec app-telephony-1 -> NODE_ENV=[production]
```

So the limiter had **never run in production**. Same class as the error-leak
handler (`4fb512ed`) and already recorded in memory as
[[api-container-no-node-env]] — but **the pattern was never swept**, and this was
one of seven surviving sites (§4).

Replacement: `apps/api/src/loginThrottle.ts` (+ 20 tests). Reads no NODE_ENV.
`LOGIN_THROTTLE_DISABLED=1` is the only off switch.

### Two traps caught BEFORE shipping

- ⛔ **`req.ip` is useless in this codebase.** Fastify is constructed as
  `Fastify({ logger: true, maxParamLength: 512 })` — **no `trustProxy`** — so
  `req.ip` is the nginx/docker hop, identical for every request platform-wide.
  Keying the source counter on it would have put all customers in one bucket, and
  **six unrelated people mistyping a password within ten minutes would have blocked
  login for the entire platform.** Security work causing the outage it exists to
  prevent.
- ⛔ **Take the LAST `X-Forwarded-For` entry, never the first.** nginx sets
  `X-Forwarded-For $proxy_add_x_forwarded_for`, which *appends* the real peer to
  whatever the client sent. Earlier entries are attacker-controlled. Reading the
  first (the usual mistake) lets an attacker mint a fresh source per request, and
  lets them frame an innocent IP into a block.

### Design rule it encodes (mandate Phase 36)

A forgotten password is not an attack. Per-account failures produce only a short,
self-expiring throttle; a successful sign-in clears them completely; nothing is
ever permanent. The attack signal is a **different dimension** — one source failing
against many *distinct accounts* — which is what earns a source block. Tests cover
forgetful user, Wi-Fi→cellular, shared-NAT office, and "one successful guess must
not erase the stuffing evidence".

⏳ **NOT PROVEN: not deployed, and no real login has been throttled.** Proven by 20
unit tests and a typecheck, nothing more.

⛔ **Known limitation, deliberately not hidden:** state is per-process and
in-memory, so it resets on every deploy and blue/green runs two api processes with
independent budgets — the same weakness that made the ADMIN_ALERT cooldown Map
fail. It is a speed bump, not a wall. It ships this way because it adds **no new
failure mode to the login path**; the store is pluggable for a Redis version later.

### 1b. ⛔ FIXED 2026-08-18 — a short password answered `500 internal_error`

**What it was.** The handler's first line was
`z.object({ email: z.string().email(), password: z.string().min(8) }).parse(req.body)`.
`.parse` THROWS on a bad body, the throw lands in the global `setErrorHandler`
(`server.ts:376`), and that handler — correctly, since `4fb512ed` — turns every
unexpected exception into `500 { error: "internal_error" }`. **Proven live
2026-08-18** with `curl --data @file` against
`https://app.connectcomunications.com/api/auth/login`: `{"email":"x@y.com",
"password":"x"}` → **500**, while a well-formed wrong password → `401
invalid_credentials`. So a person who typed 6 characters read "Server error" in
the portal, and every such request counted as a 5xx on the api.

**The fix.** `apps/api/src/loginRequest.ts` — `parseLoginRequest(body)` uses
`safeParse`, never throws, and returns `{ ok:false, reason }` (reason is
log-only). The handler answers a malformed body **`401 { error:
"invalid_credentials" }`**, i.e. exactly like a wrong password. Decisions,
each deliberate:

- **401, not 400.** The portal renders 401 as "Invalid email or password." and
  any other 4xx as the raw error code — a person should read the former, not
  `invalid_request`. And a password under 8 characters can NEVER be right
  (signup enforces ≥ 8, invite-accept / reset ≥ 10 via `validateNewPassword`,
  every generated temp password is 32 chars), so "invalid credentials" is the
  truthful answer. Same status for wrong and malformed = nothing to tell a real
  account from a missing one.
- **Not counted by the throttle, and answered BEFORE the throttle.** Nothing was
  compared against a credential, so it is not a guess; the answer is identical
  for an existing and an unknown account, so it is not an oracle; it costs no
  bcrypt and no DB round-trip. Counting it would only give an attacker a
  zero-cost way to fill a victim's account counter with garbage. A wrong
  password of ≥ 8 characters keeps counting exactly as before.
- **Metric label `malformed`** on `connect_login_failures_total`, so dashboards
  tell it from `bad_password` / `not_found` / `rate_limit`.

**Tests.** `apps/api/src/loginRequest.test.ts` (11): 23 garbage bodies never
throw and are all refused (incl. the exact live repro `password:"x"`), the
boundary at 8, extra fields tolerated, log reasons per field, no NODE_ENV in the
module — plus four **source guards on the handler** (CRLF-normalised, comments
stripped): no throwing `.parse(req.body)`, `parseLoginRequest` used, the guard
answers 401 `invalid_credentials` (not 400/500), it runs before
`evaluateLoginAttempt` and does not `recordLoginFailure`, label `malformed`.
**All four guards fail against the pre-change `server.ts`** (replayed from
`HEAD` in a scratch mirror) — non-vacuous. `loginThrottle.test.ts` 20/20 and
the portal's `sessionExpiry.test.ts` 23/23 (it pins the api's 401 body) still
pass. api typecheck: 75 → 75 (pre-existing, none in the login path).

⛔ **The pattern is not unique to login.** `server.ts` has ~117 more
`.parse(req.body)` sites (9 files). Every one answers 500 to a malformed body.
Login was fixed first because it is the one unauthenticated public door that
real people mistype into; the rest are authenticated routes where a 500 is a
client bug, not a customer-facing "Server error". Do not "fix" them by
weakening the error handler — fix each with `safeParse` and a deliberate 4xx.

---

## 2. Infrastructure — what is actually GOOD (do not "fix" these)

Verified live 2026-08-16. Recording these so nobody burns a session re-deriving them.

- **UFW is active, default deny incoming.** Open to the world: 22, 80, 443,
  3478/5349 + 49152-65535 (TURN), 35000-35199 (RTP), 51820 (WireGuard). That is it.
- **Every datastore is loopback-only.** Postgres 5432, Redis 6379, MinIO 9000/9001,
  Prometheus 9090, Grafana 3100, and all app containers bind `127.0.0.1`.
- ⛔ **The deploy queue (3910) binds `0.0.0.0` but UFW restricts it to
  `172.16.0.0/12`.** Confirmed unreachable from an external workstation. Testing it
  *from the server itself* returns 401 and **proves nothing** — traffic to your own
  public IP goes through loopback and skips the ufw rule. Test from outside.
- **TLS is correct** — and reading the config would have told you otherwise.
  `/etc/nginx/nginx.conf` still carries Ubuntu's default
  `ssl_protocols TLSv1 TLSv1.1 TLSv1.2 TLSv1.3`, but the certbot include at server
  level overrides it. **Real handshake test: TLS 1.0 refused, 1.1 refused, 1.2 and
  1.3 accepted.** Modern cipher suite, session tickets off. ⛔ Truth-test the
  handshake; do not file a finding off the config file.
- **fail2ban is running** (sshd jail, 774 total bans, 11 currently banned).
- **Git hygiene is clean** — only `.env.example` files tracked; `.connect-ssh/`
  ignored; no keys or secrets in the repo.
- **Let's Encrypt cert valid to 2026-10-22**, auto-renewing.

---

## 3. Findings NOT yet fixed — the ones that need Izzy's word

Full risk/rollback wording is in the session report. Summary:

| # | Finding | Severity |
|---|---|---|
| A | **Portal ships ZERO security headers.** `location /` sets `add_header Cache-Control`, and nginx `add_header` is **not inherited into a block that has its own** — so all five server-level headers (CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy) are cancelled for every HTML page. Proven: `/api/health` returns them, `/login` returns none. The whole customer-facing app is clickjackable and has no CSP. | HIGH |
| B | **Session tokens never expire.** `app.register(jwt, { secret })` sets no `sign.expiresIn`, and `/auth/login` calls `reply.jwtSign(payload)` with no options. No refresh tokens, no session table, no revocation. A token stolen a year ago still works. | HIGH |
| C | **No MFA of any kind.** No TOTP, WebAuthn, passkeys, or step-up auth anywhere in the codebase — including for SUPER_ADMIN, which can move money and provision telephony. | HIGH |
| D | **SSH: `PermitRootLogin yes` + `PasswordAuthentication yes`** against 1,457 failed attempts in 24h / 16,031 total. Root is password-guessable from the internet; fail2ban is the only thing in the way. 8 root keys, several stale agent keys. | HIGH |
| E | **Origin fully exposed.** Cloudflare is DNS-only for `app.` — no WAF, no bot protection, no edge rate limiting, no DDoS absorption, and the origin IP is public. | HIGH |
| F | **No DMARC record**, SPF is `~all`, no DKIM verified — on the domain that sends customer invoices and voicemail notifications. Trivially spoofable. | MEDIUM |
| G | `JWT_SECRET` falls back to the literal `"change-me"` if unset. It **is** set (64 chars, not the fallback) — but the fallback should fail closed, not boot. | MEDIUM |
| H | `.env.platform` is mode **644** (`.env.deploy-queue` is 600), plus **~15 historical backup copies** of it in the same directory. Mitigated by the parent dir being `750 root:root`, so not currently exploitable. | LOW |
| I | `server_tokens off;` is commented out — nginx version leaked in every response. | LOW |
| J | `account_disabled` returns **403** while bad credentials return 401 — a user-enumeration oracle. | LOW |

---

## 4. ⛔ The NODE_ENV sweep nobody did

`NODE_ENV` is empty in `app-api-1`, so **every** `NODE_ENV === "production"` branch
in apps/api is permanently false. Beyond the login limiter, these are live:

- `server.ts:404` — refuses to boot if Cardknox is in simulate mode in production.
  **This payment-safety guard is dead.** If `SOLA_CARDKNOX_SIMULATE=true` were ever
  set, production would silently simulate card charges instead of refusing to start.
- `crm/formStorage.ts:11` — production-only storage-root guard, dead. Same shape as
  the onboarding-uploads data-loss bug.
- `onboarding/publicRoutes.ts:61` — `isProduction()` always false.
- `redis.ts:7,30` — dev fallbacks active in production.

⛔ **The fix is NOT to set NODE_ENV=production on the container** — that would flip
all of them at once with unknown blast radius. Per this repo's own rule, remove the
NODE_ENV dependency from each safety gate so it defaults to secure. One at a time,
each with a test.

---

## 5. Cloudflare — inspected live 2026-08-16 (browser access granted by Izzy)

⛔ **There are still no Cloudflare credentials ON THE SERVER** — that finding stands,
and it is why loopcom cannot call the Cloudflare API on its own. Access came from
Izzy's logged-in browser instead.

⛔ **The dashboard banner "Onboard your agent to Cloudflare — Works with Claude,
Codex, Cursor and OpenCode" is an ADVERT, not a status.** It reads like a connected
integration and is not one; the API-tokens page listed **zero tokens**, which is the
authoritative check. There is also **no Cloudflare connector in the MCP registry**.

**Account:** `Support@connectcomunications.com's Account`. **Plan: Free Website.**

**All 8 DNS records, and which are actually protected:**

| Record | Target | Proxy |
|---|---|---|
| `app.` | 45.14.194.179 (origin) | ⛔ **DNS only** |
| apex | 31.220.77.60 (marketing) | DNS only |
| `m.` | 209.145.60.79 (**the PBX**) | DNS only — ⛔ must STAY that way |
| `portal.` | ui.zswitch.net (3rd-party Telocall GUI) | ✅ Proxied — the ONLY one |
| `www` | CNAME apex | DNS only |
| MX / SPF / DKIM | Google | n/a |

**Total requests through Cloudflare in 24h: 1.** The edge is doing nothing.

✅ **DKIM DOES exist** (`google._domainkey`, Google 2048-bit) — an earlier note in
this file said DKIM was unverified; it is present and correct.

### Live edge settings read via API

`security_level medium` · `always_use_https` **off** · `automatic_https_rewrites on` ·
`min_tls_version` **1.0** · `ssl` **full** (not strict) · **HSTS disabled**.

### Changed this session

1. ✅ **DMARC added** — `_dmarc TXT "v=DMARC1; p=none; rua=mailto:support@connectcomunications.com"`.
   Verified resolving publicly. ⛔ **`p=none` is MONITOR ONLY — it does not block
   spoofing yet.** It exists to collect reports; tightening to `p=quarantine` then
   `p=reject` is a later step, only once reports confirm every legitimate sender
   passes. Claiming the domain is now protected from spoofing would be false.
   Rollback: delete the record.
2. ✅ `min_tls_version` 1.0 → **1.2**, `always_use_https` off → **on**. Both affect
   **proxied traffic only**, so today they touch `portal.` alone and are pre-staging
   for a future `app.` cutover. Rollback: PATCH the setting back.
3. ✅ **API token `connect-security-sentinel`** — Zone-scoped to this zone only:
   `Zone Settings:Edit`, `DNS:Edit`, `Firewall Services:Edit`. No account-level
   rights, no User rights.

⛔ **NOT enabled, deliberately: HSTS.** It is semi-permanent (browsers cache the
policy) and must not be turned on until `app.` is proxied and proven fully healthy
over HTTPS. Enabling it early can make a broken state unreachable.

⛔ **Token-handling mistake, recorded so it is not repeated:** the token value was
captured in a zoomed screenshot while confirming creation, putting a live
edit-capable credential into the session transcript. It was **rolled** (Cloudflare's
"Roll" keeps the permission set and issues a new secret) and the exposed value was
**verified dead** — `/user/tokens/verify` answers `Invalid API Token`. ⛔ When a
secret is displayed once, do not screenshot the region "just to confirm success" —
confirm from the token LIST page, which shows name and status but never the value.

**Also out of reach without approval:** every fix in §3 touches infrastructure that
`AGENTS.md` explicitly puts off-limits to agents (nginx config, `/etc/ssh/`, ufw,
`/opt/connectcomms/env/`).

---

## 6. ⛔ Mistake made this session, recorded so it is not repeated

A `git stash push -q <paths> 2>/dev/null && …` failed silently, and an
unconditional `; git stash pop -q` on the same line then popped an **unrelated
2026-06-29 mobile stash** into the shared working tree, creating conflict markers in
three `apps/mobile` files that belonged to another session's work.

Recovered fully — `git restore --source=HEAD --staged --worktree` on the four
affected files; the stash entry was kept by git, so nothing was lost, and the tree
returned to exactly its session-start state.

⛔ **Never run `git stash pop` unconditionally after a `git stash push` that can
fail, and never use stash at all for a "compare against baseline" check in this
repo** — the tree is shared with live sessions. Compare by inspecting which files
the errors land in instead.

---

## 7. Sentinel

Not started, and deliberately so. Turning the agent into a continuous security
monitor is real multi-week work (telemetry ingestion, normalized event schema,
baselining, correlation, graduated response, self-protection against prompt
injection) and it depends on things that do not exist yet — there is no session
table to revoke, no device registry to trust, no MFA to step up to, and no
Cloudflare feed to ingest. **Building the intelligence layer before the foundation
would produce a dashboard that watches an unlocked door.** Order of work is in the
session report.

---

## 8. Finding B (session tokens never expire) — Phase 1 investigation, 2026-08-18. ⛔ STOPPED BEFORE BUILDING, deliberately

**Read-only. No code changed, nothing deployed, no env, no PBX, no tenant row.**
The brief was: establish from the code whether adding `expiresIn` is survivable
by the clients, and STOP for a decision if they do not handle a 401 gracefully.
**They do not — and worse, a dead token in the portal produces a 401 stream that
trips the nginx auto-ban of the customer's own office IP.** So nothing was built.
This section is the evidence, so the next session does not re-derive it.

### 8.1 Every place a JWT is minted (all against the one `JWT_SECRET`)

| Where | For whom | `expiresIn` | Notes |
|---|---|---|---|
| `apps/api/src/server.ts:5817` `POST /auth/login` | the signing-in user | **none** | portal, desktop AND mobile all sign in here |
| `apps/api/src/server.ts:6006` `POST /auth/mobile-qr-exchange` | the paired mobile user | **none** | "same shape as /auth/login" |
| `apps/api/src/server.ts:5743` `POST /auth/signup` (tenant self-signup) | the new user | **none** | |
| `apps/api/src/server.ts:6125` `GET /me` | the caller, **only when their DB role differs from the token's role** | **none** | the ONLY existing "refresh" — see 8.3 |
| `apps/api/src/server.ts:41082` `injectAsService` (agent confirm routes) | the confirming admin, read from `User` | **2m** | in-process `app.inject`, never handed to a caller |
| `apps/api/src/didSwitchSchedule.ts:117` `injectAsService` | `sub: "scheduler:<id>"`, role SUPER_ADMIN | **2m** | callers `:445` / `:488` (switch-to-connect / -pbx) |
| `apps/agent/src/transcription/voicemailJob.ts:117` | `sub: "agent-voicemail"`, `tenantId: ""`, SUPER_ADMIN | **300 s** | hand-rolled HS256, ⛔ lives in the AGENT image (manual rebuild) |
| `apps/agent/src/notify/voicemailEmailJob.ts:212` | `sub: "agent-vm-email"`, same shape | **300 s** | same |

⛔ **Three service principals carry a `sub` that is NOT a `User.id`**
(`scheduler:*`, `agent-voicemail`, `agent-vm-email`). Any per-request "look the
user up and check they are ACTIVE" rule that rejects an unknown `sub` outright
**silently kills the DID switch scheduler, the drift reconciler, voicemail
transcription and voicemail email.** A revocation check must recognise them —
safest signal available today: no `User` row **and** a short-lived token
(`exp − iat ≤ 15 min`) = service principal; no `User` row and long-lived or
`exp`-less = a deleted user's session, reject. The two agent-side minters cannot
be changed without an agent rebuild, so the rule has to fit what they already emit.

Verifiers of the same secret elsewhere (they already honour `exp` because
`jsonwebtoken.verify` does by default): `apps/telephony/.../TelephonySocketServer.ts:173`
(closes the WS `1008 Unauthorized`), `apps/telephony/src/routes/telephony.ts:37`,
`apps/realtime/src/server.ts:23`, `apps/agent/src/auth.ts:24`.

### 8.2 How the clients store the token and what a 401 does to them

**Mobile (`apps/mobile`)** — `context/AuthContext.tsx` keeps the token in
SecureStore (`cc_mobile_token`) and mirrors it to native storage on Android for
the notification reply receiver. `api/client.ts` is a thin `fetch` wrapper: every
call `throw new Error(json?.error || "…_FAILED")` on `!res.ok`. **There is no 401
handling anywhere in the app** (`grep -rn "401" apps/mobile/src` hits only the SIP
code's SIP-401). Nothing clears the token, nothing shows the login screen. On an
expired token the phone keeps its cached SIP provisioning bundle
(`cc_mobile_provision`) so it still registers and rings **for a while**, but:
`getFreshIceServers` fails → the TURN overlay stops refreshing → within 24 h the
device is **relay-dead again (the 2026-07-29 fleet-wide `iceHasTurn:false`
failure, self-inflicted)**; `registerMobileDevice` fails and is swallowed with a
`console.warn` (`NotificationsContext.tsx:1954`) so `lastSeenAt` goes stale and the
device drops out of every `lastSeenAt: { gte: … }` filter (worker registration
watchdog `main.ts:1568`, wake canary enrolment); chat, voicemail, contacts,
recents all error with a slug. **The user is never told to sign in again.**
Fixing this needs a mobile release (APK + TestFlight) — Izzy's call.

**Portal + desktop (`apps/portal`; the desktop app wraps the hosted portal)** —
token in `localStorage` (`services/session.ts`). `AuthGate` only checks that a
token STRING exists; `services/apiClient.ts` throws `ApiError(status 401)` and
**no global handler clears the session or redirects to `/login`**. `/me` failing
falls back to cached permissions (`useAppContext.tsx:252`) and renders the shell.
The background loops keep running with the dead token: mini-dialer `refreshLists`
every 30 s, `DesktopNotificationsBridge` every 30 s, `NotificationPanel` every 60 s,
chat 7 s poll when open, `useSipPhone` init backing off to one request a minute,
telephony WS reconnecting on every `1008` close. ⛔ **`monitor.sh` bans an IP for
60 min at >30 × 401 in 5 minutes.** One parked desktop app ≈ 8–12 401s per 5 min;
two PCs behind one office IP plus an open chat tab clears the threshold. **So
"expire the token" reads, on the customer's side, exactly like the 2026-08-17
blank-app incident: the office goes 403 on everything, and reopening the app
cannot help because the ban refuses the page's own JavaScript.**

### 8.3 Existing refresh — partial, portal-only, accidental

`GET /me` re-signs a token when the DB role no longer matches the claim, and the
portal writes it back (`useAppContext.tsx:188` → `writeAuthToken`). That is a
role-refresh, not a session-refresh, and the mobile app never calls `/me`. There
is no refresh token, no session table, no revocation list.

### 8.4 Per-request re-validation: NONE

The preHandler (`server.ts:6056`) does `req.jwtVerify()` and then reads the
claims. It never touches the `User` row. **A DISABLED user's existing token keeps
working on every route** — `status === "DISABLED"` is checked only at
`/auth/login` (`:5797`) and invite acceptance. There is no `tokenVersion` /
`sessionsInvalidatedAt` field on `User` (schema checked), so a password change or
a compromise cannot invalidate anything a user already holds.

### 8.5 The 401 shape

`{ "error": "unauthorized" }`, HTTP 401, identical for missing / malformed /
wrong-secret / expired. `@fastify/jwt` will enforce `exp` the moment a token
carries it — no api change needed for the *rejection* half, which is precisely why
adding `expiresIn` is a one-line change with platform-wide blast radius.

### 8.6 Decision

**Do not ship expiry or per-request revocation until the clients can survive a
401.** The order that is safe, each step independently deployable:

1. **Portal:** a global 401 handler in `apiClient.ts` — on `unauthorized`, clear
   the session and route to `/login?next=…` (respecting the desktop passive-window
   rule in `AuthGate`), and make every background poller stop on the first 401
   rather than back off. This is what turns "token expired" into "please sign in"
   instead of "office banned". Portal-only deploy.
2. **Mobile:** on 401 from any authenticated call, clear `cc_mobile_token`, stop
   the SIP stack, and show the login screen; add a sliding refresh (e.g.
   `/mobile/devices/register` returning a fresh token that the app persists) so a
   phone in daily use never reaches the wall. **Needs an APK + TestFlight build,
   and Izzy's word.**
3. **Server, only after 1 and 2 are on every phone that matters:** `expiresIn`
   (30 d) on the three user-session mint sites; a `sessionsInvalidatedAt` (or
   `tokenVersion`) column + migration; a per-request status/version check behind
   a `permissionCache.ts`-style short-TTL cache keyed by `sub`; the
   service-principal rule from 8.1; and a decision on `exp`-less legacy tokens
   (grandfather for a window, then reject — rejecting on day one signs out every
   existing session, including every phone).
4. Only after all of that: exempt `/api/auth/login` and `/api/me` 401s from the
   nginx ban counter so a signed-out client trying to recover cannot ban itself.

⛔ **The tempting shortcut — ship revocation alone ("just reject DISABLED users
per request") because it does not touch `exp` — has the same failure mode:** the
disabled user's parked desktop app becomes a 401 stream on the shared office IP.
Today, disabling a user leaves their token working (bad) but bans nobody. Step 1
must land first regardless.

### 8.7 Step 1 is DONE — the portal survives a 401 (2026-08-18)

Commit `93fb96d1` on `feat/ivr-migration-takeover`. **Portal only — no api, no
mobile, no env, no nginx, no PBX. Token expiry is NOT turned on; steps 2
(mobile) and 3 (server) remain exactly as written in 8.6.** Deployed with
`deploy-direct.sh portal`; verification below.

**What was built, and where the one rule lives:** `apps/portal/lib/sessionExpiry.ts`.

- **The classifier.** A response is "session dead" iff it is `401`, its JSON body
  is `{ error: "unauthorized" }` (any case), **and the request was sent with a
  bearer token**. That is read from the api, not guessed: the JWT preHandler
  (`apps/api/src/server.ts` ~6081) answers exactly that for a missing / bad /
  expired token, and every route-level `!req.user?.sub` guard sends the same
  body. **Permission failures answer `403 { error: "forbidden" }`** —
  `requirePermission`, `requireAdmin`, `requireRoleOrPortalPermission`, and the
  portal-permission gate in the same hook — so opening a screen you lack
  permission for does NOT sign you out. The other 401 bodies the api can send
  (`invalid_credentials` on `/auth/login`, `bad_signature` on signed URLs,
  `missing secret` on machine doors) are excluded by body. A test reads
  `server.ts`'s source and pins that contract — if the api's 401 body ever
  changes, `sessionExpiry.test.ts` goes red before a customer notices.
- **The handler, once per dead token:** `clearAuthSession()` → dispatch
  `cc-session-expired` on `window` → in a full window on an authenticated path,
  `window.location.replace("/login?next=<path+search>")`. Keyed on the token
  itself, so twenty concurrent 401s from twenty pollers = one clear, one
  navigation. Public paths (`/login`, `/auth/`, `/p/`, `/pay/`, `/onboarding/`,
  `/track/`, `/forms/`, `/privacy`) are never redirected — the token is cleared
  and that is all. Desktop passive windows (`/desktop/mini-dialer`,
  `/desktop/phone-engine`) are never redirected either: `AuthGate` drops their
  content and waits for the main window's next sign-in (the `storage` event
  crosses windows) — the same wait it already used for a missing token.
- **Why every poller stops without editing every poller:** before sending,
  `apiRequest` refuses — locally, no network — any request that would carry the
  dead token or no token on an authenticated path (`shouldShortCircuit`). The
  pollers keep ticking for the few hundred ms until the hard navigation lands or
  `AuthGate` unmounts them, and every tick ends in a local throw instead of at
  nginx. A NEW token (someone signs in again) re-arms the module with no reload,
  which is what brings a passive window back.
- **The pollers that live OUTSIDE `AuthGate`** (mounted from `app/providers.tsx`
  on every page including `/login`) needed their own gate, because a hard
  navigation to `/login` remounts them and they used to fire unauthenticated
  401s there: `DesktopNotificationsBridge` (30 s), `RemoteSupportConsent` (5 s —
  60 per 5 min is exactly the ban threshold, though only the Loopcom Support
  build mounts it), and `useSipPhone`'s extra-accounts fetch. All three now check
  `hasBrowserAuthToken()` first. `useSipPhone`'s primary init and `AppProvider`'s
  `/me` already did.
- **The telephony WebSocket** (`hooks/useTelephonySocket.ts`) never opens a
  socket without a token any more, and on `1008 Unauthorized` asks `/me` ONCE
  before deciding — because `TelephonySocketServer.ts:187` also closes 1008 when
  its own `resolveUserExtensions` throws, so a close alone is not proof. A dead
  session: the global handler fires as a side effect of that `/me` and the hook
  stops. A live one: the normal backoff continues. A sign-in event
  (`cc-portal-permissions-saved` / `storage`) brings the feed back without a
  reload — before this, a tab that sat on `/login` for ~5 min exhausted its 20
  reconnect attempts and the live-call feed was dead until reload.
- **`AuthGate`** listens for the event, drops the shell immediately (every
  poller under it unmounts on that render), and does not race the handler's hard
  navigation with a second client-side one (`hasNavigatedToLogin()`).

**Tests:** `apps/portal/lib/sessionExpiry.test.ts` — 23 cases, registered in
the portal `test` script. Covers: the classifier matrix (dead / permission 403 /
`invalid_credentials` / `bad_signature` / no-token / non-JSON), the once-per-token
idempotence (20 calls → 1 clear, 1 redirect), public paths never redirected,
passive windows never redirected, the short-circuit (dead token and empty token
refused on authenticated paths, never on public paths, re-armed by a new token),
and source guards on every call site. ⛔ Source reads are CRLF-normalised.
**Proven non-vacuous:** all four source guards fail against the pre-change files
from `HEAD`; the api-contract guard passes against both. Portal typecheck **0
errors**; suite 156/158 with the two pre-existing failures.

**⛔ What could NOT be tested, honestly.** The dead-session path end to end
needs a real signed-in session whose token the api then refuses — and the api
refuses no token today (nothing expires) and I do not sign in with real
credentials. So it is proven by unit tests, the classifier contract read from the
api's source, a clean typecheck, and browser evidence on the public paths (below)
— **not by a human watching a stale session get sent to `/login`.**

**Acceptance test for a human, 3 minutes, no api change needed:** sign in on a
browser tab, open DevTools → Application → Local Storage, overwrite `token`,
`cc-token` and `authToken` with any garbage string (that is exactly what an
expired token looks like to the api: `401 { error: "unauthorized" }`), then wait
for the next poller tick (≤ 30 s) or click anything. Expect: ONE hop to
`/login?next=<the page you were on>`, the three keys cleared, and — the negative
that matters — **no further `/api/*` requests in the Network tab** after the
redirect except the login page's own. Then sign in: you land back where you were.
Repeat with the desktop app: the main window goes to `/login`, the mini-dialer
shows "Signed out — sign in again from the main Connect window", and comes back
by itself after the sign-in. And the permission negative: as a TENANT_ADMIN,
`GET /api/admin/wake-health` (403 `forbidden`) must NOT sign you out.

**⏳ Observed in passing, NOT changed, and worth checking before step 3:** in a
browser, a sign-in navigates client-side (`router.replace`) and
`SipPhoneProvider` (mounted from `providers.tsx`) runs its init effect only once
per page load, returning early when there was no token at that moment
(`useSipPhone.ts` ~1503, "A login navigates/reloads, which re-runs this effect").
If that comment is wrong — if the softphone does not initialise after a login
without a reload — then the flow this work creates (expired → `/login` → sign in
→ back) would leave the browser softphone un-registered until a reload. Today the
same question applies to every sign-in from a signed-out tab. Not investigated;
the desktop app is different (its engine lives in the phone-engine window).
