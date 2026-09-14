# ⛔ AGENT HANDOFF — Sign-in code (2FA by text/email) v3: PER USER, turned on/off ONLY on Account → Security, text or email ONLY (no authenticator app in the UI), the per-tenant admin switch REMOVED — BUILT, tested, DEPLOYED (2026-09-08) — READ FIRST before touching `/auth/login`, `/auth/otp/*`, the Security page, `User.loginOtpEnabledAt`, or before re-adding a tenant switch / TOTP enrolment / "remember this device" / `expiresIn`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOGIN_OTP_V3_SECURITY_PAGE_2026-09-08.md`**
(v2 flow at sign-in unchanged: `…V2_CHOICE…`). Memory: [[loopcom-2fa-sign-in-code]].
Mockups Izzy approved: https://claude.ai/code/artifact/9b16b8c3-4561-4bf6-b0d8-04d3572f18f7.
Izzy: *"I want the 2fa only to be accessed here [Account → Security]" … "remove the
Authenticator app, just stick with Text or email" … "Build it and deploy."*

- ✅ **THE SWITCH IS THE PERSON'S OWN `User.loginOtpEnabledAt`** (migration
  `20260908200000_user_login_otp_enabled`, NULL for everyone on ship day). Account → Security:
  the page shows the masked registered mobile + email → **Turn on** (`POST /auth/otp/enable`,
  one click, own row only, idempotent) → from then on every sign-in asks for a code by text or
  email (the v2 choice screen). **Turn off** asks for the **password** (`POST /auth/otp/disable
  { password }`, bcrypt, wrong = 401 + counted on the code throttle → 429), never a code — a
  lost phone never locks anyone out of turning it off. `GET /auth/otp/status` feeds the page.
- ⛔⛔ **THERE IS NO TENANT SWITCH AND NO AUTHENTICATOR-APP ENROLMENT ANY MORE.** Admin →
  Tenants lost the "Sign-in code (2FA)" column and `GET/PUT /admin/tenants/:id/login-otp`
  are gone (404). `Tenant.loginOtpRequired/loginOtpChannel` stay in the DB **inert** (dropping
  them would break the OLD api during blue/green) and a guard asserts nothing reads them. The
  TOTP routes + login branch stay dormant (0 users enrolled); the Security page no longer
  offers them; a legacy TOTP-on account sees "ask your administrator". Do not resurrect either
  without Izzy.
- ✅ **The role requirement is satisfied by the sign-in code:** `/auth/login` turns
  `enroll_grace`/`enroll_required` into `none` when `user.loginOtpEnabledAt` is set, and
  `getMfaStatus.enrollmentRequired` is false for them — the dashboard nudge disappears once
  Izzy turns it on. Login reads the switch off the user row already loaded (no tenant lookup,
  nothing to fail closed on).
- ✅ **Tests on the dev-box harness** (memory `devbox-verification-harness`; the harness now
  also mirrors `packages/db/prisma/schema.prisma` four levels above `src/mfa`): api
  `mfa/loginOtp.test.ts` **19/19**, `mfa/loginOtpRoutes.test.ts` **14/14** (real Fastify, faked
  db, real bcrypt), `mfa/mfa.test.ts` **25/25**; portal `lib/mfaLogin.test.ts` **12/12**,
  `lib/turnstileWiring.test.ts` **13/13**. ⏳ `tsc` cannot run here — the container build is
  the first typecheck.
- ✅ **DEPLOYED + container-verified 2026-09-08 ~21:25Z.** api via `scripts/release/deploy-direct.sh api`
  (first attempt died on `HEAVY JOB ALREADY RUNNING` — another session's portal build; a
  20-s poll on `ps aux | grep -c "[r]un-heavy"` + queue `runningCount` then ran it): migration
  `20260908200000_user_login_otp_enabled` applied (`information_schema.columns` shows
  `User.loginOtpEnabledAt timestamp`; 0 rows set), blue/green cutover 256/160 ms, health 86 ms,
  `app-api-1` at `68e17c90` (branch tip, contains `e0c3594d`) with `/auth/otp/status|enable|disable|send`
  in the running source and an unsigned `GET /auth/otp/status` → 401. Portal: the other
  session's direct deploy of the same tip (`direct-portal-20260908T211930Z.log`, done 68e17c90)
  carried it — my own portal job was cancelled as redundant; `app-portal-1` at `68e17c90`,
  built `account/security/page.js` has "Where your codes go" + the three otp routes, the
  authenticator copy and the Admin → Tenants "Sign-in code (2FA)" column are gone, the login
  choice card is present, `/login` 200. ⏳ NOT PROVEN: a real text/email to a human (Izzy's
  acceptance recipe, handoff §7).
- ⛔ The mobile app still has no code step; the Security page says so before "Turn on".
