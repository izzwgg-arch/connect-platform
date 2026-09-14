# ⛔⛔ AGENT HANDOFF — a tenant can require a SIGN-IN CODE by text/email (2FA per company, "remember this device" 90 days, 90-day sessions), and the login form can carry Cloudflare Turnstile — BUILT and DEPLOYED, every switch OFF (2026-08-19) — ⚠ SUPERSEDED 2026-09-08 by v2 then v3 (see the v3 section near the top of this file): no "remember this device", no 90-day sessions, the person chooses text or email, and since v3 NO tenant switch — it is per user on Account → Security; the data/hash/throttle rules in this section still hold — READ FIRST before touching `/auth/login`, before flipping `loginOtpRequired` for a customer, before adding `expiresIn` anywhere, before setting `TURNSTILE_*`, or for "I got a code / I didn't get a code"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §12**
(`fc551996` on `feat/ivr-migration-takeover`. **api + portal DEPLOYED and
container-verified** — ⛔ both containers read **`fd3d0a3c`**, the PBX-console
session's commit, which has `fc551996` as an ancestor (`git merge-base
--is-ancestor`); their deploy carried this work. Migration
`20260819080000_tenant_login_otp` applied and verified in the live database.
No tenant switched on, no env change, no code ever sent to a human, no
Turnstile key exists.) Memory: [[tenant-otp-2fa-and-turnstile-built]].
Izzy, 2026-08-18: *"I want to implement 2FA with a switch to turn it on and off per
tenant. When they log in, they get a text or email with a code, and they have to
hit 'Remember me' to be able to log in without it. They should have to re-login
every 90 days if 2FA is enabled"* — and *"the Cloudflare check in the login page
as well."*

- ✅ **THE SWITCH IS PER COMPANY AND OFF FOR EVERYONE.** `Tenant.loginOtpRequired`
  (default `false`) + `Tenant.loginOtpChannel` (`EMAIL` | `SMS` | `EITHER`, default
  `EITHER`). SUPER_ADMIN flips it on **Admin → Tenants** (new "Sign-in code (2FA)"
  column: On/Off + channel) or `PUT /admin/tenants/:id/login-otp {required, channel}`
  — audited `TENANT_LOGIN_OTP_UPDATED`. ⛔ Nobody is affected the day it ships;
  the first flip is Izzy's, on a tenant that has agreed to it.
- ⛔⛔ **THIS IS A SECOND KIND OF SECOND FACTOR BESIDE TOTP, NOT A REPLACEMENT, and
  the order in `/auth/login` is the contract:** password (bcrypt) → **TOTP decision**
  (`decideLoginMfa`) → **OTP gate** (`decideOtpGate`) → session. An
  authenticator-enrolled person on an OTP tenant is **never asked twice** — TOTP
  wins and the code step is skipped. A guard reads the handler's SOURCE and pins
  the order. **Everyone whose tenant is OFF gets the byte-identical pre-2FA login
  body.**
- **The flow, in plain words:** tenant ON → is there a valid remembered-device
  token **for this user**? skip → else answer `200 { otpChallengeRequired: true,
  preAuthToken, expiresInSeconds: 300, channel, channels, destination (masked),
  sent, error: "otp_required" }` and **NO session token**; a 6-digit code goes out
  by **SMS from the platform's billing number** (`resolveBillingSmsSender`) when the
  user has a phone, else by **email type `LOGIN_CODE`** (⛔ never `ADMIN_ALERT`,
  which is muted — a test asserts it). Then `POST /auth/otp/verify { preAuthToken,
  code, rememberDevice }` answers the ordinary login body. `POST /auth/otp/resend
  { preAuthToken, channel? }` re-sends (the other channel allowed) and **kills the
  previous code**; 3 sends per login, then start over with the password.
- ⛔ **The code is stored ONLY as a SHA-256 hash salted with the challenge id**
  (`hashOtpCode`); the clear text exists in the text/email and nowhere else.
  10-minute TTL, **5 wrong tries** then the challenge is dead even if the sixth is
  right, wrong tries throttled per account + source (`createLoginThrottle`, **429 +
  Retry-After, never 401**), and **consumed atomically** (`updateMany where
  consumedAt is null`) so two racing verifies cannot both win. ⛔ **The challenge is
  bound to the pre-auth token's `jti`** — a code can be spent only by the login
  that asked for it; someone else's pre-auth token + Baila's code = 401.
- ⛔⛔ **THE PRE-AUTH TOKEN GREW A PURPOSE, and the purposes are DISJOINT.**
  `mfa/preAuthToken.ts` mints `purpose: "otp_challenge"` beside the TOTP one; verify
  checks it, so a TOTP pre-auth token cannot spend an OTP code and vice versa
  (`wrong_purpose`). Same derived key (`connect:mfa-preauth-token:v1`), same 5-min
  life, still **rejected unchanged by every session verifier** on the platform.
  `/auth/otp/verify` + `/auth/otp/resend` are on the JWT bypass list, and a test
  pins **those two and only those two** — `GET/DELETE /auth/otp/trusted-devices`
  are session-gated on purpose.
- ✅ **"REMEMBER THIS DEVICE" (ticked by default) is a skip-the-code token and
  NOTHING ELSE.** `/verify` returns an opaque random token **once**; the api keeps
  only its hash (`TrustedLoginDevice`), bound to **one user**, 90 days, revocable
  (`DELETE /auth/otp/trusted-devices` forgets them all); the portal keeps it in
  `localStorage` `cc-trusted-device` (`lib/trustedDevice.ts`, dropped locally at
  expiry) and sends it with the next login. ⛔ It is never a session — a copied
  entry lets nobody in without the password, and **someone else presenting it
  still gets a code** (tested).
- ⛔⛔ **RE-LOGIN EVERY 90 DAYS IS SCOPED TO OTP TENANTS ONLY.** `issueLoginSession`
  and `/auth/otp/verify` sign with `expiresIn: "90d"` **only when the user's tenant
  has the switch on**; everyone else's session is signed byte-for-byte as before,
  with no `expiresIn` — the token-expiry section of this file explains why
  platform-wide expiry must wait for the mobile 401 work (a dead token is a 401
  stream that auto-bans the customer's office). ⛔ **The mobile app has no OTP UI**
  (same as TOTP): a user on an OTP tenant cannot finish sign-in in the phone app
  today (`!json.token → throw "otp_required"`). **Do not switch a tenant on whose
  people live in the app** until the mobile challenge step ships.
- ✅ **TURNSTILE (`apps/api/src/turnstile.ts`) is THREE modes and today it is OFF:**
  no `TURNSTILE_SECRET_KEY` = off; key set = **observe** (verifies and LOGS
  `turnstile_observed`, refuses nobody); `TURNSTILE_ENFORCE=1` = enforce. Runs
  **after the throttle and BEFORE any DB read** in `/auth/login`. ⛔ **Only a
  BROWSER on OUR hosts is ever challenged** (`Origin`/`Referer` host in
  `PLATFORM_PORTAL_HOSTS`) — the mobile app sends no Origin and is never asked;
  refusals are `400 human_check_required / human_check_failed` with plain-English
  messages, and a Cloudflare outage is **`503 human_check_unavailable`, not a login
  failure**. Portal `components/TurnstileWidget.tsx` renders **nothing** unless
  `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is set (a build arg — needs a portal build to
  take effect); nginx CSP `script-src`/`frame-src`/`connect-src` already allow
  `https://challenges.cloudflare.com` on both vhosts (backup
  `/root/nginx-csp-turnstile-backup-20260819T054753Z`). **Roll-out is: Izzy
  creates a Turnstile site for BOTH hostnames → secret into `.env.platform` +
  api deploy (observe) → site key into the portal build → read the observe log →
  only then `TURNSTILE_ENFORCE=1`.**
- ⛔⛔ **HARDENED HOURS LATER BY ATTACKING IT (`1fa34d29`), and all three findings
  were real on the shipped commit — none was reachable, because no tenant is on.**
  **(1) NOTHING CAPPED SENDING A CODE.** `LOGIN_OTP_MAX_SENDS` caps resends WITHIN
  a challenge; every `POST /auth/login` minted a NEW challenge and a NEW text — so
  anyone holding a valid password could spend the SMS balance at the global rate
  limit (**480/min per IP**), and a customer double-clicking Sign in got two texts
  carrying two different codes **of which only the newer one worked**. Now a login
  that finds a LIVE challenge (unconsumed, unexpired, tries left) **re-binds it to
  the new login and sends nothing** (`decideChallengeReuse`): the code already on
  their phone stays the one that works, **only the newest login can spend it**, and
  texts per person are bounded by the resend cap inside one 10-minute window
  however often login is called. ⛔ A challenge that has **burned its five tries is
  NOT reused** — that would hand someone a dead code with no way forward; burning
  those five is itself throttled. Proven end to end: **eleven consecutive sign-ins
  → ONE text, ONE challenge row.**
  **(2) THE 2FA GATE FAILED OPEN.** The tenant lookup deciding whether a code is
  required ended `.catch(() => null)`, so a transient database error made
  `loginOtpRequired` falsy and **issued an ordinary session with no code asked
  for** — the exact shape of the empty `CDR_INGEST_SECRET` and the dead `NODE_ENV`
  gates. It now fails **closed**: `503 service_unavailable` plus a
  `login_otp_tenant_lookup_failed` error line so it is greppable, never silent.
  **(3)** the 90-day-session lookup in `issueLoginSession` had the same `.catch`,
  which would have minted a **never-expiring** session for a tenant that asked for
  90-day sign-ins; it throws now.
  ⛔ **The rule this re-earns: `.catch(() => null)` on a read that DECIDES a
  security question is a fail-open gate.** Swept the rest of the auth surface for
  it afterwards — `hasEffectivePortalPermission(...).catch(() => false)` and the
  CRM resolver both fail CLOSED and are correct; no other instance was found.
  ⚠️ **Known and accepted: Turnstile is bypassed by simply omitting `Origin`.**
  That is deliberate (the mobile app sends none and must never be challenged), so
  Turnstile protects against **browser-driven** credential stuffing only — the
  defence against scripted attacks is the login throttle plus the global rate
  limiter, not this. Do not "fix" it by challenging Origin-less callers.
- **Tests: 15 rules + wiring guards (`mfa/loginOtp.test.ts`) + 7 end-to-end route
  tests through a real Fastify + `@fastify/jwt` against a faked db
  (`mfa/loginOtpRoutes.test.ts`) + 3 portal (`lib/mfaLogin.test.ts`), all
  registered. All 9 source guards fail replayed against `HEAD`. api typecheck 75 =
  the exact baseline, portal 0. Also pinned: the routes' `(db as any).xxx`
  accessors all map to real generated-client models (the transposition trap).
- ⏳ **NOT PROVEN: no tenant is on, no code has reached a phone or inbox, no
  Turnstile key exists.** Acceptance (5 min, needs Izzy): flip **Loopcom Demo**
  on, sign in as a demo user → code arrives by text → wrong code answers "3 tries
  left" → right code + Remember → sign out/in → no code asked → Forget devices → code
  asked again. Negatives that matter: a wrong PASSWORD on an OTP tenant still
  answers `401 invalid_credentials`; a TOTP-enrolled admin on an OTP tenant sees the
  authenticator step only.
- ⏳ **Open, needs Izzy:** which tenants get it; the mobile OTP step (APK + TestFlight);
  the Turnstile site keys (DONE 2026-08-21 — observe mode, see the Turnstile section); whether `TENANT_ADMIN` should be allowed to flip its own
  tenant (today SUPER_ADMIN only — a customer turning it OFF for themselves defeats
  the control).
- ⛔⛔ **"ARE WE 100% SECURE?" — THE HONEST LEDGER IS §13 of the security handoff,
  and the short answer is NO, because the two headline controls are BUILT AND
  SWITCHED OFF.** Read live, 2026-08-19: `TURNSTILE_SECRET_KEY` **unset** (CORRECTED 2026-08-21: Turnstile is now ARMED in OBSERVE mode — it verifies and logs, and still refuses nobody; enforce is NOT on),
  **0 tenants** with 2FA on, **0 codes** ever sent, **0 users** MFA-enrolled,
  `PUBLIC_PORTAL_URL` **unset** (so every emailed link still says the OLD domain),
  **`m.loopcom.net` does not resolve**, and `app.` is still **DNS-only** at
  Cloudflare so the staged WAF rules are inert. ⛔ **A control nobody has turned on
  protects nobody** — quote the switch state, never the build state, when anyone
  asks how hardened the platform is.
