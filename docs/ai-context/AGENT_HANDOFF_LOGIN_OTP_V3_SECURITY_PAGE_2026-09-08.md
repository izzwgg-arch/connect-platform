# Sign-in code (2FA by text or email) v3 — per USER, on Account → Security only, no authenticator app (2026-09-08)

Branch `feat/ivr-migration-takeover`. Supersedes `AGENT_HANDOFF_LOGIN_OTP_V2_CHOICE_2026-09-08.md`
(the v2 flow at sign-in is unchanged; what moved is WHO switches it on and WHERE).
Mockups Izzy approved: https://claude.ai/code/artifact/9b16b8c3-4561-4bf6-b0d8-04d3572f18f7
(canvas "Loopcom Two-Step Verification": Security off / on / turning off, sign-in choose / code).

Izzy, 2026-09-08, in order: *"Check the one I uploaded first"* (a screenshot of Account →
Security with the authenticator-app "Turn on two-step verification" button) → *"I want the
2fa only to be accessed here."* → *"remove the Authenticator app, just stick with Text or
email."* → *"Build it and deploy."*

## 1. What v3 is

| | v2 (earlier today) | v3 (this) |
|---|---|---|
| Who switches it on | SUPER_ADMIN, per tenant, Admin → Tenants | **the person, for themself, Account → Security** |
| The switch | `Tenant.loginOtpRequired` + `loginOtpChannel` | **`User.loginOtpEnabledAt`** (null = off) |
| Methods on the Security page | authenticator app (TOTP) only | **a code by text message or email — nothing else** |
| Channels | tenant setting EMAIL/SMS/EITHER | text if a mobile number is on file, email always |
| Turning off | TOTP: a current code | **the password** (a lost phone never locks anyone out of turning it off) |
| Role requirement (SUPER_ADMIN grace nudge) | satisfied by TOTP only | satisfied by **either** the sign-in code or TOTP |
| Admin → Tenants "Sign-in code (2FA)" column | present | **removed**, with `GET/PUT /admin/tenants/:id/login-otp` |
| TOTP (authenticator app) | enrol on the Security page | **no UI to enrol any more**; routes + login branch stay, dormant (0 users were enrolled); an account that has it on sees a one-line note to ask an admin |

Sign-in itself is exactly v2: password → choose Text me / Email me (masked registered
destinations, nothing sent until chosen) → `POST /auth/otp/send` → code → `POST /auth/otp/verify`
→ ordinary session, no expiry, sign-out is the only thing that ends it, asked again next sign-in.

## 2. Data

Migration **`20260908200000_user_login_otp_enabled`**: `ALTER TABLE "User" ADD COLUMN
"loginOtpEnabledAt" TIMESTAMP(3);` — NULL for everyone on ship day. ⛔ `Tenant.loginOtpRequired`
/ `loginOtpChannel` are **deliberately left in place, inert**: dropping them would break the
OLD api container (which still selects them) during the blue/green swap. Nothing reads them
now; a guard asserts the OTP module and the login handler never mention them. Same for
`TrustedLoginDevice`.

## 3. API

`apps/api/src/mfa/loginOtpRoutes.ts` — routes, all registered by `registerLoginOtpRoutes(app, otpDeps)`:

```
PUBLIC (JWT bypass list — exactly these three, pinned):
  POST /auth/otp/send    { preAuthToken, channel }   → { ok, channel, channels, destinations, destination, sent, reason?, expiresInSeconds }
  POST /auth/otp/verify  { preAuthToken, code }      → { token, portalPermissionSet?, otpMethod }
  POST /auth/otp/resend  { preAuthToken, channel? }
SIGNED IN (Account → Security):
  GET  /auth/otp/status            → { enabled, enabledAt, channels, destinations, phoneOnFile, totpEnabled, required, enrollmentRequired }
  POST /auth/otp/enable  {}        → sets User.loginOtpEnabledAt (idempotent; audit LOGIN_OTP_ENABLED once) → status
  POST /auth/otp/disable { password } → bcrypt.compare against User.passwordHash; wrong = 401 invalid_password and counted
                                     on the SAME throttle as wrong codes (5 → 429 + Retry-After); right = clears the
                                     column, audit LOGIN_OTP_DISABLED {verifiedWith:"password"} → status
```

`server.ts /auth/login`: the tenant lookup (and its fail-closed 503) is gone — the switch is
on the user row already loaded: `decideOtpGate({ userOtpEnabled: Boolean(user.loginOtpEnabledAt),
userHasTotp: false })`. `let mfaOutcome …; if (mfaOutcome.kind !== "challenge" && kind !== "none"
&& user.loginOtpEnabledAt) mfaOutcome = { kind: "none" }` — the sign-in code satisfies a
required role, so the grace flag (`mfaEnrollmentRequired`) and the hard refusal do not apply
to someone who has it on. `otpDeps` no longer carries `requireSuperAdmin`. The admin tenant
list no longer returns `loginOtpRequired/loginOtpChannel`.

`mfaService.getMfaStatus` (what the dashboard nudge reads): `enrollmentRequired = required &&
!totpEnabled && !codeEnabled` via `store.getUser(...).loginOtpEnabledAt` (the Prisma store
selects it). `MfaUserRow.loginOtpEnabledAt?` added.

`loginOtp.ts`: `chooseChannels(hasPhone, requested?)`, `offerChannels(phone, email)`,
`decideOtpGate({ userOtpEnabled, userHasTotp })`; `TenantOtpChannelSetting` /
`normalizeTenantOtpChannel` removed.

## 4. Portal

- `app/(platform)/account/security/page.tsx` — rewritten (the mockup, pixel for pixel in the
  page's own `acs-*` styles): header; role banner when `enrollmentRequired` (or `?setup=1`);
  panel "Two-step verification" [On/Off chip]; "Where your codes go" box with the masked
  registered mobile (only when on file) and email; a note ("To change the mobile number, ask
  your administrator…" / "No mobile number on file, so codes go by email…"); the honest
  mobile-app caveat while off; **Turn on two-step verification** → `POST /auth/otp/enable`;
  **Turn off** → password form → `POST /auth/otp/disable { password }`. Legacy TOTP-on
  accounts get the one-line "ask your administrator" note. No QR, no recovery codes, no
  `/auth/mfa/*` calls from this page. `phrases.ts` rewritten (every `t()` literal registered;
  guarded).
- `app/(platform)/admin/tenants/page.tsx` — the "Sign-in code (2FA)" column, `setLoginOtp`,
  the `ConnectSelect` import and the two row fields removed.
- `components/MfaEnrollmentNudge.tsx` unchanged: it reads `/auth/mfa/status`, whose
  `enrollmentRequired` now goes false once the code is on; its link lands on the new page.
- Login page: unchanged from v2.

## 5. Tests (dev-box harness — pnpm store unreadable; `tsc` cannot run here)

```bash
node --import ./ts-hooks.mjs --test src/mfa/loginOtp.test.ts                                     # 19/19
node --experimental-test-module-mocks --import ./ts-hooks.mjs --test src/mfa/loginOtpRoutes.test.ts    # 14/14
node --experimental-test-module-mocks --import ./ts-hooks.mjs --test src/mfa/mfa.test.ts               # 25/25 (TOTP suite, untouched paths + status)
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/mfaLogin.test.ts            # 12/12
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/turnstileWiring.test.ts     # 13/13
```

New end-to-end coverage: status shape; enable = own row only, idempotent, audited once,
satisfies the role requirement; disable = no password 400, wrong 401 + counted, five wrong →
429 even for the right one, right one turns it off and the next sign-in is plain; the
v1/v2 admin and trusted-device routes answer 404 to a signed-in caller. Source guards: the
login handler reads `user.loginOtpEnabledAt` and mentions no tenant switch; the route list is
exactly the six above; disable is bcrypt + throttle + audit; the schema has the column; the
harness `@prisma/client` ModelName comes from the real schema.

## 6. Deploy + verification

See the CLAUDE.md section at the top of the file for the deploy record (api migration +
blue/green, portal build, container greps, live DB column check).

## 7. Acceptance (Izzy)

1. Account → Security → the page shows your masked mobile (•••-•••-1213) and email → Turn on.
2. Sign out → sign in → Text me → the text arrives from the platform number → code → in.
3. Sign out → sign in → asked again (Email me this time works too).
4. Security → Turn off → password → off → sign out → sign in → no code.
⛔ Do not turn it on for an account that signs in on the phone app until the app has the
code step.
