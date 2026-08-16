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

## 5. What is BLOCKED

⛔ **Cloudflare cannot be inspected.** There are **no Cloudflare API credentials
anywhere on the server**, `cloudflared` is not installed, and no `CF_*`/`CLOUDFLARE_*`
variable exists in any env file. Mandate Phases 2, 4, 5, 6 and 7 (origin protection,
WAF, edge rate limiting, bot protection, Zero Trust) **cannot be started** until Izzy
supplies a scoped Cloudflare API token or does the changes himself. Everything said
about Cloudflare above comes from DNS observation only.

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
