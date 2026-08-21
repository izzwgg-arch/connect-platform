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

✅ **api DEPLOYED and container-verified 2026-08-18** — commit `e9a79c57`, queue job
`4bcde036` (`verify: container commit e9a79c57b221 matches target`), and the original
curl repro re-run over public HTTPS now answers `401 invalid_credentials`. Full
transcript in `TESTS_RUN.md`.

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
| D | ✅ **FIXED 2026-08-19 (§10)** — keys only now. Was: **SSH: `PermitRootLogin yes` + `PasswordAuthentication yes`** against 1,457 failed attempts in 24h / 16,031 total. Root is password-guessable from the internet; fail2ban is the only thing in the way. 8 root keys, several stale agent keys. | HIGH |
| E | **Origin fully exposed.** Cloudflare is DNS-only for `app.` — no WAF, no bot protection, no edge rate limiting, no DDoS absorption, and the origin IP is public. | HIGH |
| F | **No DMARC record**, SPF is `~all`, no DKIM verified — on the domain that sends customer invoices and voicemail notifications. Trivially spoofable. | MEDIUM |
| G | ✅ **FIXED 2026-08-19 (§10)** — fails closed at boot. Was: `JWT_SECRET` falls back to the literal `"change-me"` if unset. It **is** set (64 chars, not the fallback) — but the fallback should fail closed, not boot. | MEDIUM |
| H | ✅ **FIXED 2026-08-19 (§10)** — `600`, backups too. Was: `.env.platform` is mode **644** (`.env.deploy-queue` is 600), plus **~15 historical backup copies** of it in the same directory. Mitigated by the parent dir being `750 root:root`, so not currently exploitable. | LOW |
| I | ✅ **FIXED 2026-08-19 (§10)**. Was: `server_tokens off;` is commented out — nginx version leaked in every response. | LOW |
| J | ✅ **FIXED 2026-08-19 (§10)** — checked only after bcrypt. Was: `account_disabled` returns **403** while bad credentials return 401 — a user-enumeration oracle. | LOW |

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

---

## 9. Phase 11 — MFA (TOTP) is BUILT: administrators can carry a second factor, ordinary users can opt in (2026-08-18)

Full handoff: **`AGENT_HANDOFF_MFA_2026-08-18.md`** (route map, the exact login
contract, the mobile limitation, the hard-enforcement flip, tests). Summary:

- **Before:** zero MFA anywhere. `/auth/login` = bcrypt → JWT with no expiry, and the
  one SUPER_ADMIN could move money and provision telephony with a password alone.
- **Now:** TOTP (RFC 6238, no new dependency) with ten bcrypt-hashed single-use
  recovery codes; the secret encrypted at rest with the same AES-256-GCM /
  `CREDENTIALS_MASTER_KEY` envelope every other credential uses; `/auth/login` for an
  enrolled account answers a **5-minute pre-auth token** (signed with a key DERIVED
  from `JWT_SECRET`, so every verifier on the platform rejects it as a session
  unchanged) and `POST /auth/mfa/challenge` turns it into the ordinary session body;
  the challenge is throttled on the same account + source dimensions as the login
  throttle (own instance, 5 wrong codes → 10 min); enrol / disable / recovery-code
  use / admin reset are audited; the portal has the sign-in step and a Security page.
- **Enforcement is GRACE, by design and by default:** `MFA_REQUIRED_ROLES` defaults to
  `SUPER_ADMIN`; an unenrolled admin still signs in and is prompted (sign-in redirect
  to `/account/security` + a dashboard banner). `MFA_ENFORCEMENT=required` (NOT set)
  refuses their login with `403 mfa_enrollment_required` — flip only after every
  required-role person has enrolled (§8 of the MFA handoff has the query).
- **Normal login is unchanged, proven from the source:** the no-MFA body is exactly
  `issueLoginSession`'s `{ token, portalPermissionSet? }`; a wrong password answers the
  identical 401 whether or not MFA is on (the decision runs only after bcrypt).
- ⛔ **Mobile has no MFA UI.** A user who enrols cannot finish sign-in on the current
  app (`login()` throws on a body with no `token`; the body says `error: "mfa_required"`
  so it reads as that, not `LOGIN_FAILED`). Opt-in exposure only; grace forces nobody.
  `/auth/mobile-qr-exchange` deliberately untouched.
- **What this does NOT change:** tokens still never expire (Finding B / §8 above),
  there is still no session table, and the mobile 401 gap from §8.2 stands.
- Deploy status is recorded in CLAUDE.md's MFA section and `TESTS_RUN.md`.

## 10. Round 2 hardening — the dead rate limiter, keys-only SSH, both-hostname parity (2026-08-19)

`eeec0002`, api DEPLOYED and container-verified; nginx + sshd + env changes live.
CLAUDE.md carries the summary section; this is the record of what was measured.

### 10.1 The global rate limiter had never run (audit §6i, re-read)

`app.register(rateLimit, { max: 200, timeWindow: "1 minute" })` at `server.ts:356`,
un-awaited, followed by ~480 synchronous route declarations. `@fastify/rate-limit`
10.3.0 with `global: true` attaches through `fastify.addHook('onRoute', …)`; Fastify
5.7.4 runs `onRoute` hooks synchronously inside `addNewRoute` — at declaration time.
The plugin's `onRoute` hook did not exist yet when any route was declared, so no route
ever got the limiter. Evidence, read-only, before the fix: 24 h of nginx logs — 56 ×
429 total, all from `/voice/me/extension`'s own route limiter; peak **357 req/min**
platform-wide; `docker logs app-api-1 | grep -c "Rate limit exceeded"` → 0; and
`curl -I` on `/health`, `/me`, `/admin/tenants`, `/voice/me/extension` — **no
`x-ratelimit-*` header on any of them**. Lifecycle hooks (`onRequest` etc.) are
different: `route.js` snapshots `this[kHooks][hook]` at `avvio.once('preReady')`,
so a hook added inside `app.after()` binds to every route. Hence:
`app.register(rateLimit, { global: false })` + `app.after(() => app.addHook("onRequest",
app.rateLimit(buildGlobalRateLimitOptions(max))))`.

**Sizing (per real IP per minute on `/api/`):** current log top bucket 93 (overnight);
full previous day top **167** (50.48.58.53 = Izzy), next 137; distribution over 17,209
buckets: >100: 20, >150: 1, >200: 0. Two days earlier: 523/480 (38.105.207.69 = the
Gesheft voicemail-flood bug that got the office banned), 379/208 (94.26.67.x, same
family). Ceiling **480/min**; `monitor.sh` bans at >1200/5 min behind it. Exempt:
header-less callers (docker peers — the api port is `127.0.0.1:3001` so nothing external
is header-less) and `/internal/*`. Key = last `X-Forwarded-For` entry.

### 10.2 SSH (finding D)

`sshd -T` before: `permitrootlogin yes`, `passwordauthentication yes` — the latter from
`sshd_config.d/50-cloud-init.conf` (`yes`), which beat `60-cloudimg-settings.conf`
(`no`) because sshd takes the FIRST value. **`auth.log` held 28 `Accepted password for
root`, all from `50.49.194.85`, latest 2026-07-25**; 1,784 key logins in the current
log (one fingerprint dominant); 1,222 failed password guesses in 24 h; fail2ban 1,181
total bans. Change: `PermitRootLogin prohibit-password`; `50-cloud-init.conf` →
`PasswordAuthentication no`; `sshd -t`; `systemctl reload ssh` (never restart);
fresh key login proven; `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password`
→ `Permission denied (publickey)`. Backup `/root/sshd-backup-20260819T032626Z/`.
⛔ Rollback = restore both files, `sshd -t`, `systemctl reload ssh`.

### 10.3 nginx / env (findings I, H) + HSTS

`server_tokens off;` uncommented in `/etc/nginx/nginx.conf` (backup
`/root/nginx.conf.bak.20260819T032612Z.server-tokens`) → `Server: nginx` on both hosts.
`chmod 600 /opt/connectcomms/env/.env.platform*` (24 backups; dir already `750`).
HSTS `max-age=86400` added to `security-headers.conf` AND at server level in both
vhosts (backup `/root/nginx-hsts-backup-20260819T033141Z/`); verified on `/login` and
`/api/health` on both hosts. No `includeSubDomains`, no preload — deliberately.

### 10.4 `app.loopcom.net` parity

Vhosts normalised (hostname → HOST, cert path → HOST) and diffed: only `location /brand/`
differed (present on `connectcomms` only) — added to `connectcomms-loopcom` (backup
`/root/nginx-connectcomms-loopcom-backup-20260819T032708Z-brand.conf`), verified
`cache-control: public, max-age=31536000, immutable` on both. SIP vhosts identical
except `server_name`. Both vhosts have no `access_log` directive → default
`/var/log/nginx/access.log`, the one `monitor.sh` reads; both include
`allowlist.conf`/`denylist.conf`. Certs: 4, all auto-renewing, `certbot renew
--dry-run` clean, timer next 23:53. Surface check (11 paths, headers, TLS, cert) —
identical on both. **Mail posture differs**: `connectcomunications.com` has SPF
(`include:_spf.google.com ~all`), DMARC `p=none`, Google DKIM; **`loopcom.net` had
DMARC `p=none` only — no SPF, no DKIM selector published** — while
`billing/emailTemplates.ts` names `billing@loopcom.net`. ✅ **CLOSED 2026-08-19, live
in the browser with Izzy:** TXT `@` `v=spf1 include:_spf.google.com ~all` added at
Squarespace; DKIM generated in Google Admin (2048-bit, selector `google`), TXT
`google._domainkey` added, `dig` at `nsc1.squarespacedns.com`, `8.8.8.8` and `1.1.1.1`
returned the value **byte-identical** to Google's (408 chars) before "Start
authentication" was pressed; Google now reads *"Authenticating email with DKIM"*. Both
domains: SPF + DKIM + DMARC `p=none`. Traps: Squarespace's per-write "Verify to continue"
opens a Google popup outside the automation tab group (Izzy clicks it); the TYPE control
is a custom div (open it, scroll, click TXT — the last column's label flipping to TEXT is
the tell); `admin.google.com` re-asks the password every time (his). DMARC stays `p=none`
until the `rua` reports are clean.

### 10.5 What this deliberately did NOT do

`PUBLIC_PORTAL_URL` (the canonical host in every emailed link) is unset, so links fall
back to `app.connectcomunications.com` — a branding decision, one env line, Izzy's.
`POST /lan-phones/runs` stays permission-less by design (the customer's own Windows app
reports). The five `/internal/delivery/*` doors are secret-gated and the secret is
unset. `loopcom.net` apex/`www` untouched. Cloudflare untouched. MFA enrolment, the
mobile 401 build and `expiresIn` are unchanged.

## 11. Round 3 — Loopcom parity in CODE: one public-identity module, same-origin everywhere, `/auth/signup` shut (2026-08-19)

`6a0f3a01`. api + portal DEPLOYED and container-verified. Izzy's mandate: the whole
platform becomes Loopcom; set it up 100% in parallel before the old domain is removed.

### 11.1 The inventory (why a module, not a sweep of string replaces)

`grep -rn "connectcomunications.com" apps packages --include=*.ts --include=*.tsx`
(excluding tests/comments) found the literal in ~30 executable places in apps/api
alone, plus the worker, `packages/integrations`, the portal and the mobile app. They
disagreed with each other: pay links read `PUBLIC_PORTAL_URL` **or** `PORTAL_PUBLIC_URL`
**or** `CONNECT_APP_URL` **or** `APP_PUBLIC_URL` **or** nothing (11 pay-link sites had
no override at all); the PBX webhook default, the Cardknox callback and the OAuth
redirect each had their own chain. A rebrand by string replace would have left the
seven env names disagreeing exactly as before.

### 11.2 `apps/api/src/publicOrigins.ts`

- `PLATFORM_PORTAL_HOSTS = { app.connectcomunications.com, app.loopcom.net }`.
- `canonicalPortalOrigin()` — `PUBLIC_PORTAL_URL` → `PORTAL_PUBLIC_URL` → `CONNECT_APP_URL`
  → `APP_PUBLIC_URL` → default; `canonicalApiBase()` = origin + `/api`. For **durable**
  links (emails, PDFs, texted pay links) that must still work when opened months later
  from anywhere. **One env flip moves the platform.**
- `requestPortalOrigin(req)` — `x-forwarded-host`/`host`, accepted **only** when it is
  one of our hosts (else the canonical); `portalOriginForRequest` / `apiBaseForRequest`
  for **browser-facing** answers (the pay page a customer is already on, the QR the
  portal draws). A forged `Host` header cannot mint a link to an attacker's domain.
- `oauthRedirectUriForRequest(req, registered)` — keeps the registered PATH, swaps only
  the origin, at both the start and the code-exchange step (Google requires the two to
  match byte-for-byte). ⛔ Register `https://app.loopcom.net/api/crm/email/oauth/callback`
  and the drive callback in Google Cloud — until then Loopcom OAuth fails **at Google**.
- `platformMailDomain()` / `platformSupportEmail()` / `platformBillingFromEmail()` /
  `platformNoreplyEmail()` / `platformWebsite()` — `PLATFORM_MAIL_DOMAIN` (default
  `connectcomunications.com`), so the From/Reply-To of every email flips with one var.
  ⛔ Flipping it to `loopcom.net` requires the mailboxes to EXIST in Google Workspace and
  the SMTP credentials to be for that domain — the domain being verified is not that.
- `publicOrigins.test.ts` (11): resolution order, host allow-list, OAuth path-keeping,
  and a **tree sweep** that fails if the literal hostname reappears as executable code
  anywhere in `apps/api/src` (allow-list: `LEGACY_SIP_WS_URL` in `sipPublicEndpoint.ts`,
  a deliberate pin).

### 11.3 Sites routed through it

api: `server.ts` (pay links ×11, invite/e911/port emails, PBX webhook default, SBC
probe, dev-only URLs), `billing/{billingEmailLifecycle,emailTemplates,payLink,routes,pdf}.ts`,
`billing/serviceInterruption/serviceInterruptionRunner.ts`, `androidApkInviteUrl.ts`,
`userEmailTemplates.ts`, `crm/{formService,emailRoutes,driveRoutes}.ts`,
`connectChatRoutes.ts`, `signalwire/signalWireRoutes.ts`, `onboarding/setupOrchestrator.ts`.
Worker: `connectChatSmsJob.ts`. `packages/integrations`: `pbx-wirepbx`, `sola-cardknox`
(the latter had used `PORTAL_PUBLIC_URL`, an origin, as an API base). Portal:
`hooks/useTelephonySocket.ts` (`resolveTelephonyWsUrl(envValue, loc)` — same-origin
unless the build env names the very host you are on, or localhost),
`components/AppDownloadCard.tsx`, `navigation/navConfig.ts` (relative
`/desktop/...`), `lib/platformIdentity.ts` + the onboarding pages;
`docker-compose.app.yml` no longer bakes `NEXT_PUBLIC_TELEPHONY_WS_URL` to the old host.
Mobile: `src/config/publicOrigin.ts` (`DEFAULT_PUBLIC_ORIGIN`, `DEFAULT_API_BASE`,
`DEFAULT_TELEPHONY_WS_URL`, `resolveApiBase`) used by `api/client.ts`, `api/realtime.ts`,
`context/NotificationsContext.tsx`, `screens/DiagnosticsScreen.tsx`, `sip/jssip.ts` —
no behaviour change until a build ships.

### 11.4 `/auth/signup`

Was: public, unverified, `role = email.startsWith("support") && endsWith("@connectcomunications.com") ? "ADMIN" : "USER"`.
0 references in the repo, 1 hit in 14 days of nginx logs. Now: `PUBLIC_SIGNUP_ENABLED=1`
required (else `404 not_found`, indistinguishable from an unrouted path), role always
`USER`. `ADMIN` is the role that arms the three latent findings recorded in the
tenant-isolation audit (§6a/§6b/§6h) — no code path may hand it out from a request.

### 11.5 What parity does NOT yet cover (Izzy / browser)

Google Workspace: are `support@` and `billing@loopcom.net` mailboxes or aliases (an
alias delivers, but SMTP `From:` needs the sending account to own it); Google Cloud
OAuth redirect URIs for `app.loopcom.net`; `m.loopcom.net` → PBX (Squarespace A record +
PBX cert = PBX write); `loopcom.net` apex forwarding (→ `app.loopcom.net` or the coming
`loopcom.ai` site); the `PUBLIC_PORTAL_URL` flip (the cut-over lever); the legal entity
name on invoice PDFs; Loopcom-branded mobile/desktop builds; moving `loopcom.net`'s NS to
Cloudflare (a decision, not a task).

## 12. Round 4 — per-tenant sign-in code (2FA by text/email) + Cloudflare Turnstile (2026-08-19)

`fc551996`. api DEPLOYED (migration `20260819080000_tenant_login_otp` applied) + portal
DEPLOYED. Every switch OFF. Izzy's spec, verbatim: *"2FA with a switch to turn it on and
off per tenant. When they log in, they get a text or email with a code, and they have to
hit 'Remember me' to be able to log in without it. They should have to re-login every 90
days if 2FA is enabled."* Plus *"the Cloudflare check in the login page."*

### 12.1 Data

`Tenant.loginOtpRequired Boolean @default(false)`, `Tenant.loginOtpChannel String
@default("EITHER")` (`EMAIL|SMS|EITHER`); `LoginOtpChallenge` (userId, tenantId,
preAuthJti, channel, destinationMasked, **codeHash**, attempts, sendCount, expiresAt,
consumedAt); `TrustedLoginDevice` (userId, tenantId, **tokenHash @unique**, label,
expiresAt, lastUsedAt, revokedAt). Migration verified column-identical to
`prisma migrate diff`. `Prisma.ModelName` carries both — a test asserts every
`(db as any).xxx` accessor in the routes maps to a real model.

### 12.2 The login contract (`server.ts /auth/login`, order pinned by a source guard)

```
throttle (evaluateLoginAttempt)
→ Turnstile gate (turnstileGate — before ANY DB read)
→ user lookup → bcrypt
→ TOTP decision (decideLoginMfa)            # unchanged
→ OTP gate (checkTrustedDevice → decideOtpGate)
     none      → issueLoginSession (byte-identical pre-2FA body)
     trusted   → issueLoginSession (90d)
     challenge → 200 { otpChallengeRequired: true, preAuthToken, expiresInSeconds: 300,
                       channel, channels, destination, sent, error: "otp_required" }
```

`decideOtpGate({ tenantOtpRequired, userHasTotp, trustedDevice })`: OFF → none;
TOTP-enrolled → none (the authenticator IS their second factor; never asked twice);
valid trusted device for THIS user → trusted; else challenge.

### 12.3 The code

`mfa/loginOtp.ts` (pure): 6 digits (`randomInt`, leading zeros kept), TTL 10 min,
max 5 attempts, max 3 sends per login, `hashOtpCode(code, challengeId)` = SHA-256
salted with the challenge id, `otpCodeMatches` timing-safe, `maskDestination`
(`•••-•••-1234`, `i•••@example.com`), ASCII-only SMS body (one emoji would flip the
segment to UCS-2), `chooseChannels(setting, hasPhone, requested)` — an SMS-only tenant
with a phoneless user still gets EMAIL rather than a lockout; a request for a
disallowed channel is ignored.
`mfa/loginOtpRoutes.ts`: SMS via `resolveBillingSmsSender` (the platform's (845) 723-1213),
email as `EmailJob` type `LOGIN_CODE` on the user's tenant (⛔ never `ADMIN_ALERT`);
`POST /auth/otp/verify` — parse → verify pre-auth (purpose `otp_challenge`) → its OWN
`createLoginThrottle` (5/10 min per account, 25 per source, **429 + Retry-After**) →
`decideOtpVerify` (no_challenge / wrong_login (jti or user mismatch) / consumed /
expired / too_many_attempts / wrong_code) → atomic consume → optional
`TrustedLoginDevice` (token returned once, hash stored) → `deps.issueSession`;
`POST /auth/otp/resend` — new code, previous dead, cap 3, other channel allowed;
`GET/DELETE /auth/otp/trusted-devices` (session-gated); `GET/PUT
/admin/tenants/:id/login-otp` (SUPER_ADMIN, audit `TENANT_LOGIN_OTP_UPDATED`,
channel case-insensitive). Every send/verify/resend/revoke writes an audit row.

### 12.4 Pre-auth token purposes

`mintPreAuthToken(userId, now, purpose)` → `{ token, expiresInSeconds, jti }`;
`verifyPreAuthToken(token, now, purpose)` answers `wrong_purpose` across the two.
Same derived key, same 5 min, still rejected by every session verifier. Bypass list:
`/auth/otp/verify`, `/auth/otp/resend` only.

### 12.5 90-day sessions

`issueLoginSession` and `/verify` sign `{ expiresIn: "90d" }` **only** for OTP
tenants; the no-OTP branch is the exact pre-existing sign call (a guard matches it
literally). Platform-wide expiry stays blocked on the mobile 401 work (§8).

### 12.6 Turnstile (`apps/api/src/turnstile.ts`)

`turnstileMode(env)`: no `TURNSTILE_SECRET_KEY` → `off`; key → `observe`;
`TURNSTILE_ENFORCE=1` → `enforce`. `isBrowserOnPlatformHost(headers)`: Origin/Referer
host ∈ `PLATFORM_PORTAL_HOSTS` — the mobile app (no Origin) is never challenged.
`turnstileGate` → `allow` (off / not_browser / verified / observed_missing /
observed_invalid) or `refuse` (`400 human_check_required`, `400 human_check_failed`,
`503 human_check_unavailable` — an outage at Cloudflare is not a login failure).
`siteverify` with a 5 s timeout, remoteip = last X-Forwarded-For. Login logs
`login_refused_turnstile` / `turnstile_observed`; metric label `human_check`.
Portal: `components/TurnstileWidget.tsx` renders nothing without
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`; explicit render, `expired-callback` clears the
token; a `human_check_*` refusal resets the widget. nginx CSP on both vhosts +
`security-headers.conf` allow `https://challenges.cloudflare.com` in `frame-src`
(script/connect already did); backup `/root/nginx-csp-turnstile-backup-20260819T054753Z`.
Roll-out: create the Turnstile site for BOTH hostnames → secret into `.env.platform`
+ api deploy → observe log → site key into the portal build → `TURNSTILE_ENFORCE=1`.

### 12.7 Portal

`lib/mfaLogin.ts` classifies `otp_challenge` (a token always wins; no pre-auth token →
failed); `lib/trustedDevice.ts` (localStorage `cc-trusted-device`, expiry honoured
locally); `app/login/page.tsx` — sends `trustedDeviceToken` + `turnstileToken`, OTP
step with `autoComplete="one-time-code"`, "Remember this device for 90 days" (default
on), "Send it again", "Text/Email me the code instead", plain-English refusals
(`otp_invalid` with tries left, dead challenge → back to password); the ONE
`writeAuthToken` and the ONE `writeTrustedDeviceToken` both live in `completeSignIn`
on a classified session. Admin → Tenants: "Sign-in code (2FA)" column (On/Off +
channel select) via `PUT /admin/tenants/:id/login-otp`.

### 12.8 Tests

`mfa/loginOtp.test.ts` (15) — gate, channels, hash/compare, verify decision, trusted
device, masking/ASCII, purposes, Turnstile mode/host/gate, wiring guards (bypass list,
handler order, expiresIn scoping, parser), Prisma accessor guard.
`mfa/loginOtpRoutes.test.ts` (7) — real Fastify + `@fastify/jwt`, faked db + senders:
SMS happy path (code never stored clear), email fallback (`LOGIN_CODE`), remember →
skip → foreign user still challenged → revoke; wrong/cross-user/replay/forged/2-digit;
5 attempts then dead; resend other channel + cap 3; admin switch + 403/400/404.
Portal `lib/mfaLogin.test.ts` +3. Guards replayed against `HEAD`: 9/9 fail.
Typecheck api 75 = baseline, portal 0. Neighbouring suites 147/147, mfa 46/46.

### 12.9 Not proven / open

No tenant on; no code delivered to a human; no Turnstile key. Mobile app has no OTP
step (as with TOTP) — a user on an OTP tenant cannot finish sign-in in the app;
`TENANT_ADMIN` cannot flip its own tenant (deliberate). Acceptance recipe is in the
CLAUDE.md section.

## 13. Where the security work actually stands (2026-08-19) — the honest ledger

Written because Izzy asked "everything is fortified and 100% secure?" and the
answer is no. "100% secure" is not a state a system reaches; what follows is what
is ON, what is BUILT-BUT-OFF, and what needs a person. **Every line was read from
the live platform on 2026-08-19, not from memory.**

### 13.1 ON and proven

Rounds 1–4 plus the hardening pass are deployed and container-verified across
**api**, **portal** and **worker** (the worker last — see §11's worker bullet).
Both hostnames are at measured parity: one vhost shape, 11 path classes, five
security headers + HSTS, TLS 1.0/1.1 refused, valid auto-renewing certs, shared
allow/deny lists, and SPF + DKIM + DMARC on both mail domains. SSH is keys-only.
The `/internal/*` doors, the forgeable signed URLs, the tenant-scoping findings
(§6a–§6l), the dead `NODE_ENV` gates and the never-run rate limiter are closed.
**The global rate limiter is proven to refuse** (478 × 200 → 62 × 429, §10).

### 13.2 BUILT but OFF — the part that matters most

| control | state on 2026-08-19 |
|---|---|
| Cloudflare Turnstile on login | **SUPERSEDED 2026-08-21 — see §14: now ON in OBSERVE mode** (was: secret unset, mode `off`) |
| Per-tenant sign-in code (2FA) | **0 of 31** live tenants switched on; **0** codes ever sent |
| MFA / TOTP | **0** users enrolled — including the SUPER_ADMIN; `MFA_ENFORCEMENT` unset (grace) |
| Cloudflare edge (WAF, rate rules) | `app.` is **DNS-only**; every staged rule is inert |
| DMARC | `p=none` on both domains — reporting, not blocking |

⛔ These are correct, tested and deployed. They are also **doing nothing until
somebody turns them on**, and the roll-out order for each is written in its own
CLAUDE.md section (Turnstile: observe → read the log → enforce).

### 13.3 Deliberately NOT closed, with the reason

- **Session tokens still never expire** platform-wide — only OTP tenants get 90
  days. Blocked on the mobile 401 work (§8): a dead token today is a 401 stream
  that auto-bans the customer's whole office.
- **Three latent `ADMIN` findings** — raw PBX-resource writes (§6h), the chat
  routes (§6a/§6b), and `/ws/telephony` (found 2026-08-19). **0 `ADMIN` users
  exist**, so all three are inert; creating one arms all three at once.
- **Turnstile is bypassed by omitting `Origin`** — deliberate, so the mobile app is
  never challenged. It defends against browser-driven credential stuffing only.
- **The mobile constant is committed and NOT built** — `publicOrigin.ts` still
  resolves the OLD host, so an APK/TestFlight build today would behave identically
  to what is on phones now. That build reaches real customers and is Izzy's call.

### 13.4 Never audited

`apps/agent` and `apps/worker` internals. `/ws/telephony` was audited on
2026-08-19 (authentication and tenant scoping both correct; the `ADMIN` finding
above is the one issue). The PBX itself is out of scope by standing rule.

### 13.5 What blocks removing `connectcomunications.com`

`PUBLIC_PORTAL_URL` is unset, so **every emailed link still names the old
domain**; **`m.loopcom.net` does not resolve** (the PBX is only on the old
hostname — DNS + cert, a PBX write); the Google OAuth redirect URIs for
`app.loopcom.net` are not registered, so Gmail/Drive sign-in there fails **at
Google**; `support@`/`billing@loopcom.net` are unconfirmed as real mailboxes; and
there is no Loopcom-branded mobile or desktop build. The portal and API surfaces
themselves are at full parity — those five items are the whole remaining gap.

## 14. Turnstile is ON in OBSERVE mode — and the site key had no path into the build (2026-08-21)

Izzy, 2026-08-21: *"Do we have the Cloudflare check for robots and stuff before
getting to the login page, or on the login page?"* — then, on hearing it was
built and switched off: *"Do one, two, and three."*

**Answer to the question, for the record: it is ON the login page**, a widget
inside the sign-in card, verified server-side inside `POST /auth/login` after
the throttle and before any DB read. It is **not** a gate in front of the page;
that would be the Cloudflare edge, and `app.` is still DNS-only (§13.2).

### 14.1 What was done

| step | result |
|---|---|
| Turnstile widget created | name **"Loopcom portal sign-in"**, account `c52b8cceadcd2b113e74350b72365765`, mode **Managed**, pre-clearance **off** |
| Hostnames | `app.connectcomunications.com` **and** `app.loopcom.net` (2 of 10) |
| Site key | `0x4AAAAAAEXikCDGv1Pl_SuX` — **public by design**, lives in git |
| Secret | `.env.platform` only, `600 root:root`, backup `.env.platform.bak.20260821T112630Z.turnstile`, fingerprint `sha256[0:12] = 9b0141c4e114` |
| Mode | `TURNSTILE_ENFORCE` **absent** → **observe**: verifies and logs, refuses nobody |
| Deployed | api `b6ea3ff4` (container-verified), portal same commit |

⛔ **`loopcom.net` is NOT a Cloudflare zone — its DNS is at Squarespace — and
that is irrelevant here.** Turnstile hostnames are just a list; Cloudflare
offered *"Add app.loopcom.net as a custom hostname"* and took it. Cloudflare's
own subtitle on that screen says it: *"Turnstile can be embedded into any
website without sending traffic through Cloudflare."* Do not go looking for a
second zone — there has only ever been one.

### 14.2 ⛔⛔ THE FINDING: the site key had NO WAY TO REACH THE BUILD

`NEXT_PUBLIC_TURNSTILE_SITE_KEY` appeared in **neither `apps/portal/Dockerfile`
(no `ARG`, not in the build `RUN` env) nor either compose build-args block**.
`TurnstileWidget` reads `process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY` at build
time and renders `null` when it is empty — **so the widget has rendered nothing
in every portal build ever made**, and setting the secret alone would have
produced an observe log reading `observed_missing` forever with no way to tell
that from "no bots are trying".

Fixed in `b6ea3ff4`: the ARG in the Dockerfile, the build-arg in **both**
`portal` **and** `portal_candidate` (the blue/green pair — wiring one tests
perfectly and loses the value at the next cutover, the CRM storage-dir trap).

⛔ **The site key is a LITERAL DEFAULT, not a bare `${VAR:-}` substitution, and
that is deliberate.** `deploy-direct.sh` sources only `.env.deploy-queue`, so an
unset variable resolves to empty — the exact mechanism that left
`CDR_INGEST_SECRET` blank for the platform's life. An empty substitution here
bakes an unkeyed portal and the login page silently loses its check. The key is
public (it ships in the bundle), so a literal costs nothing.

`apps/portal/lib/turnstileWiring.test.ts` (7 tests, registered) reads all four
files, because the defect class is a **caller** dropping the arg — a unit test
of the widget passes straight through it. It also asserts the two hardcoded
keys agree (so a rotation cannot move one and not the other) and that no
Turnstile **secret** ever reaches a portal build input, since anything named
`NEXT_PUBLIC_*` is inlined into the bundle and served to every visitor.
✅ **All 4 wiring assertions fail when replayed against `HEAD`.**

### 14.3 ⛔ How the secret was proven correct BEFORE anything relied on it

**In observe mode a WRONG secret is invisible** — it logs `observed_invalid` and
allows the login, exactly like a healthy day with no tokens. So the secret was
validated first, from **inside `app-api-1`**, by asking Cloudflare to refuse it:

```
POST https://challenges.cloudflare.com/turnstile/v0/siteverify
  secret=<the secret>&response=dummy-token-for-validation
```

- wrong secret → `{"error-codes":["invalid-input-secret"]}`
- right secret → `{"error-codes":["invalid-input-response"]}` ← what we got

That single call proves the secret **and** that the api container has egress to
Cloudflare (without which observe would log `observed_unavailable` forever).
It is the house rule in another costume: *let the provider refuse, then read
WHICH refusal.*

The secret was moved from the browser to the server **via the clipboard piped
straight into ssh**, so it was never transcribed by hand; the file write is
verified by `sha256[0:12]` rather than by echoing the value.

### 14.4 Deploy order, and why

**api first, portal second.** Either order is safe — an old api ignores an
unknown `turnstileToken` field, and a keyed portal talking to a secret-less api
is simply mode `off`. api-first only avoids a window where every login logs
`observed_missing` because the verifier exists but no widget does.

### 14.5 Proven live

- Secret in the running container: 35 chars, fingerprint `9b0141c4e114`,
  `TURNSTILE_ENFORCE` empty → **observe**.
- A browser-shaped login (`Origin: https://app.connectcomunications.com`, no
  token) answered **`401 invalid_credentials`** — the ordinary refusal, not a
  human-check one — and logged
  `{"note":"observed_missing","msg":"turnstile_observed"}`.
  **That is the gate executing and deliberately allowing.**
- `/api/health` **200** on both hostnames after the deploy.

### 14.6 ⏳ NOT PROVEN, and the roll-out to enforce

**Nobody has seen the widget in a browser.** It is proven as a keyed bundle and
a firing server-side gate, not by a human watching a checkbox render.
⛔ An already-open portal tab or desktop window keeps the OLD bundle until it is
reloaded — the desktop app needs a full close and reopen.

Acceptance: open `/login` on **both** hostnames, confirm the widget renders and
sign-in still works; then confirm the api log shows `note:"verified"` instead of
`observed_missing`.

**Only then** consider `TURNSTILE_ENFORCE=1` (api restart, no rebuild).
⛔ Do not enforce until `observed_missing` has fallen to ~zero for real browser
logins — every one of those becomes a **refused login** the moment you enforce,
and the mobile app (which sends no `Origin`) must be confirmed still exempt.
