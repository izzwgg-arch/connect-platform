# ⛔⛔ AGENT HANDOFF — the platform's rate limiter had NEVER run; SSH takes keys only; both hostnames are at parity and fortified (2026-08-19) — READ FIRST before touching `app.register(rateLimit`, before adding a `keyGenerator`, before ANY sshd change, before adding a location to ONE of the two app vhosts, or before answering "does app.loopcom.net do everything app.connectcomunications.com does?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`eeec0002` on `feat/ivr-migration-takeover`. **api DEPLOYED and container-verified**
(`/app/.build-commit` = `eeec0002839c`); nginx changes LIVE on both vhosts; sshd
hardened LIVE; env perms tightened. No migration, no PBX write, no DNS change, no
tenant row, no user role, no env VALUE changed. Full detail:
`docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md` §0e and
`docs/ai-context/AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §10.)
Memory: [[global-rate-limiter-was-dead-onroute-ordering]].

- ⛔⛔ **THE GLOBAL RATE LIMITER HAD NEVER APPLIED TO A SINGLE ROUTE — the audit's
  §6i "one bucket for the whole platform" was wrong in the OTHER direction.**
  `app.register(rateLimit, { max: 200 })` was un-awaited and 480+ routes were
  declared below it; `@fastify/rate-limit` attaches its global limiter through an
  **`onRoute` hook, which fires synchronously at route DECLARATION** — before the
  plugin ever loaded. Measured before touching it: 357 req/min peaks, **zero**
  429s, and **no response on the platform had ever carried `x-ratelimit-*`**.
  Same class as the NODE_ENV gates. **Fix:** `global: false` + `app.rateLimit()`
  installed as an **`onRequest` hook inside `app.after()`** — lifecycle hooks are
  snapshotted at `preReady`, so declaration order no longer matters. **A real
  Fastify test declares routes BEFORE the plugin and proves the limiter fires;
  a second test documents that the OLD shape does not.** Boot line
  **`GLOBAL_RATE_LIMIT_ARMED maxPerMinute=480`** — grep it after every deploy;
  `API_GLOBAL_RATE_LIMIT_PER_MIN=0` disables (restart, no rebuild).
- ⛔ **Keyed on the LAST `X-Forwarded-For` entry, never `req.ip`** (the nginx hop
  — that WOULD have been one bucket). **Header-less callers are EXEMPT on
  purpose** — those are the docker peers (telephony CDR ingest, mobile-ring
  pushes, the worker, the deploy health probe); the api port is loopback-bound
  so nothing external arrives header-less. **`/internal/*` exempt** too (nginx-
  restricted, secret-gated, on the call path). **480/min per real IP**, sized
  from four days of logs: legit peak **167** (Izzy's own workstation), only 20
  of 17,209 buckets in a full day above 100; the Gesheft voicemail-flood bug hit
  523 and got a whole office BANNED — this 429s such a flood first, which is a
  far gentler failure. `monitor.sh` still bans at >1200/5 min behind it.
  ✅ **Live on both hostnames: `x-ratelimit-limit: 480`** — the first time ever.
- ⛔ **`JWT_SECRET` fails closed at boot** (missing or <32 chars refuses to
  start with a readable reason); the `"change-me"` literal is gone from the jwt
  registration and its three token-secret siblings. ✅ Live value is 64 chars —
  checked in the container BEFORE deploying, because this guard can stop the api.
- ⛔ **A malformed body on a `.parse(req.body)` route is now `400 validation_error`
  (path/code/message only), not `500 internal_error`.** ~117 authenticated
  routes still `.parse()`; the global error handler maps `z.ZodError`. **This
  is NOT the "weakening the error handler" CLAUDE.md warns against** — it
  answers the API's own contract and never a stack, query or table name. Routes
  that already `safeParse` are untouched.
- **§6j fixed:** `/billing/platform/invoices/pay-multi/*` is on the JWT bypass.
  Every combined pay link a customer was ever sent had 401'd before the handler
  ran. ✅ Proven live: a bogus token now answers the HANDLER's `410
  invoice_token_invalid`, not the hook's 401.
- **§6h fixed (latent — 0 ADMIN users, 0 write hits in 14 d, 3,438 GETs):** raw
  VitalPBX writes list the caller's own PBX tenant's resources and refuse unless
  the id is in the list; `tenants`/`trunks` writes are SUPER_ADMIN-only. A
  foreign id reads like a missing one. Rules in `pbxResourceOwnership.ts`.
- **§6l, all closed:** remote-support target lookup tenant-scoped (was a
  platform-wide user-id existence oracle); `/chat/a/` bypass anchored to the
  path start (was a substring match); scan idempotency + tracking-session run
  tenant-scoped; campaign assignee validated on add AND patch; scheduled menu
  switch checks the profile's tenant; announcement `promptRef` checked against
  the catalog (server.ts passes `ivrResolveMissingPromptRefs` into the schedule
  deps); didmap MOH lookup scoped; both agent info doors use the constant-time
  `agentMohSecretOk`; `requireCrmAdmin` honours the super-admin tenant switch.
  ⛔ Deliberately NOT changed: `POST /lan-phones/runs` stays permission-less —
  the customer's Windows app reports its own scan; requiring
  `can_view_lan_phones` there would break the design. And the five
  `/internal/delivery/*` doors (secret UNSET, so refused today) were left as is.
- **Finding J fixed:** the `DISABLED` check now runs only AFTER bcrypt matched. It
  used to run BEFORE, so any password answered 403 for a disabled account and 401
  otherwise — a free oracle for which addresses exist. Someone with the RIGHT
  password is still told plainly (`403 account_disabled` + message).
- ⛔⛔ **SSH TAKES KEYS ONLY NOW.** `PermitRootLogin prohibit-password`,
  `PasswordAuthentication no` (the `sshd_config.d/50-cloud-init.conf` that
  forced `yes` — and won over `60-cloudimg-settings.conf`'s `no`, first match
  wins — now says `no`). Validated with `sshd -t`, **reloaded, never
  restarted**, then a fresh key login proven and a password attempt proven
  refused (`Permission denied (publickey)`) before the session let go. Backup
  `/root/sshd-backup-20260819T032626Z/`. ⛔ **Root had logged in WITH A PASSWORD
  28 times, all from `50.49.194.85`, last on 2026-07-25** — almost certainly
  Izzy's own line. **That path is closed; use the key in `~/.ssh`.** 1,222
  failed password guesses/day now hit a wall instead of a lock.
- ✅ **nginx `server_tokens off`** (both hosts answer `Server: nginx`, no
  version); **`.env.platform` and all 24 backups are `600`** (dir was already
  `750 root`); **HSTS `max-age=86400`** on both hosts (server level + the
  shared `security-headers.conf`) — one day, no `includeSubDomains`, no preload,
  so it can never outlive a rollback by more than a day; raise it once proven.
- ✅✅ **`app.loopcom.net` IS AT PARITY WITH `app.connectcomunications.com`, and it
  was measured, not assumed.** The two vhosts diff to nothing after normalising
  the hostname **except one block: `location /brand/`** (the immutable-cache
  block for the email logo, added 2026-08-17 to one host only) — **now on both**.
  Then every path class (`/`, `/login`, `/api/health`, `/version`, the
  `/api/internal/` deny → 403, the SMS webhook → 401, `/brand/`, `/p/`,
  `/pay/invoices/`, `/onboarding/`), all five security headers + HSTS + the
  no-store cache rule, TLS 1.0/1.1 refused / 1.2/1.3 accepted, valid own certs
  (`app.` exp 2026-10-22, `app.loopcom.net` exp 2026-11-14, both `sip.` certs
  2026-11-14, `certbot renew --dry-run` clean, timer armed) — **byte-for-byte the
  same on both hostnames**. Both vhosts write the ONE `access.log` that
  `monitor.sh` reads and share the allow/deny includes, so bans and rate
  windows are per-platform, not per-host. ⛔ **The rule this earns: any new
  `location` block goes into BOTH vhosts in the same change**, or one brand
  silently loses a feature (the `/brand/` block was that, for two days).
- ⛔ **What is deliberately NOT changed, and is Izzy's call:** (1) the api's
  canonical link host — every emailed pay link / invite / sign-up link falls back
  to `https://app.connectcomunications.com`; **`PUBLIC_PORTAL_URL` overrides all
  of them in one place** if the emails should carry the Loopcom hostname
  (both hosts serve every page either way). (2) Three portal download links stay
  absolute (`AppDownloadCard.tsx`, `navConfig.ts` installer, the invoice page's
  SSR fallback) — download links, fine cross-origin, not fetches.
  (3) ✅ **DONE 2026-08-19 with Izzy at the keyboard: `loopcom.net` now has SPF
  (`v=spf1 include:_spf.google.com ~all`) and a 2048-bit Google DKIM key
  (`google._domainkey`), added at Squarespace via the browser and **verified
  byte-identical to Google's value at the authoritative NS, 8.8.8.8 and 1.1.1.1**;
  Google Admin reads *"Authenticating email with DKIM"*. Mail posture is now
  identical on both domains (SPF + DKIM + DMARC `p=none`). ⛔ Squarespace's
  "Verify to continue as support@…" gate opens a Google popup OUTSIDE the
  automation tab group — Izzy has to click it each write; the DKIM key is
  generated in Google Admin (`admin.google.com` re-asks the password, his). (4) `loopcom.net` apex/`www` stay on Squarespace — Izzy,
  2026-08-19: *"I have other plans for loopcom.net."*
- **Tests: 28** (`globalRateLimit.test.ts` 11 incl. two real-Fastify proofs;
  `securityHardeningRound2.test.ts` 17). ✅ **All 16 source guards fail replayed
  against `HEAD`.** ⛔ Three guards first FAILED ON THE FIXED TREE because they
  matched the OLD code quoted in my own doc comments — strip comments before a
  negative match, and never `assert.match` a 1.8 MB file (a failure prints it
  whole; use `assert.ok(re.test(...), msg)`). api typecheck **75 = the exact
  baseline, identical error set**. Suite: **0 regressions from this change** —
  the 24 `setupOrchestrator.test.ts` failures now in `HEAD` come from another
  session's `c2d9fdd9` (its `@connect/integrations` mock lacks the
  `resolvePbxRouteHelperConfig` the orchestrator now calls). Not touched.
- ✅✅ **PROVEN FIRING, 2026-08-19 — the limiter really does refuse.** 540 requests
  to `/api/health` fired from loopcom against its own public IP in 18 s answered
  **478 × 200 then 62 × 429**, i.e. it cut off at the configured **480**. The
  refusal carries `retry-after: 10`, `x-ratelimit-remaining: 0` and a
  plain-English body (*"Too many requests from this connection — slow down and
  try again in 10 seconds."*), the IP was **not** banned by `monitor.sh`, and the
  same IP was back to **200** once the window rolled. Both hostnames stayed
  healthy throughout. ⛔ Run it from the SERVER, never a customer line: nginx
  appends the real peer as the LAST `X-Forwarded-For` entry, so the bucket you
  fill is whatever IP you call from.
- ⏳ **NOT PROVEN by a human:** nobody has paid through a combined link since, and
  Izzy has not yet logged in over SSH with his key since the change (I have).
  ⏳ **Still open and needing Izzy:** MFA enrolment; the mobile 401 build (then
  server `expiresIn`); the Cloudflare proxy flip; DMARC `p=quarantine` on
  `connectcomunications.com` (monitor the `rua` reports first); SPF+DKIM for
  `loopcom.net`; and the two stale deploy waiters on loopcom (PIDs 1873319,
  2429874) that self-match their own `grep` and can never fire.
