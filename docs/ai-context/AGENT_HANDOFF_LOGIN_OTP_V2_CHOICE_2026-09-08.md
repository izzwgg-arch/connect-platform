# Sign-in code (2FA by text/email) v2 — the person chooses the channel, once per sign-in, no expiry (2026-09-08)

Branch `feat/ivr-migration-takeover`. **BUILT, tested on the dev box, previewed in the
in-app browser. ⛔ NOT DEPLOYED — Izzy asked to see it first.** No migration. Supersedes
the v1 behaviour in `AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §12 (the rules there
that are not listed under "what changed" below still hold).

Izzy, 2026-09-08, verbatim: *"Make the 2fa give an option between sms and email. It is
only required once when customer or tenant logs in, and it gets removed everytime
customer logs out. There is no expiry and only things that remove it is logging out.
Send the 2fa code to the registered phone number and email of the customer. Don't
deploy anything yet show it on the preview panel."*

## 1. What changed, v1 → v2

| | v1 (2026-08-19) | v2 (this) |
|---|---|---|
| Where the code goes | the api picked (SMS if a phone was on file, else email); "Text/Email me instead" after the fact | **the person picks** — the login answers with BOTH masked registered destinations and sends nothing until they choose |
| How often | every sign-in unless "Remember this device" (90 days) | **every sign-in, full stop** — the code is asked once per sign-in |
| Session for an OTP tenant | `expiresIn: "90d"` | **no expiry** — signed exactly like every other session on the platform |
| What ends a verified sign-in | 90 days, or "forget devices" | **signing out, and only that** |
| Remembered devices | `TrustedLoginDevice` rows, `cc-trusted-device` in localStorage, `GET/DELETE /auth/otp/trusted-devices` | **gone from the code** (table left in place, inert; the localStorage key is removed on sign-out and ignored by the api) |
| Registered destination | User.phone / User.email | unchanged — the client picks a **channel**, never a destination |

Reading of the spec: "required once when the customer logs in … removed every time
the customer logs out … no expiry" is satisfied by the session itself lasting until
sign-out (which is how every non-OTP session already behaves). A skip-the-code token
would add nothing — if the session is alive nobody is asked; if they signed out they
are asked. So it was removed rather than made permanent.

## 2. The contract

`POST /auth/login` (tenant switch ON, user not TOTP-enrolled) now answers ONE of:

```
// both channels possible, none requested → CHOOSE (nothing sent, no challenge row yet)
200 { otpChallengeRequired: true, preAuthToken, expiresInSeconds: 300,
      channels: ["SMS","EMAIL"],
      destinations: { SMS: "•••-•••-1213", EMAIL: "i•••@loopcom.net" },
      sent: false, reason: "choose_channel", error: "otp_required" }

// one channel possible (no phone, or tenant = SMS-only / EMAIL-only), or the client
// passed otpChannel → SENT straight away (as v1)
200 { …same…, channel: "EMAIL", destination: "o•••••@acme.test", sent: true }
```

Then:

```
POST /auth/otp/send    { preAuthToken, channel: "SMS"|"EMAIL" }   ← NEW
  → 200 { ok, channel, channels, destinations, destination, sent, reason?, expiresInSeconds: 600 }
  → 400 otp_channel_unavailable { channels } (asked for a channel not offered), 400 invalid_request
  → 401 otp_session_invalid (bad / wrong-purpose / expired pre-auth token)
POST /auth/otp/verify  { preAuthToken, code }                     (rememberDevice/deviceLabel REMOVED — ignored if sent)
  → 200 { token, portalPermissionSet?, otpMethod }                 (no trustedDeviceToken, no exp claim)
POST /auth/otp/resend  { preAuthToken, channel? }                  unchanged; now also returns `destinations`
```

`/auth/otp/send` reuse rules (`issueCode` in `loginOtpRoutes.ts`):

- no live challenge → create, send (`sendCount 1`);
- live challenge, **same channel** → re-bind to this login, send nothing (`sent:false, reason:"already_sent"`) — a double-click or a re-login costs no text;
- live challenge, **other channel, sends left** → re-bind, NEW code on the new channel, the old code dies (`sendCount+1`, attempts reset);
- live challenge, other channel, **cap (3) hit** → re-bind, send nothing, `reason:"send_limit"`, and the body names the channel/destination of the code that is still valid.

JWT bypass list: `/auth/otp/send`, `/auth/otp/verify`, `/auth/otp/resend` — **exactly
three**, pinned by `loginOtp.test.ts`. `checkTrustedDevice`, `decideTrustedDevice`,
`mintTrustedDeviceToken`, `OTP_SESSION_EXPIRES_IN`, `TRUSTED_DEVICE_TTL_DAYS` no longer
exist. `decideOtpGate({ tenantOtpRequired, userHasTotp })` has two inputs now. New pure
helpers: `normalizeOtpChannel`, `offerChannels(setting, phone, email)` →
`{ channels, destinations }`, `decideFirstSend(channels, requested)` → `send|choose`.

`issueLoginSession` (server.ts) signs **one way for everyone** — the per-tenant
`loginOtpRequired` lookup and the `expiresIn` branch are gone. A guard asserts exactly
one `app.jwt.sign(` call with no `expiresIn` in that function.

`loginRequest.ts`: `trustedDeviceToken` removed from the schema/type (zod strips it
from an old client); `otpChannel` kept.

## 3. Portal

- `lib/mfaLogin.ts`: `LoginApiResponse` gains `destinations`; the classified
  `otp_challenge` carries `awaitingChannel` (true on `reason:"choose_channel"`, or when no
  channel has been used yet and >1 is offered), `channels`, `destinations` (only string
  values for offered channels survive), `channel`, `destination`, `sent`, `reason`.
  Trusted-device fields removed. New `otpChannelLabel`, `otpChoiceLabel`.
- `app/login/page.tsx`: a new render branch `if (otp && otp.awaitingChannel)` — the
  choice card: one `.lc-login-choice` button per offered channel, phone/mail icon,
  "Text me / Email me" + the masked destination; → `POST /auth/otp/send`. The code
  screen lost the "Remember this device" checkbox; "Send it again" and "Text/Email me
  instead (masked)" remain; `send_limit` and `already_sent` get plain-English notices.
  `completeSignIn` writes only the session token. No `readTrustedDeviceToken` on login.
- `lib/trustedDevice.ts` **deleted**. `services/session.ts` `clearAuthSession()` also
  removes `cc-trusted-device`.
- `app/globals.css`: `.lc-login-remember` replaced by `.lc-login-choices / .lc-login-choice /
  -icon / -text / -to` (theme tokens, hover = accent border, focus ring).
- Admin → Tenants: the "Sign-in code (2FA)" tooltip now describes v2. The channel select
  ("Text or email / Text only / Email only") is unchanged — "Text or email" is what
  gives the person the choice.
- ⛔ The mobile app still has no OTP step (as in v1). A user on an OTP tenant cannot
  finish sign-in in the app until that ships. Nothing here changed that.

## 4. Files

```
apps/api/src/mfa/loginOtp.ts               rewritten (rules; header = the whole contract)
apps/api/src/mfa/loginOtpRoutes.ts         rewritten (issueCode, /auth/otp/send; trusted-device routes removed)
apps/api/src/mfa/loginOtp.test.ts          rewritten (20 tests)
apps/api/src/mfa/loginOtpRoutes.test.ts    rewritten (13 tests)
apps/api/src/server.ts                     login gate + issueLoginSession (6 anchored edits)
apps/api/src/jwtPublicRouteBypass.ts       + /auth/otp/send
apps/api/src/loginRequest.ts               - trustedDeviceToken
apps/portal/lib/mfaLogin.ts                rewritten
apps/portal/lib/mfaLogin.test.ts           OTP tail rewritten (12 tests)
apps/portal/lib/trustedDevice.ts           DELETED
apps/portal/app/login/page.tsx             rewritten OTP branches
apps/portal/app/globals.css                choice styles
apps/portal/services/session.ts            clearAuthSession drops cc-trusted-device
apps/portal/app/(platform)/admin/tenants/page.tsx   tooltip copy
```

No Prisma change. `TrustedLoginDevice` and `LoginOtpChallenge` schemas untouched.

## 5. Tests — what actually ran on the dev box (pnpm store is unreadable here)

Harness per memory `devbox-verification-harness`: `apps/api/src` copied to the scratchpad,
`@connect/*` + `@prisma/client` stubbed (ModelName generated from the real schema),
`fastify@5 @fastify/jwt@9 zod@3` npm-installed, Node 26 type-stripping with a
resolve/load hook (`ts-hooks.mjs`); the routes test's `require(...)` lines rewritten to
`await import(...)` in the scratch copy only.

```bash
node --import ./ts-hooks.mjs --test src/mfa/loginOtp.test.ts                                    # 20/20
node --experimental-test-module-mocks --import ./ts-hooks.mjs --test src/mfa/loginOtpRoutes.test.ts   # 13/13
# repo root, hook as a file:// URL (a C:\ path is read as protocol "c:")
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/mfaLogin.test.ts           # 12/12
node --import file:///…/ts-hooks.mjs --test apps/portal/lib/turnstileWiring.test.ts    # 13/13
```

Covered end-to-end through the real Fastify routes: choice offered with both masked
destinations and NOTHING sent; pick text → SMS to the registered phone; pick email →
`LOGIN_CODE` EmailJob on the tenant; one-channel auto-send; `otpChannel` at login; a
channel not offered → 400; a TOTP pre-auth token → 401; extra `to/email/destination`
fields ignored (the send still goes to the registered email); **after a verified sign-in
the next sign-in is challenged again, the session token has no `exp`, the v1 helper and
routes are gone**; wrong-code countdown / replay / cross-user / forged token / verify
before choosing (`no_challenge`); five wrong → dead + 429; resend + cap; admin switch;
double-click and 10 re-logins = still one text; channel switch on a live code kills the
old code, cap holds, last code still works; burned tries → replaced.

⏳ **NOT PROVEN:** `tsc` for api/portal (cannot run here — CI / the container build is
the first typecheck), a Next.js render of the real page, a real text or email.

## 6. The preview (what Izzy was shown)

Static mock served from the scratchpad on `http://127.0.0.1:4173/login` by a
zero-dependency Node server that serves the portal's REAL `app/globals.css` and REAL
`public/brand/loopcom/loopcom-wordmark-560.png`; the page reproduces the exact DOM/classes
of `app/login/page.tsx` (password → choice → code → signed-in stand-in → sign out) with
an in-page fake of the v2 api (choose, already_sent, send_limit, wrong-code countdown,
resend cap). A bottom bar says "Preview only" and shows the demo code. Files:
`scratchpad/preview/{index.html,server.mjs}` (session-scratch, not in the repo). Opened
in the in-app Browser pane; light and dark both rendered with the portal tokens.

## 7. Deploy / acceptance (when Izzy says go)

1. api + portal deploy through the queue (no migration, no env change).
2. Admin → Tenants → a consenting test tenant → Sign-in code **On**, channel **Text or
   email**; the test user must have `User.phone` set.
3. Sign in → the choice card shows `•••-•••-NNNN` and `x•••@…` → Text me → the text
   arrives from the platform number → code → in. Sign out → sign in → asked again.
4. Turn the tenant back Off unless it is staying on. Watch `login_otp_send_failed` in
   the api log.
