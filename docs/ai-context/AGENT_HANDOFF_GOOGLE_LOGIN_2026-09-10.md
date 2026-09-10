# AGENT HANDOFF — Sign in with Google on the portal login (2026-09-10)

Commit `972674bf` on `feat/ivr-migration-takeover`. Mockup Izzy approved
("build it"): <https://claude.ai/code/artifact/3e1b15f5-f7df-4256-9613-9ababe8033d5>.
Izzy's rule, verbatim from the morning session: *"they should be able to log in
with Google Auth ONLY if their email address is already in the system. They
cannot sign up, only log in."*

## 1. What shipped

| Piece | Where |
|---|---|
| Pure rules — signed state + handoff tokens, ID-token reading, the policy | `apps/api/src/googleLogin.ts` |
| The three routes | `apps/api/src/googleLoginRoutes.ts` |
| The shared post-credential chain | `completeLoginAfterPrimaryFactor` in `apps/api/src/server.ts`, beside `/auth/login` |
| JWT bypass entries | `apps/api/src/jwtPublicRouteBypass.ts` |
| Button + error wording | `apps/portal/app/login/page.tsx`, `apps/portal/lib/mfaLogin.ts`, `.lc-login-google` / `.lc-login-or` in `globals.css` |
| Tests | `apps/api/src/googleLogin.test.ts` (routes through real Fastify, source guards), `apps/portal/lib/googleLoginWiring.test.ts` (registered), `mfa/mfa.test.ts` wiring guard updated |

Flow: `GET /auth/google/start?next=` → 302 to Google's account chooser
(`prompt=select_account`, `access_type=online`, scopes `openid email profile`)
→ `GET /auth/google/callback` exchanges the code with our client secret, reads
the ID token (issuer, audience, expiry, `email_verified === true`), looks the
email up in `User` → 302 back to `/login?g=<60-second one-shot handoff>` →
the portal takes `g` off the URL and POSTs `/auth/google/complete { code }` →
the ORDINARY login body.

## 2. The rules that must not be "simplified"

- **Nothing is created.** `decideGoogleLogin` has three answers: `not_registered`,
  `disabled`, `ok`. An unknown address bounces to `/login?google_error=not_registered`
  with plain English ("ask your administrator to add your email to your
  extension"). `INVITED` counts as registered — an admin adding a person's email
  to an extension is exactly when Google sign-in should start working; the
  create-a-password step becomes optional for them (the session path flips
  INVITED → ACTIVE, as a password login already did).
- **`/complete` calls the SAME function `/auth/login` calls after bcrypt** —
  DISABLED check → TOTP decision → sign-in-code gate → session. A person who
  turned the sign-in code on (Account → Security) is asked for it after Google
  too, and the session body is byte-identical. `mfa.test.ts`'s wiring guard
  pins the password door onto that function. Never mint a session in the
  Google routes.
- **No 401 anywhere on this path.** A stale/replayed handoff is `400`, not
  `401` — a 401 stream from a login page is how nginx auto-bans a customer's
  office. `not_registered` is not a login failure for the throttle either.
- **State and handoff are HS256 over a key derived from `JWT_SECRET` under
  `connect:google-login:v1`** — the same fence as `mfa/preAuthToken.ts`, so no
  session verifier on the platform can ever accept one. The handoff carries
  only the user id and is single-use (`HandoffRegistry`, in memory; a
  blue/green cutover inside the 60 s window costs one retry, never a replay).
- **The ID token's signature is deliberately NOT verified** — it arrives from
  Google's token endpoint over TLS in exchange for the code + our client
  secret, the case Google's own docs name as not needing signature validation.
  Issuer/audience/expiry/`email_verified` ARE checked, every time.
- **The Google button is a plain `<a>` to the api's start route** — no Google
  script on the page, no CSP change, no Turnstile token on that path (Google's
  chooser is the human check there). The redirect URI is
  `${origin}/api/auth/google/callback` where origin is the portal host the
  request arrived on (`portalOriginForRequest`) — the two-hostnames rule.
- **The `next` path is checked twice** (`safeNextPath` in the api and in the
  portal): same-origin path only, never `/login` or `/auth/*`.

## 3. Google side — DONE 2026-09-10

Client `connect production` (project `connect-497316`, id `1004420523742-…`)
now carries FOUR authorized redirect URIs, read back after save:

- `https://app.loopcom.net/api/crm/email/oauth/callback` (existing, Gmail connect)
- `https://app.connectcomunications.com/api/crm/email/oauth/callback` (existing)
- `https://app.loopcom.net/api/auth/google/callback` (new)
- `https://app.connectcomunications.com/api/auth/google/callback` (new)

Done in Izzy's Chrome as **support@connectcomunications.com** (`authuser=1`) —
the izzy@loopcom.net session demanded a password re-verification, which the
agent never types; a credential edit needs only an Owner, unlike branding
verification. Google says a client change can take "5 minutes to a few hours".
⛔ Console trap re-earned: the redirect list's a11y tree shows NO values, and
the renderer froze once on a zoom screenshot — verify values with a shadow-DOM
walk (`el.shadowRoot`) in `javascript_tool`, and click Save by ref
(`button[type=submit]`), not by coordinate.

No new env: the routes read the existing `GOOGLE_OAUTH_CLIENT_ID` /
`GOOGLE_OAUTH_CLIENT_SECRET` (verified present in `app-api-1`). No migration.

## 4. Same commit — the restricted Gmail/Drive scopes are gone from the app

The morning session also dropped what the 2026-09-02 OAuth handoff flagged as
still requested in code: `crm/emailRoutes.ts` asks for sign-in + `gmail.send`
only (`enableReplyTracking` is read and ignored), `crm/driveRoutes.ts` refuses
`POST /crm/drive/oauth/start` with `409 drive_import_unavailable` BEFORE any
env/crypto check, and `replyTrackingStatus` answers `unavailable` (not
`no_scope` = "reconnect") because a reconnect can never obtain the scope. The
CRM email settings/drive pages say so. Guards live in `googleLogin.test.ts`.

## 5. Deploy state

See the CLAUDE.md section for the container verification (api then portal,
`deploy-direct.sh --commit 972674bf`, log `/root/google-login-deploy.log`).

## 6. Acceptance (not yet done by a human)

1. Open `app.loopcom.net/login`, press **Sign in with Google**, pick the Google
   account whose address is a Loopcom login → you are signed in (or asked for
   your sign-in code first, if it is on).
2. The negative that matters most: pick a Google account whose address is NOT
   on Loopcom → back on the card with "That Google account isn't set up on
   Loopcom yet…", nothing created (`select count(*) from "User"` unchanged).
3. Press Cancel on Google's chooser → "Google sign-in was cancelled…".
4. `AuditLog` carries `USER_GOOGLE_LOGIN_VERIFIED` then `USER_GOOGLE_LOGIN`.
5. Same on `app.connectcomunications.com`.

## 7. Deliberately not built

Sign-up via Google; a "link my Google account" setting; the mobile app button
(the app has its own sign-in); Google One Tap. Each is its own decision.
