# ⛔⛔ AGENT HANDOFF — the login brute-force limiter had NEVER run; the portal ships no security headers; Cloudflare is NOT in front of us (2026-08-16) — READ FIRST before any auth/login work, before filing a TLS or firewall finding, before using `req.ip`, or before believing Cloudflare protects Connect

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md`**
(audit + fixes, `192837b5` on `feat/ivr-migration-takeover`. **api DEPLOYED and
container-verified 2026-08-16; nginx security headers LIVE; Cloudflare DMARC + edge
TLS applied.** No PBX interaction.)
Cutover plan for the edge: **`docs/ai-context/PLAN_CLOUDFLARE_EDGE_SIP_SPLIT_2026-08-16.md`**
(⛔ **no longer plan-only** — Phase A done, Phase B's server side done, `app.loopcom.net`
live. See the two bullets on the edge/SIP split below before touching any of it.)

- ✅ **THE LOGIN THROTTLE IS LIVE AND PROVEN IN PRODUCTION** — not inferred from tests:
  12 posts to `/api/auth/login` for one throwaway account returned **401 ×10 then 429
  ×2**, a *different* account from the same IP still returned **401** (so account
  scoping works and no IP was blanket-blocked), and the log line reads
  `reason: account_failure_volume, sourceIp: 50.48.58.53` — **a real client address,
  which is the proof the `X-Forwarded-For` resolution works**; with `req.ip` it would
  have read the nginx hop for everyone. Re-run that probe after any api deploy.
- ✅ **A SHORT OR MALFORMED LOGIN BODY IS `401 invalid_credentials` NOW, NOT `500`
  (2026-08-18; audit doc §1b).** The handler's `z.object(...).parse(req.body)` THREW on
  `{"password":"x"}`, the global error handler turned it into `500 internal_error`
  (proven live with curl), and the portal showed "Server error" to anyone who typed
  fewer than 8 characters. Now `apps/api/src/loginRequest.ts` `parseLoginRequest()`
  (safeParse, never throws) answers **exactly like a wrong password** — 401, not 400,
  because the portal renders 401 as "Invalid email or password." and any other 4xx as
  a raw code, and because a < 8-char password can never be right (every set-password
  path enforces ≥ 8). ⛔ **A malformed body is answered BEFORE the throttle and is NOT
  recorded as a login failure** — nothing was compared, it is not an oracle (same
  answer for real and unknown accounts), and counting it would let garbage fill a
  victim's account counter for free. Metric label `malformed`. 11 tests in
  `loginRequest.test.ts`, four of them source guards on the handler that fail against
  the pre-change file. ⛔ **`server.ts` still has ~117 other `.parse(req.body)` sites
  that 500 on a bad body** — authenticated routes, so a client bug not a customer
  screen; fix each with `safeParse` + a deliberate 4xx, never by weakening the error
  handler. ✅ **api DEPLOYED and container-verified 2026-08-18** (`e9a79c57`, queue job
  `4bcde036`, `verify: container commit e9a79c57b221 matches target`) and **re-proven
  live with curl**: the exact `password:"x"` body → 401 `invalid_credentials`, wrong
  password → 401, `{}` → 401, non-JSON → Fastify's own 400, `request_failed` count 0.
- ✅ **THE PORTAL SECURITY HEADERS ARE LIVE.** Fixed by
  `/etc/nginx/connectcomms/security-headers.conf`, `include`d into the two locations
  that define their own `add_header` (`location /` and `location = /privacy`) — because
  ⛔ **nginx `add_header` is NOT inherited into a block that has its own.** Verified over
  public HTTPS: `/login` now returns all five headers **and keeps** its
  `Cache-Control: no-store` (which is what stops stale portal bundles), `/api/health`
  unchanged. ⛔ Verified in a REAL BROWSER too — `/login` renders client-side, so curl
  proves nothing: console showed **no CSP violations** and the form rendered. Backup
  `/root/nginx-connectcomms-backup-20260816-183503-secheaders.conf`; rollback is restore
  + `systemctl reload nginx`.

- ⛔⛔ **THE LOGIN LIMITER WAS DEAD CODE AND HAD NEVER RUN IN PRODUCTION.** It was
  gated on `process.env.NODE_ENV === "production"` and **the api container sets no
  NODE_ENV** — proven live: `docker exec app-api-1` → `NODE_ENV=[]`, while
  `app-telephony-1` → `production`. Same class as the error-leak handler
  (`4fb512ed`). Replaced by `apps/api/src/loginThrottle.ts` (20 tests), which reads
  no NODE_ENV; `LOGIN_THROTTLE_DISABLED=1` is the only off switch.
- ⛔⛔ **`req.ip` IS USELESS IN THIS CODEBASE AND USING IT NEARLY CAUSED AN OUTAGE.**
  Fastify is built with **no `trustProxy`**, so `req.ip` is the nginx/docker hop —
  the SAME value for every request platform-wide. Keying a source counter on it
  would have put all customers in one bucket, and **six unrelated people mistyping a
  password within ten minutes would have blocked login for EVERYONE.** Take the
  **LAST** `X-Forwarded-For` entry (nginx uses `$proxy_add_x_forwarded_for`, which
  appends the real peer to whatever the client sent, so earlier entries are
  attacker-controlled). Reading the **first** — the usual mistake — lets an attacker
  mint a fresh source per request and frame an innocent IP into a block.
- ✅ **THE NODE_ENV SWEEP IS FINISHED (2026-08-18) — see the dedicated section
  further down for the detail.** Every `NODE_ENV === "production"` branch in apps/api
  was permanently false because the api container sets no `NODE_ENV`. All of the
  once-dead gates are closed: the login throttle, the error-leak handler
  (`4fb512ed`), `onboarding/publicRoutes.ts` (anonymous tenant factory), and now
  **the Cardknox SIMULATE boot guard**, `crm/formStorage.ts` and `redis.ts`, plus a
  fail-open `NODE_ENV === "development"` bypass on the dev-observe SUPER_ADMIN token
  route. **`apps/api/src/ops/serverHealth.ts:66` is the ONE deliberate survivor** and
  is not a gate — it picks a health-probe URL, and its false branch is the correct
  production behaviour.
  ⛔ **Do NOT "fix" anything here by setting NODE_ENV=production on the container** —
  that flips unrelated branches at once with unknown blast radius. Remove the
  NODE_ENV dependency per gate so each defaults to secure, one at a time, each with
  a test. `apps/api/src/nodeEnvGates.test.ts` now sweeps the whole tree and fails if
  a new executable `process.env.NODE_ENV` reader appears.
- ⛔ **THE PORTAL SHIPPED ZERO SECURITY HEADERS — FIXED, see the ✅ bullet above; this
  entry is kept only for the RULE.** nginx `add_header` is **not inherited into a
  location block that has its own**, and `location /` sets `add_header Cache-Control`,
  which cancelled all five server-level headers (CSP, X-Frame-Options, nosniff,
  Referrer-Policy, Permissions-Policy) for **every HTML page** while `/api/health`
  returned them — so the server block *looked* correct. ⛔ **Any NEW server block or
  any location that adds its own `add_header` must `include
  /etc/nginx/connectcomms/security-headers.conf`** or it silently reintroduces this.
  Re-proven live 2026-08-16 on both domains: `/login` returns all five **and** keeps
  `Cache-Control: no-store`.
- ⛔ **CLOUDFLARE IS NOT IN FRONT OF CONNECT.** Account inspected live 2026-08-16 via
  Izzy's browser. Plan is **Free**. Of 8 DNS records **only `portal.` (a third-party
  Telocall GUI) is proxied**; `app.` → origin 45.14.194.179 and `m.` → the PBX are
  both **DNS only**. **Total requests through Cloudflare in 24h: 1** — the edge does
  nothing today. ⛔ Do not claim Cloudflare protects anything.
  ⛔ **The dashboard banner "Onboard your agent to Cloudflare — Works with Claude…" is
  an ADVERT, not a status** (it misled once). The authoritative check is the
  API-tokens page; there were **zero** tokens. There is also no Cloudflare MCP
  connector. ⛔ **No Cloudflare credentials exist ON THE SERVER** — loopcom still
  cannot call the API itself.
  ✅ **Done 2026-08-16:** DMARC added (`p=none` — ⛔ **monitor only, it does NOT block
  spoofing yet**); `min_tls_version` 1.0→1.2 and `always_use_https` on (both affect
  **proxied traffic only**, so today only `portal.`); zone-scoped API token
  `connect-security-sentinel` (Zone Settings/DNS/Firewall Services : Edit).
  ✅ **DKIM already existed** (`google._domainkey`). ⛔ **HSTS deliberately NOT
  enabled** — it is semi-permanent and must wait until `app.` is proxied and proven.
  ⛔ **A displayed-once secret must never be screenshotted "to confirm success"** —
  a token value landed in the session transcript that way; it was rolled and verified
  dead. Confirm from the token LIST page, which shows status but not the value.
- ⛔⛔ **PROXYING `app.` IS NOT A TOGGLE — SIP IS THE BLOCKER, AND IT IS STILL THE
  BLOCKER TODAY.** nginx `location /sip` on `app.` proxies WebSocket SIP to the PBX, and
  four tenants (Gesheft, Displaydex, Loopcom Demo, inii mini) register through it.
  Cloudflare idles WebSockets out at ~100 s; a dropped WSS is a phone that does not ring.
  ✅ **`sip.connectcomunications.com` now exists (DNS-only, own cert, `/sip` → 101) and
  the api hands out `wss://sip.connectcomunications.com/sip`** — `SIP_PUBLIC_WS_URL` was
  set in `.env.platform` on 2026-08-16 (owner-approved) and container-verified.
  ⛔⛔ **AND NOT ONE PHONE HAS MOVED.** The apps **never refresh a cached `sipWsUrl`**,
  so every live session still registers against `app.` until its user signs out and back
  in. **Do NOT flip `app.` to Proxied** — that migration is Izzy's to schedule, and the
  fact to check is the PBX contact list (`pjsip show endpoint T<t>_<ext>_1` reading
  `Avail`), never a client's own "registered".
- ✅ **`app.loopcom.net` SERVES CONNECT (2026-08-16), as a SECOND self-contained
  hostname** — owner's decision, `connectcomunications.com` deliberately untouched
  because people are logged into it. Own Let's Encrypt cert (exp. 2026-11-14,
  auto-renewing) + a NEW nginx file `/etc/nginx/sites-available/connectcomms-loopcom`
  mirroring the `app.` block. Verified from outside: `/` 200, `/api/health` 200, login
  401 on bad creds, all five security headers on `/login`, `/sip` 101, and path-for-path
  parity with `app.connectcomunications.com`.
  ⛔ **ONLY the `app.` subdomain points at us.** loopcom.net's apex + `www` serve a LIVE
  Squarespace site and the domain carries LIVE Google Workspace mail (5 MX records, all
  re-verified untouched after the change). **Never repoint apex, www, or MX.**
  ⛔ **The nginx filename is load-bearing:** `sites-enabled/*` is included in sorted
  order and the FIRST `listen 443` block is the default server for unmatched hostnames.
  `connectcomms-loopcom` sorts after `connectcomms`, so the default stays the old
  domain; a name sorting earlier would silently have hijacked it.
  ⛔ **`certbot --nginx` cannot be the first step for a brand-new hostname** — it needs a
  vhost carrying that `server_name` to install into. Create a throwaway port-80 block,
  then use `certbot certonly` so certbot never rewrites your hand-written vhost.
  ⏳ **NOT PROVEN: nobody has signed in on it in a browser**, and clients there are still
  handed the `sip.connectcomunications.com` SIP URL — `sipPublicEndpoint.ts` holds ONE
  global value, **not per-domain**. Making it per-domain is an OPEN owner decision.
- ⛔ **TLS IS FINE — do not file it as a finding.** `/etc/nginx/nginx.conf` still
  carries Ubuntu's default `ssl_protocols TLSv1 TLSv1.1 …`, but the certbot include
  overrides it at server level. **Real handshake test: TLS 1.0 and 1.1 REFUSED, 1.2
  and 1.3 accepted.** Truth-test the handshake; never file a TLS finding off the
  config file.
- ⛔ **Testing port 3910 FROM the server proves nothing** — traffic to your own
  public IP goes through loopback and skips the ufw rule (it answers 401 and looks
  reachable). From an external workstation it is correctly **blocked**. UFW is
  active, default-deny, and every datastore (Postgres, Redis, MinIO, Grafana) is
  loopback-only. **The server perimeter is in good shape; the auth layer is not.**
- **Open and unfixed, needing Izzy:** session tokens **never expire** (no
  `sign.expiresIn`, no refresh tokens, no revocation — ⛔ investigated 2026-08-18
  and DELIBERATELY left as is: neither client survives a 401 and a dead portal
  token auto-bans the customer's office; see the dedicated section near the top
  of this file and audit doc §8 before touching it); **no MFA anywhere**, not even
  for SUPER_ADMIN; SSH allows **root login with passwords** against 1,457 failed
  attempts/day; **no DMARC** on the domain that sends invoices and voicemail.
- ⛔ **Never `git stash` in this tree to compare against a baseline.** A failed
  `stash push` followed by an unconditional `stash pop` popped an unrelated
  2026-06-29 mobile stash into the shared tree and conflicted another session's
  files. Fully recovered, nothing lost — but compare by inspecting which files the
  errors land in, never by stashing.
