# AGENT HANDOFF — Multi-factor authentication (TOTP), Phase 11 of the security brief (2026-08-18)

Branch `feat/ivr-migration-takeover`. Owner: Izzy, who approved building it.
Brief: administrators must have strong MFA; ordinary users should be able to
enable it. **TOTP first, designed so passkeys can be added beside it later.**

Status at the end of this document's writing is recorded in §9 (deploy) — read
that before trusting anything else here as "live".

---

## 1. What was built, in one paragraph

A user can turn on two-step verification from **Profile menu → "Security &
two-step verification"** (`/account/security`): the api issues a TOTP secret
(RFC 6238, SHA1 / 6 digits / 30 s, ±1 step), the page shows a QR + manual key,
the person confirms the first code, and gets **ten single-use recovery codes
shown once**. From then on `/auth/login` with the right password answers a
**5-minute pre-auth token instead of a session**, and `POST /auth/mfa/challenge`
with a code (or a recovery code) answers the ordinary session body.
`SUPER_ADMIN` is the required role by default, in **GRACE mode**: an unenrolled
admin still signs in and is prompted (sign-in redirect + dashboard banner);
nothing is refused. Hard enforcement exists as an env flip that is NOT set.

Nobody was enrolled. No user row was touched. The migration adds two empty tables.

---

## 2. Files

### apps/api

| File | What |
|---|---|
| `src/mfa/totp.ts` | RFC 6238 over `node:crypto` (base32, HOTP/TOTP, `verifyTotp` with ±1 window + replay guard, otpauth URI). **No new dependency** (`dependencyHygiene.test.ts` class). |
| `src/mfa/recoveryCodes.ts` | 10 codes `XXXXX-XXXXX` (alphabet drops I/L/O/0/1), **bcrypt**-hashed (cost 10, same as passwords), normalised on compare. |
| `src/mfa/preAuthToken.ts` | HS256 JWT-shaped token signed with **a key derived from `JWT_SECRET` under `connect:mfa-preauth-token:v1`** — never the raw secret. Claims `{ sub, mfa_pending: true, purpose: "mfa_challenge", iat, exp(+300 s), jti }`. |
| `src/mfa/mfaPolicy.ts` | `MFA_REQUIRED_ROLES` (default `SUPER_ADMIN`), `MFA_ENFORCEMENT` (`grace` default; only the exact string `required` is hard), `decideMfaLoginGate`. No NODE_ENV. |
| `src/mfa/mfaService.ts` | Every decision with injected deps (store, encrypt/decrypt, audit, clock, throttle): `decideLoginMfa`, `beginTotpEnrollment`, `confirmTotpEnrollment`, `completeMfaChallenge`, `verifySecondFactor`, `disableMfaSelf`, `disableMfaByAdmin`, `regenerateRecoveryCodes`, `getMfaStatus`. Own throttle instance (`MFA_CHALLENGE_THROTTLE_CONFIG`: 5 wrong codes / 10 min per account, 25 per source, credential-stuffing block at 6 accounts). |
| `src/mfa/mfaRoutes.ts` | Prisma store (`db.userMfa`, `db.userMfaRecoveryCode`), the `@connect/security` AES-256-GCM envelope for the secret, the routes (§3). |
| `src/mfa/mfa.test.ts` | 24 tests — §7. Registered: `"src/mfa/*.test.ts"` in `apps/api/package.json`. |
| `src/loginThrottle.ts` | **Refactor only, behaviour identical:** the decision logic now takes the store as a parameter internally, and `createLoginThrottle(config)` returns an independent instance. The module-level functions `/auth/login` uses are unchanged (`loginThrottle.test.ts` 20/20 still). |
| `src/jwtPublicRouteBypass.ts` | `+ "/auth/mfa/challenge"` — the ONLY `/auth/mfa/*` path on the list; a test pins that. |
| `src/server.ts` | `/auth/login` post-password branch (§4); `issueLoginSession(userId)` extracted (the ONE place the session claim shape lives; login and challenge both use it); the JWT preHandler refuses any verified token carrying `mfa_pending` (belt and braces); `registerMfaRoutes(app, { audit, issueSession: issueLoginSession, service: mfaDeps })`. |
| `.env.example` | `MFA_REQUIRED_ROLES`, `MFA_ENFORCEMENT`, `MFA_ISSUER` documented. |

### packages/db

`prisma/schema.prisma`: `User.mfa UserMfa?`, models `UserMfa` (userId unique,
`totpSecretEncrypted`, `enabledAt?`, `lastUsedCounter?`) and
`UserMfaRecoveryCode` (`userMfaId`, `codeHash`, `usedAt?`; index `(userMfaId, usedAt)`),
both `onDelete: Cascade`. Migration
`prisma/migrations/20260818120000_user_mfa_totp/migration.sql` — verified
column-for-column against `prisma migrate diff --from-empty` output.

### apps/portal

| File | What |
|---|---|
| `lib/mfaLogin.ts` | Pure: `classifyLoginResponse` (session / mfa_challenge / failed), code-shape helpers, `mfaChallengeErrorMessage` (reads `.body`, never a slug), `securityPageDestination`, `safeNextPath` (same-origin only). |
| `lib/mfaLogin.test.ts` | 8 tests incl. source guards — §7. Registered in the portal `test` script. |
| `app/login/page.tsx` | Step two: code input (6-digit or recovery, "Use a recovery code" toggle, "Back to sign in"); pre-auth token lives in **component state only**; success path is the one `completeSignIn`; GRACE redirect. |
| `app/(platform)/account/security/page.tsx` + `phrases.ts` | The Security page (§5). Phrases in a sibling module because a `page.tsx` may export only its default (production-build rule). Wrapped in `<Suspense>` for `useSearchParams`. |
| `components/MfaEnrollmentNudge.tsx` | One-line dashboard banner, only when `enrollmentRequired`, gated on `hasBrowserAuthToken()`; "Not now" is per-tab. |
| `components/ProfileMenu.tsx` | "Security & two-step verification" button above Logout. |
| `app/(platform)/dashboard/page.tsx` | mounts `<MfaEnrollmentNudge />` (one line + import). |
| `app/globals.css` | `.lc-login-step`, `.lc-login-code`, `.lc-login-linkbtn` — 20 lines after `.lc-login-forgot:hover`. Security page ships its own `<style jsx global>` with theme tokens only. |

---

## 3. Route map (api)

| Method + path | Auth | Body | Answers |
|---|---|---|---|
| `GET /auth/mfa/status` | session | — | `{ enabled, enabledAt, pendingSetup, recoveryCodesRemaining, required, enrollmentRequired, methods }` |
| `POST /auth/mfa/totp/setup` | session | — | `{ secretBase32, manualKey, otpauthUri, issuer, account, digits: 6, periodSeconds: 30 }` · 409 `already_enabled` · 503 `mfa_unavailable` (no `CREDENTIALS_MASTER_KEY`) |
| `POST /auth/mfa/totp/verify` | session | `{ code }` | `{ enabled: true, enabledAt, recoveryCodes: [10] }` — **the only time the codes are shown** · 401 `invalid_code` · 400 `no_pending_enrollment` · 429 |
| `POST /auth/mfa/challenge` | **PUBLIC** (pre-auth token in body) | `{ preAuthToken, code }` | the normal login body `{ token, portalPermissionSet?, mfaMethod, recoveryCodesRemaining? }` · 401 `invalid_code` · 401 `preauth_invalid` · 429 `RATE_LIMITED` + `Retry-After` |
| `POST /auth/mfa/disable` | session | `{ code }` (TOTP or recovery) | `{ ok, enabled: false }` · 401 `invalid_code` · 400 `not_enabled` |
| `POST /auth/mfa/recovery-codes/regenerate` | session | `{ code }` (**TOTP only**) | `{ recoveryCodes: [10] }` — old ones dead |
| `POST /admin/users/:id/mfa/disable` | session, **SUPER_ADMIN**, under the `/admin/users` permission prefix | `{ reason? }` | `{ ok, wasEnabled }` — audited `MFA_DISABLED_BY_ADMIN` with both ids |

Audit actions written through the existing `audit()` helper: `MFA_TOTP_ENROLLED`,
`MFA_RECOVERY_CODE_USED` (with codes remaining), `MFA_RECOVERY_CODES_REGENERATED`,
`MFA_DISABLED` (self), `MFA_DISABLED_BY_ADMIN`. Failed challenges are throttled
and logged, not audited (noise).

---

## 4. The login contract, exactly

Decided in `/auth/login` **only after bcrypt matched**, so a wrong password
answers the identical `401 { error: "invalid_credentials" }` whether or not the
account has MFA — enrolment is never leaked on the login response.

| Case | HTTP | Body |
|---|---|---|
| no MFA, role not required | 200 | `{ token, portalPermissionSet? }` — **byte-for-byte the pre-MFA body** |
| no MFA, role required, GRACE (default) | 200 | `{ token, portalPermissionSet?, mfaEnrollmentRequired: true }` |
| no MFA, role required, `MFA_ENFORCEMENT=required` | 403 | `{ error: "mfa_enrollment_required", message }` — **NOT SET anywhere** |
| MFA on | 200 | `{ mfaChallengeRequired: true, preAuthToken, expiresInSeconds: 300, methods: ["totp","recovery_code"], error: "mfa_required" }` — **no session token; `lastLoginAt` not stamped** |
| then `POST /auth/mfa/challenge { preAuthToken, code }` | 200 | the row-1 body (+ `mfaMethod`) |

`error: "mfa_required"` on the 200 challenge body is deliberate: a client written
before MFA (the mobile app: `if (!res.ok || !json?.token) throw new Error(json?.error || "LOGIN_FAILED")`)
shows the readable slug instead of `LOGIN_FAILED`. The portal classifier ignores
it (a challenge is not a failure).

**Why "normal login is unchanged" is proven, not asserted:** `issueLoginSession`
returns exactly `{ token, ...(portalPermissionSet ? { portalPermissionSet } : {}) }`
and the no-MFA branch returns `{ ...session, ...(grace ? { mfaEnrollmentRequired } : {}) }`.
`mfa.test.ts` reads that from `server.ts`'s source and fails if either shape moves;
`decideLoginMfa` for a `USER` with no MFA row is pinned to `{ kind: "none" }`, and a
store failure degrades to `none` (a broken MFA table cannot lock the platform out).
`reply.jwtSign` → `app.jwt.sign` is the same plugin, same secret, same options
(HS256, `iat` added by fast-jwt in both) — `injectAsService` already uses
`app.jwt.sign` for tokens the routes accept.

**The pre-auth token cannot be used as a session, three ways:** (1) it is signed
with a *derived* key, so `req.jwtVerify()` — and telephony's / realtime's / the
agent's `jsonwebtoken.verify` on the raw `JWT_SECRET` — all reject it as a bad
signature with no change to any of them; (2) the api preHandler refuses any verified
token with `mfa_pending: true`; (3) the portal never writes it through
`writeAuthToken` (component state only; a source guard pins exactly one
`writeAuthToken` call site, on the classified session). Test: a real Fastify app
with `@fastify/jwt` + the same preHandler → 401 on `/me` for the pre-auth token,
401 for a session-key token tagged `mfa_pending`, 200 for a real session.

---

## 5. Portal flow

- **Sign-in:** password → if `mfaChallengeRequired`, the same card asks for the code
  (numeric keypad, `autocomplete="one-time-code"`, "Use a recovery code" toggle,
  "Back to sign in"). 429 → "Too many wrong codes. Wait ten minutes." `preauth_invalid`
  → back to the password step with "That sign-in step timed out." Success → the
  usual `writeAuthToken` + permissions + `cc-portal-permissions-saved` + navigate.
- **GRACE:** a session with `mfaEnrollmentRequired` lands on
  `/account/security?setup=1&next=<where they were going>`; the page shows the
  amber banner with a "Not now" link to `next`. Because sessions never expire, an
  already-signed-in admin never passes through `/login` — so the dashboard also
  shows a one-line nudge (`MfaEnrollmentNudge`) that reads `/auth/mfa/status` once,
  renders nothing for everyone else, and can be dismissed per tab.
- **Security page** (`/account/security`, any signed-in user, no permission key):
  status chip On/Off; **Turn on** → QR (white box, on purpose) + manual key + first
  code → recovery codes shown once with Copy + "I've saved my recovery codes";
  when on: "Get new recovery codes" (needs a TOTP code) and "Turn off" (TOTP or
  recovery code). Errors from `e.body.message`, never a slug. Every string is in
  `phrases.ts` for Yiddish (`useUiLanguage(SECURITY_PHRASES)`); the test asserts
  every `t("…")` literal on the page is registered.

---

## 6. ⛔ Mobile — the known limitation, plainly

`apps/mobile/src/api/client.ts` `login()` throws when the body has no `token`. So:

- A user **without** MFA: identical response, identical behaviour. Nothing changes.
- A user **with** MFA who signs in on the current mobile build: the app shows the
  error `mfa_required` and cannot complete the second step — **there is no MFA UI
  in the app.** This is opt-in exposure only (they enrolled themselves), and GRACE
  mode forces nobody into it. Until a mobile release adds the challenge step, a
  person who needs the phone app should not enrol, or should disable MFA first
  (`/account/security` → Turn off, or a SUPER_ADMIN reset).
- `/auth/mobile-qr-exchange` was **left alone**: it mints a session after a
  one-time provisioning token minted by an already-authenticated portal session,
  which is itself a second factor of sorts; wiring MFA into it without an app
  build would only break pairing. Recorded as an open item.
- The mobile app also still has **no 401 handling** (token-expiry handoff §8.2) —
  unchanged here.

---

## 7. Tests

```bash
cd apps/api && node --experimental-test-module-mocks --import tsx --test "src/mfa/*.test.ts"   # 24/24
cd apps/portal && npx tsx --test lib/mfaLogin.test.ts                                              # 8/8
```

api `mfa.test.ts` covers: RFC 6238 Appendix B vectors (SHA1, six values); base32
round trip; ±1 window / ±2 refused / replay refused / malformed; otpauth URI;
recovery code format + bcrypt match; pre-auth mint/verify/expiry/tamper/forge;
**pre-auth token rejected by the JWT hook** (real Fastify + `@fastify/jwt`);
bypass list = exactly the challenge; policy defaults (grace; SUPER_ADMIN only;
junk env = grace; `required` works; roles env parse); login gate none / grace /
challenge / pending-setup-is-inert / store-failure-degrades; setup→verify happy
path (secret stored through `encrypt`, 10 codes, audit); challenge TOTP + replay
+ wrong + bad/expired pre-auth; recovery code once + audit + second use refused;
throttle (5 wrong → 429 with Retry-After, right code refused inside window,
another user unaffected, window passes); regenerate refuses recovery code +
invalidates old; disable self (wrong code, right code, pre-auth token dead
after, `not_enabled`); disable by admin (TENANT_ADMIN 403, unknown 404, audit
carries both ids); **routes end to end via `app.inject`** (status → setup →
verify → challenge returns the login body shape → recovery once → admin
disable; 429 route shape); source guards on `server.ts` (decision after bcrypt,
challenge branch has no `token:` and no `issueLoginSession`, grace flag
conditional, `issueLoginSession` body exact, hook refuses `mfa_pending`,
registration line), the bypass list, `mfaRoutes.ts` (route set exact; only the
challenge lacks `getUser`), and a no-secret-logging sweep.

Non-vacuity: `git show HEAD:apps/api/src/server.ts | grep -c "decideLoginMfa\|mfa_pending\|registerMfaRoutes"`
→ **0** and the same for `"/auth/mfa/` in the bypass file → **0**, so both source
guards fail against the pre-change files.

portal `mfaLogin.test.ts`: classifier (token wins; challenge shape; legacy `error`
not a failure; flag-without-token = failed), code helpers, error mapping (never a
slug), `safeNextPath` (external / `//` / `/\` refused), and source guards: login
page has exactly one `writeAuthToken` call on the classified session, posts to
`/auth/mfa/challenge` with the state-held pre-auth token, reads `.body`, uses
`safeNextPath` and never `decodeURIComponent(next)`; security page has no named
export, imports `phrases.ts`, every `t("…")` literal registered, `.body` not
`.payload`, `<Suspense>`; ProfileMenu links the page; dashboard mounts the nudge;
nudge gated on `hasBrowserAuthToken()`.

Neighbours re-run green: `loginThrottle`, `publicReadyJwtBypass`,
`userDisplayName.callsites` (still finds `const namingExtension = await db.extension`
inside `issueLoginSession`), `nodeEnvGates`, `dependencyHygiene`, `internalSecret`
(68/68); portal `sessionExpiry.test.ts` (23/23 — its api-contract read of the
preHandler still matches). Portal suite **179/181** (the two pre-existing
`webrtcSdpDiagnostics` / `campaignsIndexLayout` failures). Portal typecheck **0**;
api typecheck **75 = the exact baseline, none in an edited file**. Full api suite
result recorded in `TESTS_RUN.md`.

---

## 8. Hard-enforcement flip, when Izzy wants it

1. Everyone in `MFA_REQUIRED_ROLES` (today: the one SUPER_ADMIN, `izzywgg@gmail.com`)
   has **enrolled and confirmed** — `SELECT u.email FROM "User" u JOIN "UserMfa" m ON m."userId"=u.id WHERE u.role='SUPER_ADMIN' AND m."enabledAt" IS NOT NULL;`
   must list every admin.
2. Set `MFA_ENFORCEMENT=required` in `/opt/connectcomms/env/.env.platform`
   (⛔ owner-only; and an env-only change has no deploy path — it rides the next
   real `apps/api/` commit, and is only ever proven by `docker exec app-api-1 sh -c 'echo $MFA_ENFORCEMENT'`).
3. From then on an unenrolled required-role login answers **403 `mfa_enrollment_required`**.
   Rollback = blank the variable + api restart. Any value other than exactly
   `required` is grace.

To widen the roles: `MFA_REQUIRED_ROLES=SUPER_ADMIN,TENANT_ADMIN` (comma list,
case-insensitive). Do that in grace first; the dashboard nudge and the sign-in
redirect do the prompting; flip to hard only when the query above is complete.

---

## 9. Deploy record

Filled in at deploy time — see the CLAUDE.md section and TESTS_RUN.md.

---

## 10. Open items / for Izzy

- **Enrol himself** — step one. Profile menu → Security & two-step verification →
  Turn on → scan → first code → save the ten recovery codes somewhere real.
- Mobile challenge step (needs an APK + TestFlight) — until then, MFA-enabled
  users cannot sign in on the phone app (§6).
- Whether TENANT_ADMIN should join the required list (grace first).
- Passkeys / WebAuthn: the store keeps `method`-agnostic result types and the
  challenge accepts any second factor through `verifySecondFactor`; a passkey
  factor is a new file beside `totp.ts` and a new branch in `verifySecondFactor`,
  not a re-cut of login.
- A pre-auth token is TTL-only (5 min), not single-use — the challenge throttle
  and the TOTP replay guard bound what a lifted token can do; making it
  single-use needs a jti table and was not judged worth a migration today.
- No admin UI for `POST /admin/users/:id/mfa/disable` yet — API only.
