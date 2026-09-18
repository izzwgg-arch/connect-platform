# A7 — Loopcom/Connect API Integration Audit for "LoopCom Works"

Read-only architecture audit. All citations are `file:line` against the repo at
`C:\dev\projects\Connect 2` on branch `feat/ivr-migration-takeover`, 2026-09-18.
`apps/api/src/server.ts` is a single 43,140-line Fastify route file; line numbers
will drift on any edit to that file — re-grep the quoted function/route names if
they move.

---

## 1. Auth model of the api

### 1.1 JWT verification hook
- Registered at `apps/api/src/server.ts:475` — `app.register(jwt, { secret: JWT_SECRET_VALUE })`.
  Refuses to boot if `JWT_SECRET` is unset or < 32 chars (`server.ts:468-474`).
- Global `preHandler` hook at **`server.ts:6592-6641`**:
  1. `shouldSkipJwtVerification(path)` — if true, skip entirely (see 1.2).
  2. Accepts a JWT via `?token=` query param (copied into the `Authorization` header) — used for `<audio>`/download links that can't set headers.
  3. Accepts `?tenantContext=` query param, copied into `x-tenant-context` header, before verification.
  4. `req.jwtVerify()` — 401 on any failure.
  5. Rejects a token whose payload has `mfa_pending === true` (an MFA pre-auth token misused as a session — belt-and-braces, since it's signed with a derived key that already fails step 4).
  6. `SUPER_ADMIN` + `x-tenant-context: vpbx:<slug>` header → sets `req.pbxTenantOverride` to the slug (VitalPBX-direct tenant scoping, bypassing `TenantPbxLink`).
  7. `portalApiPermissionForPath(path)` — if the path maps to a portal permission key, calls `hasEffectivePortalPermission(user, permission)`; 403 if not held.
- A second, unrelated `onRequest` hook at `server.ts:6002` only stamps `_metricsStart` for Prometheus — not an auth gate.

### 1.2 Public-route bypass list
`apps/api/src/jwtPublicRouteBypass.ts` (318 lines) — `shouldSkipJwtVerification(path)` is the **single** allowlist consulted by the hook above. Categories, each with its own **in-handler** auth (never "no auth"):
- HMAC-signed URL: `/creative/download/*` (line 12).
- Shared-secret `/internal/*` doors — ~20 distinct paths individually enumerated (lines 29-117, 175-179) — see 1.4. ⛔ Comment on line 15: *"Every new `/internal/agent/*` path must be listed here or it answers unauthorized no matter what the handler does"* — this is a real footgun the same audit hit twice historically (lines 87-93).
- Device HTTP Basic: desk-phone provisioning file pattern `/phone-provisioning/<mac>/...` (line 20).
- HMAC-signed query (`exp`+`sig`) pull doors: IVR prompt sync/upload/download, MOH sync/upload/download (lines 118-133).
- Token-in-path public pages (browser has no Bearer token, token itself is the credential, validated in-handler against a DB row): `/meetings/public/*` (134-141), `/onboarding/*` (142), `/public/forms/*` (143), `/track/*` delivery tracking (144-147), `/phone-setup/*` desk-phone scan (148-156), `/texting-registration/*` (157-163), `/marketing/unsubscribe/*` (180-183).
- HMAC-signed `state` (OAuth-style): `/crm/email/oauth/callback` (164-168).
- Carrier/PBX inbound webhooks, each independently signature- or secret-verified in-handler, fail-closed: `/webhooks/pbx*`, `/webhooks/twilio/sms-status`, `/webhooks/sola-cardknox`, `/webhooks/whatsapp/meta`, `/webhooks/whatsapp/twilio/status`, `/webhooks/voipms/sms`, `/webhooks/signalwire/sms(-status|/registry)`, `/webhooks/telnyx/(mobile|sms|10dlc)` (lines 264-298).
- Billing pay links: `/billing/invoices/pay/*`, `/billing/platform/invoices/pay(-multi)?/*`, `/billing/platform/pay-links/*` (186-199).
- Auth flow itself: `/auth/signup`, `/auth/login`, `/auth/google/{start,callback,complete}`, `/auth/mfa/challenge`, `/auth/otp/{send,verify,resend}`, `/auth/mobile-qr-exchange`, `/auth/invite/{validate,accept}`, `/auth/password/{forgot,reset,reset/validate}` (236-263) — see §2.
- `/health`, `/ready`, `/api/ready`, `/metrics` (231-235, 299-301) — LB/deploy probes.
- Signed chat-attachment download `/chat/a/*` (301-307), `/downloads/*` (308-309), mobile APK download (310-313).

**Everything else requires a verified JWT.**

### 1.3 JWT claims
```ts
// server.ts:612
type JwtUser = { sub: string; tenantId: string; email: string; role: string };
```
Signed at `issueLoginSession` (`server.ts:~6333`): `app.jwt.sign({ sub, tenantId, email, role, name })` — `name` is an extra display-only claim not in the `JwtUser` type. **No `exp` is set — sessions never expire** (comment at `server.ts:6329-6332`: *"there is no expiry; the only thing that removes it is logging out"*, reaffirmed 2026-09-08 after a 90-day trial was reverted). **There is no session table.** Revocation is by client discarding the token; `User.status = "DISABLED"` is checked only:
  - at `/auth/login` and `/auth/google/complete` (`completeLoginAfterPrimaryFactor`, `server.ts:6248`),
  - at invite/password-reset token validation (`server.ts:6378,6398,6436,6451,6464`),
  - by the admin disable route itself (`server.ts:8266`).
  **It is NOT re-checked by the global `preHandler` or by `/me` on every request** — an already-issued token for a since-disabled user keeps working against ordinary routes until it happens to hit one of those four checkpoints (none of which fire on a normal API call). This is a material fact for any "revoke on Works side" design.

### 1.4 Roles
`enum UserRole` (`packages/db/prisma/schema.prisma:1293-1305`): `SUPER_ADMIN, TENANT_ADMIN, MANAGER, ADMIN, BILLING_ADMIN, BILLING, MESSAGING, SUPPORT, READ_ONLY, EXTENSION_USER, USER`.
Mirrored as `type StaffRole` in `server.ts:1888-1898` (identical list) with `isRole(user, allowed[])` (`server.ts:1900-1902`) as the base check, and dozens of derived `canX(user)` helpers (e.g. `canManageBilling` line 1906, `canManageMessaging` line 1910, `canViewCustomers` line 1912).
On top of the JWT role sits a **separate, richer permission-key system** — `PORTAL_PERMISSION_KEYS` (in `packages/shared`) resolved per-request via `hasEffectivePortalPermission` / `resolvePortalPermissionsWithCrmUserAccess` (`apps/api/src/crm/portalCrmPermissions.ts`) — this is what actually gates most routes (see §2.4), not the raw JWT role.

### 1.5 `x-tenant-context` (super-admin tenant switching)
**No single central helper** — the pattern (read `req.headers["x-tenant-context"]`, only honoured for `role === "SUPER_ADMIN"`, else fall back to `user.tenantId`) is **reimplemented per module**, e.g.:
- `apps/api/src/billing/billingAuth.ts:27-39` (`x-tenant-context` / `?tenantId=`)
- `apps/api/src/crm/guard.ts:36-39`
- `apps/api/src/delivery/guard.ts:12`
- `apps/api/src/connectChatRoutes.ts:96-99` (`effectiveChatTenantId`)
- `apps/api/src/globalSearchRoutes.ts:39,95`
- `server.ts:696-699` (`getEffectiveEmailTenantId`) — UUID-regex-validates the header before trusting it
- `server.ts:2563-2580ff` (`resolveConnectTenantIdForAdminExtensionPairing`) — also accepts `vpbx:<slug>` form, requires explicit context for SUPER_ADMIN (no ambiguous "first tenant" fallback)
- `server.ts:6606-6634` — the value is also read directly in the global preHandler for the `vpbx:` PBX-override case (§1.1.6).

A super-admin with no `x-tenant-context` set generally defaults to "their own"/global scope depending on the module — behavior is **not uniform**, which matters if Works needs a single super-admin identity to act across many tenants.

### 1.6 Existing service-to-service / API-key / HMAC mechanism
**One mechanism, reused everywhere: a single flat shared secret.**
- `apps/api/src/internalSecret.ts` — `checkInternalSecret(configured, incoming)` (lines 48-66): SHA-256-then-`timingSafeEqual` comparison (fixed-length, so no truncation-collision bug); **fail-closed** — missing config → 503, missing header → 401, mismatch → 403. This is deliberately the *only* implementation (the file's own header explains an 8-copy inline duplication bug that caused a real prod incident until 2026-08-18, see `docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md §1`).
- Concrete guard used by most `/internal/*` telephony/CDR doors: `guardInternalSecret(req, reply, endpoint)` at `server.ts:19222-19235` — reads env `CDR_INGEST_SECRET`, compares against request header **`x-cdr-secret`**. A second helper `verifyCdrSecret(req)` (`server.ts:19203`) does the boolean-only version, used e.g. by `GET /internal/telephony/user-extensions` (`server.ts:19203`, `37452`).
- Other `/internal/agent/*` doors (Coworker, voice agent, MOH, IVR/queue/route/extension-feature actions, account-setup-info, contacts-info, investigate, workbench) each re-check a **different** shared secret env var **inline in their own handler** (`AGENT_INTERNAL_SECRET` etc.) — same `checkInternalSecret` primitive, different secret value per subsystem, but still one flat secret per subsystem, not a per-caller/per-partner key.
- Inbound **webhook signature verification** (closest thing to a real crypto-auth precedent, but inbound-only): Ed25519 — `apps/api/src/loopcomMobile/mobileWebhookRoutes.ts` `verifyTelnyxSignature({ publicKeyB64, signatureB64, timestamp, rawBody })`, reused by `apps/api/src/telnyx/telnyxWebhooks.ts:33,48-60` for `/webhooks/telnyx/{mobile,sms,10dlc}`; SignalWire uses its own `X-SignalWire-Signature` check in `apps/api/src/signalwire/signalWireWebhookAuth.ts`; WhatsApp/Meta uses `apps/api/src/whatsapp/signature.ts`.
- **There is no per-partner API key, no scoped/rotatable credential, and no outbound HMAC-signing helper** anywhere in the codebase (`grep -rn "createHmac"` across `apps/api/src` turns up only inbound webhook verification and the `/creative/download` + `/voice/moh/download` **signed-URL** minting, e.g. `apps/api/src/urlSigningSecret.ts` — a `createHmac`-based signer that could be reused for outbound payload signing, but nothing wires it to an outbound POST today).

**Verdict: PARTIAL.** A fail-closed shared-secret primitive exists and is battle-tested, but it is a single flat secret per subsystem (not per-partner, not rotatable independently, not scoped to specific operations) — unsuitable to hand to an external product as-is. Ed25519 inbound-signature verification and HMAC URL-signing are both real, reusable precedents for building an outbound-signed-webhook scheme for Works.

### 1.7 `/internal/*` route protection
Confirmed closed (per §1.6): every `/internal/*` path is on the JWT-bypass list *and* re-checks a shared secret in its own handler via `checkInternalSecret`/`guardInternalSecret`/`verifyCdrSecret`. `apps/api/src/internalSecret.ts:1-23` documents the incident this fixed (`docs/ai-context/AGENT_HANDOFF_TENANT_ISOLATION_AUDIT_2026-08-17.md §1`) — until 2026-08-18 the secret was empty everywhere and these doors were wide open on the public internet.

### 1.8 Prisma models — org/user/extension/DID identity fields
All in `packages/db/prisma/schema.prisma` (schema lives in `packages/db`, **not** `apps/api`):

- **`Tenant`** (line 764) — `id` (cuid, the org id), `name`, `kind` (`CUSTOMER|INTERNAL|TEST`), plus dozens of tenant-level feature switches relevant to entitlement (§7): `webrtcEnabled`, `smsSubscriptionRequired`, `smsBillingEnforced`, `crmMode` (`"classic"|"supermarket"`), `yiddishEnabled`, `loginOtpRequired`/`loginOtpChannel`, `numberPurchaseEnabled`, `linkedSipCallVisibilityEnabled`, `smsRoutingMode`/`smsPrimaryProvider`/`smsSecondaryProvider`. **No generic `metadata Json?` bag on Tenant** — feature state lives as named typed columns (some other models do carry a `metadata Json?`, e.g. `CrmTimelineEvent`).
- **`User`** (line 1047) — `id`, `tenantId` (FK), `email` (unique, the login identity), `role` (`UserRole`), `status` (`INVITED|ACTIVE|DISABLED`), `phone`, `displayName`/`firstName`/`lastName`, `uiLanguage`. Relations of interest: `ownedExtensions Extension[]`, `mfa UserMfa?`, `loginOtpChallenges`, `sipAccounts UserSipAccount[]`.
- **`Extension`** (line 2881) — `id`, `tenantId`, `extNumber` (the phone-system extension, unique per `(tenantId, extNumber)`), `displayName`, `ownerUserId` (nullable FK → `User`), `status` ("ACTIVE" string, not enum), `billable`, `vmEmailEnabled`/`vmEmailIncludeTranscript`. Relation `pbxLink PbxExtensionLink?` (the PBX-side identity) and `tenantSmsNumbersAssigned TenantSmsNumber[]`. **No `PbxExtension` model** — `PbxExtensionLink` (line 3054) is the PBX-side join: `pbxExtensionId`, `pbxSipUsername`, `pbxDeviceName`, `webrtcEnabled`, `provisionStatus`.
- **`GlobalVoipMsConfig`** (line 4640) — `id` (`"default"` for the primary account, else per-account cuid), `label`, encrypted credentials, `smsEnabled`/`mmsEnabled`, `webhookSecretEncrypted`. One row per VoIP.ms account (multi-account support added 2026-09-15).
- **`TenantSmsNumber`** (line 4830) — the DID-to-org mapping for texting: `id`, `tenantId` (nullable until assigned), `provider` (`VOIPMS|SIGNALWIRE|TELNYX`, enum `IntegrationProvider`), `voipmsAccountId` (FK-by-string to `GlobalVoipMsConfig.id`), `fallbackProvider`, `phoneE164` (unique), `assignedUserId`/`assignedExtensionId` (mutually exclusive with the join table `TenantSmsNumberUser[]` for multi-user shared numbers), `smsCapable`/`mmsCapable`, `isTenantDefault`.

---

## 2. SSO precedents

### 2.1 `/auth/login` (`server.ts:6125-6216`)
Order: parse body (never `.parse()` directly — a malformed body must read as `401 invalid_credentials`, not `500`) → IP/email login-throttle (`evaluateLoginAttempt`, 429 on trip) → Cloudflare Turnstile human-check (`turnstileGate`, off until `TURNSTILE_SECRET_KEY` set) → case-sensitive then case-insensitive email lookup → `bcrypt.compare` → **shared** `completeLoginAfterPrimaryFactor(user, { via: "password" })`.

### 2.2 Shared post-credential chain — `completeLoginAfterPrimaryFactor` (`server.ts:6219-6304`)
Used identically by `/auth/login` and `/auth/google/complete` so the two doors can never drift:
1. `status === "DISABLED"` → 403 `account_disabled` (only reachable **after** the credential already matched — avoids a pre-credential oracle, `server.ts:6241-6248`).
2. MFA (TOTP) decision via `decideLoginMfa` (`apps/api/src/mfa/*`) → `none | enroll_grace | challenge | enroll_required`. A user with the per-user sign-in-code (OTP) enabled short-circuits enforced/enroll modes to `none` (their OTP *is* their second factor).
3. If `challenge`: returns `{ mfaChallengeRequired, preAuthToken, expiresInSeconds, methods, error: "mfa_required" }` — **no session token yet**. Client then calls `POST /auth/mfa/challenge` (on the JWT-bypass list, `jwtPublicRouteBypass.ts:251`) which verifies the 5-minute pre-auth token (signed with a **key derived from** `JWT_SECRET`, never the raw secret — `apps/api/src/mfa/preAuthToken.ts`) and mints the real session via the same `issueLoginSession`.
4. Else, per-tenant/per-user sign-in code (OTP by SMS/email) via `decideOtpGate`/`startOtpChallenge` (`apps/api/src/mfa/loginOtp.ts`, 245 lines) → if enabled, returns an OTP challenge body (no session); verified by `POST /auth/otp/verify` (bypass list).
5. Else: `User.status` is flipped `INVITED → ACTIVE`, `lastLoginAt` stamped, session minted by `issueLoginSession`.

### 2.3 Google login (`/auth/google/{start,callback,complete}`)
`apps/api/src/googleLoginRoutes.ts` (200 lines) wires `apps/api/src/googleLogin.ts`'s pure logic to Fastify:
- `start` (line 94) — 302 to Google (`buildGoogleAuthUrl`), state is HMAC-signed (`mintGoogleLoginState`), carries `origin`+`next`.
- `callback` (line 108) — verifies state, exchanges `code` for tokens, verifies the Google ID token (`readGoogleIdToken`, checks `aud`==our client id and `email_verified`), looks up the `User` by email (case-insensitive fallback like password login), **never creates a user** — an unregistered Google address is told so and nothing is written (line 163-167). On success mints a **60-second one-shot handoff code** (`mintGoogleLoginHandoff`, an in-memory `HandoffRegistry`, single-claim via `registry.claim(jti, exp, now)` — replay-proof) and 302s the browser back to `/login?g=<code>`.
- `complete` (line 177) — portal POSTs `{ code }`, handoff is verified+claimed once, then calls the **same** `completeLogin` (`completeLoginAfterPrimaryFactor`) as password login. Returns the identical session body shape.
- All three routes are unauthenticated by construction (browser carries no Bearer token) and are explicitly whitelisted in `jwtPublicRouteBypass.ts:243-245,293`.
- This handoff-code pattern (short-lived, single-claim, HMAC-signed state) is the most directly reusable precedent for an SSO **assertion mint/verify** flow for Works (Loopcom mints a short-lived one-shot code, Works exchanges it server-to-server for identity — same shape as `mintGoogleLoginHandoff`/`verifyGoogleLoginHandoff`).

### 2.4 Session/token lifetime, revocation, and `/me`
- **No `exp` claim, no session table** (§1.3). Logout is client-side token deletion only; there is no server-side blacklist/revocation list.
- `GET /me` (`server.ts:6644ff`) returns `{ role, firstName, lastName, displayName, email, status, lastLoginAt, avatarUrl, ownedExtensions[0] }` plus, if the DB role has drifted from the JWT's role claim, a **re-signed token** (`reply.jwtSign(...)`, same no-`exp` shape). It also calls `resolvePortalPermissionsWithCrmUserAccess` and returns the caller's `portalPermissionSet`. **It does not check `status === "DISABLED"`** — a disabled user whose token is still valid gets a normal `/me` response.

### 2.5 Permission resolver (`PORTAL_PERMISSION_KEYS`)
`apps/api/src/crm/portalCrmPermissions.ts`:
- `computeAuthoritativePortalPermissions(bucket, customPerms)` (lines 17-38) — if a non-SUPER_ADMIN user holds ≥1 active custom-role permission, their effective set is **exactly** the union of granted keys (custom roles are authoritative/replacing, not additive) plus re-derived legacy page-visibility keys (`backfillLegacyPageVisibility`) so a granular grant still shows the right nav shell.
- `resolvePortalPermissionsWithCrmUserAccess(jwtRole, userId, tenantId)` (line ~48) — cached (`permissionCache.ts`) wrapper around `resolvePortalPermissionsUncached`, which combines: the role's built-in bucket (`getEffectivePortalPermissionSetForJwtRole`/`platformRolePermissions.ts`), any custom-role grants, and CRM-specific gating (tenant CRM enabled + `CrmUserAccess.enabled` row) before a CRM key is granted.
- This is what `GET /me` returns as `portalPermissionSet` and what the global `preHandler` checks via `hasEffectivePortalPermission` for any path mapped in `portalApiPermissionForPath` (a big prefix→permission table starting around `server.ts:2958-3060`, e.g. `{ prefix: "/mobile-service", permission: "can_view_workspace_mobile" }` at line 3051).

### 2.6 Other exchange-token / magic-link precedents
- `POST /auth/mobile-qr-exchange` (`server.ts:6483`) — a QR-code-carried one-shot token, redeemed for a session (mobile app pairing flow); on the bypass list (`jwtPublicRouteBypass.ts:258`).
- `/auth/invite/{validate,accept}` and `/auth/password/{forgot,reset,reset/validate}` — token-in-body flows, each validated against a DB row (`UserPasswordToken`-style, type `INVITE`/`PASSWORD_RESET`) with expiry + single-use + disabled-user checks (`server.ts:6378-6464`).

---

## 3. Click-to-call / originate

**There is no server-side "place an outbound call" API today.** The one route with "originate" in its name is explicitly advisory:

- `POST /crm/calls/originate` — `apps/api/src/crm/callerIdPoolRoutes.ts:252-325`. Header comment (lines 7-10): *"ADVISORY ONLY. It selects and returns a caller ID but does NOT place any call. The actual call is placed client-side via WebRTC/SIP (`useSipPhone.ts` → `phone.dial()`). Do NOT add AMI/ARI originate logic here."*
  - Auth: `requireCrmAccess` (CRM permission-gated, tenant-scoped).
  - Body: `{ destination: string, contactId?, memberId?, campaignId? }` (zod-validated, `callerIdPoolRoutes.ts:258-263`).
  - Behavior: normalizes `destination` to E.164, calls `selectCrmCallerId(tenantId, destination)` for local-presence caller-ID selection, optionally logs a `CrmTimelineEvent` if `contactId` given, and returns `{ ok, destination, callerId, areaCode3, localPresenceEnabled, selectedFromPool, meta }`. **No call is placed by the api.**
  - The real call setup happens **entirely client-side**: the portal's WebRTC softphone (`apps/portal/hooks/useSipPhone.ts`) opens a SIP session directly to the PBX (over WSS, port 443 or 8089 per `Tenant.webrtcRouteViaSbc`) and sends its own INVITE. The api is never in that call path.
- `apps/telephony/src/telephony/ari/AriActions.ts:39-52` **does** implement a real `originate(params)` wrapping Asterisk ARI `POST /ari/channels` (endpoint, callerId, timeout, variables, context/extension/priority) — but `grep -rn "\.originate(" apps/telephony/src` (excluding tests) finds **zero callers**. This is unused, dead capability, not a live feature.
- Adjacent but distinct: `apps/api/src/vmRecordCallJobs.ts` / `vmRecordCallHelpers.ts` drive a PBX-helper-triggered *outbound* call for **voicemail-greeting recording** (`shouldAllowOriginate`, `classifyHelperOriginateFailure`) — a narrow, single-purpose "call yourself back to record a greeting" flow, not a general dialer API, and it goes through a bespoke PBX shell-helper (`asterisk -rx channel originate…`), not ARI.
- The nearest thing to a server-triggered call-setup event is the **mobile wake/push** mechanism (`CallInvite`/`CallWakeEvent` models, `/internal/pbx/wake-extension`, `/internal/mobile-ring-notify`, `/internal/mobile-prewake`) — but that's the PBX telling Connect "wake this device, a call is arriving," the reverse direction from click-to-call.

**Verdict for Works:** a true server-initiated originate door does not exist; `AriActions.originate` is the nearest reusable low-level primitive (already wraps Asterisk ARI) but has no HTTP route, no auth wrapper, and no caller today.

---

## 4. Live call state + events

### 4.1 Transport
- **`apps/realtime`** (`apps/realtime/src/server.ts`, 44 lines) is a **trivial JWT-gated WebSocket echo server** on `/ws` — verifies a Bearer/`?token=` JWT with the shared `JWT_SECRET`, sends `{"type":"connected"}`, then echoes any message back. It is **not** the live-call event bus; nothing in the portal subscribes to it for call state (no `apps/portal` references to it were found). Likely legacy/placeholder infrastructure.
- **The real feed is `apps/telephony`'s `/ws/telephony`**, served by `apps/telephony/src/telephony/websocket/TelephonySocketServer.ts`. Auth: JWT passed as `Authorization: Bearer` or `?token=` query param, verified with `jwt.verify(token, env.JWT_SECRET)` (`TelephonySocketServer.ts:167-178`) — **same secret as the api**, so an api-issued session token works directly against telephony's socket with no separate credential.
- The portal client is `apps/portal/hooks/useTelephonySocket.ts` (337 lines): connects to `wss://<same-origin>/ws/telephony?token=<jwt>` (same-origin-first resolution to survive multi-hostname deploys, `resolveTelephonyWsUrl`, lines 43-54), auto-reconnects with backoff, and probes `/me` on an "unauthorized" close to decide whether to keep retrying.
- nginx proxies `/ws/telephony` on every platform vhost to the telephony service (per code comments; nginx config itself was not read for this audit — out of scope path).

### 4.2 Event types
From `useTelephonySocket.ts:136-206` (client) and the mirrored types in `apps/portal/types/liveCall.ts`:
- `telephony.snapshot` — full state: `{ calls[], extensions[], queues[], health }`.
- `telephony.calls.snapshot` — calls-only refresh.
- `telephony.call.upsert` — one `LiveCall`, carries a monotonic per-call `seq` so the client can drop stale/out-of-order upserts (dropped if delivered after that call's own `remove`, `types/liveCall.ts:33-34` / `callStreamOrder.ts`).
- `telephony.call.remove` — `{ callId, seq }`.
- `telephony.extension.upsert` — one `LiveExtensionState`.
- `telephony.queue.upsert` — one `LiveQueueState`.
- `telephony.health` — link/health status.

### 4.3 `LiveCall` shape (`apps/portal/types/liveCall.ts:10-46`) — the data available on an inbound event
`id`, `linkedId` (Asterisk Linkedid), `tenantId`, `tenantSlug`, `tenantName`, `direction` (`inbound|outbound|internal|unknown`), `state` (`ringing|dialing|up|held|hungup|unknown`), `from`, `fromName` (CNAM), `fromPrefix` (ring-group CID tag), `to`, `connectedLine`, `source_extension`, `destination_extension`, `channelState`, `channels[]`, `bridgeIds[]`, `extensions[]`, `queueId`, `trunk`, `startedAt`/`answeredAt`/`endedAt`, `durationSec`/`billableSec`, `metadata`, `seq`, and — when the viewer has CRM access and a contact matched — `crmContactId`/`crmContactName`/`crmCompanyName`/`crmProfileUrl`/`crmMatchSource` (`exact|secondary|fallback_suffix`). This is already a rich, ready-made screen-pop payload.

### 4.4 CRM screen-pop path (portal-internal)
The portal's "Incoming Call / Unknown caller / Dismiss" card is driven **directly off this same `useTelephonySocket()` feed** (found via string match in `apps/portal/components/dashboard/CommunicationsRow.tsx`, `components/DesktopMiniDialer.tsx`, `components/FloatingDialer.tsx`, `lib/crmInboundCallDisplay.ts`) — i.e. there is **no separate PBX-webhook → api → push-notification pipeline for screen pop**; the CRM-match enrichment (`crmContactId` etc.) is computed server-side inside telephony/api (`apps/api/src/crm/inboundCallerMatch.ts`, 297 lines) and folded into the same `LiveCall` object the WebSocket already streams.
- The pure read-only PBX-event-ingest pipeline (`apps/api/src/pbxEventIngest.ts`, `/internal/pbx-event-ingest`, gated by `PBX_EVENT_INGEST_ENABLED`+`PBX_EVENT_INGEST_SECRET`) is explicitly **observability only** — *"never writes to the PBX/AstDB/ombutel"* (file header) — it is a separate, disabled-by-default audit trail, not the live-call path.

### 4.5 AMI/ARI event consumers (`apps/telephony`)
- `apps/telephony/src/telephony/ami/AmiClient.ts` / `AmiEventMapper.ts` (330 lines) map raw AMI frames to typed events: `Newchannel, CoreShowChannel, NewCallerid, Newstate, DialBegin, DialEnd, BridgeEnter, BridgeLeave, Hangup, Cdr, QueueCallerJoin, QueueCallerLeave, QueueMemberStatus, QueueMemberPaused, ExtensionStatus, DeviceStateChange, PeerStatus, ContactStatus(Detail), AttendedTransfer, BlindTransfer, MessageWaiting` (`AmiEventMapper.ts:36-299`). These feed the in-memory live-call store that `TelephonySocketServer` broadcasts as the `telephony.*` events above.
- `apps/telephony/src/telephony/ari/AriActions.ts` (§3) exists for control-plane actions (hangup, bridge, originate, play sound) — `whisperChannel`/`bargeCall` are explicit unimplemented placeholders (`throw new Error(...)`, lines 63-77).

**For Works:** the live-call feed already carries everything an inbound-screen-pop event needs, but it is delivered over a **WebSocket that any bearer of a valid Loopcom session JWT can open** — there is no per-event outbound push to an external URL, and no way today to scope a subscription to "only tenant X's calls" for an external system holding a service credential rather than a user session (see §8 gap list).

---

## 5. Call history / voicemail / transcription / summaries

### 5.1 CDRs — `ConnectCdr` model (`packages/db/prisma/schema.prisma:3188-3230+`)
Fields: `id`, `linkedId` (unique, Asterisk Linkedid — canonical dedupe key), `tenantId` (nullable; either a Connect cuid or `vpbx:{slug}` placeholder — **two coexisting formats**, reconciled ad hoc by callers, see §5.2), `pbxVitalTenantId`, `pbxTenantCode`, `fromNumber`/`fromName`/`fromPrefix`, `toNumber`, `direction`, `disposition` (`answered|missed|busy|failed|canceled|unknown`), `startedAt`/`answeredAt`/`endedAt`, `durationSec`/`talkSec`, `queueId`, `hangupCause`, `dcontext(sSeen)`, `channelsSeen`, `rawLegCount`, `isForwarded`, `recordingPath` (deterministic `YYYY/MM/DD/<linkedId>.wav`, but only **proves intent, not existence** — see the model's own doc-comment, `schema.prisma:3216-3224`), `recordingMissingAt`, plus per-call RTP quality samples.

Route: `GET /calls/history` — `apps/api/src/server.ts:31445ff`. Auth: `requirePermission(req, reply, canViewCustomers)`. Query params (zod, lines 31448-31461): `tenantId?`, `startDate?`, `endDate?`, `direction` (`all|incoming|outgoing|internal`), `status` (`all|answered|missed|canceled|failed`), `hasRecording` (`all|yes|no`), `search?`, `searchOnly?`, `page`, `pageSize` (10-200). Scoping logic (lines 31463-31510+) is intricate: super-admins may pass `tenantId` (resolves both `vpbx:` and cuid forms and searches for rows under **either**); non-super-admins are hard-scoped to their own tenant; there's also an "extension-scoped call viewer" mode (`isExtensionScopedCallViewerForUser`) that further narrows to the caller's own extension numbers, and a tenant-level `linkedSipCallVisibilityEnabled` switch that additionally includes cross-tenant linked-SIP extensions.

### 5.2 Voicemail — `Voicemail` model + `GET /voice/voicemail`
Route at `server.ts:19442`, response built at `server.ts:19620-19710+`. Auth: permission-gated (same family as call history). Response per row: `id, callerId, callerName, receivedAt, durationSec, folder (inbox|old|urgent), listened, extension, tenantId, tenantName, transcription, transcriptLanguage, note, noteUpdatedAt/By, callbackReminderAt/Label/By`. **`transcription`/`transcriptLanguage` are populated by an AI agent process** (comment at line 19708: *"AI transcript (agent-populated)"*) writing into `Voicemail.transcript`/`transcriptLanguage` columns — this is a real, working voicemail-transcription pipeline. Greeting-management sub-routes: `GET /voicemail/greeting` (20339), `POST /voicemail/greeting/upload` (20504), `/reset` (20533), `/record-call` (20555) + status poll `GET /voicemail/greeting/record-call/:jobId` (20611).

### 5.3 Recordings
No separate `/recordings` listing route was found; recording playback/download rides off `ConnectCdr.recordingPath` (and the voicemail audio file) via signed/authenticated download routes elsewhere in `server.ts` (not individually inventoried here — out of the explicit ask list, but the **existence caveat in §5.1 is load-bearing**: a non-null `recordingPath` does not guarantee a playable file).

### 5.4 Call summaries / transcription of live calls
**No AI summary or transcription of ordinary phone calls exists.** The only `aiSummary` field in the schema belongs to `CallFlightSession` (mobile-answer-reliability diagnostics, e.g. `server.ts:13979`, `14020`, `14393`, `15345`) — an internal engineering diagnostics feature, not a customer-facing "what was this call about" summary. Voicemail transcription (§5.2) is the only transcription surface that exists today.

---

## 6. Messaging

### 6.1 The provider registry ("Messaging Router") — `apps/worker/src/messagingDispatch.ts`
Lives in **`apps/worker`**, not `apps/api` (worth flagging — the actual send happens in a background worker, api only enqueues/reads). Header (lines 1-27) states the invariants: dispatch decided by the **number's own row** before any VoIP.ms-specific logic runs; VoIP.ms itself is **not** in this registry (its send path — segmenting, 3-media MMS chunking, audio→MP4 conversion, link fallback — stays inline in `connectChatSmsJob.ts` as the registry-miss fallthrough, i.e. VoIP.ms is the default/legacy path and SignalWire/Telnyx are the "new" explicit adapters). `REGISTERED_CHAT_PROVIDERS = ["SIGNALWIRE", "TELNYX"]` (line 42); `getOutboundChatAdapter(provider)` dynamically imports `signalWireChatSend.ts` / `telnyxChatSend.ts`. Each adapter must tag any thrown error with `__anySent` so the tenant's optional `TenantSmsNumber.fallbackProvider` backup route fires **only** when the primary carrier accepted nothing (never a double-send).

### 6.2 The "chat door" — portal send route
`apps/api/src/connectChatRoutes.ts`:
- `POST /chat/threads` (line 1193) — creates/looks-up a thread; `type: "dm"|"sms"|"group"`. For `sms`, the destination phone number becomes part of a deterministic `dedupeKey` on `ConnectChatThread` (`sms:{tenant}:{tenantE164}:{externalE164}:{inboxScope}` per the schema comment at `packages/db/prisma/schema.prisma:4891`).
- `POST /chat/threads/:threadId/messages` (line 1587) — the actual send; enqueues to the worker, which resolves the provider via `messagingDispatch.ts` (§6.1).
- Supporting: `POST /chat/threads/:threadId/attachments/upload` (1315, MMS media), `/read` (1509), `/unread` (1530), `/typing` (1544), `/messages/:messageId/reactions` (1729), `/archive` (1015).
- Conversation model: `ConnectChatThread` (`schema.prisma:4874`) + `ConnectChatParticipant` + `ConnectChatMessage` — this **is** the message-history model; there is no separate "SMS log" table.

### 6.3 MMS
Handled inline in the VoIP.ms legacy path (`connectChatSmsJob.ts`, referenced but not the registry) with chunking/audio-to-MP4 conversion; `TenantSmsNumber.mmsCapable` gates it per-DID; `GlobalVoipMsConfig.mmsEnabled` gates it per-account.

### 6.4 WhatsApp
`apps/api/src/whatsapp/` — `normalize.ts`, `sendPolicy.ts`, `signature.ts` (Meta webhook signature verification). Schema: `WhatsAppProviderConfig`, `WhatsAppThread`, `WhatsAppMessage`, `WhatsAppAccount` (all on `Tenant`, `schema.prisma` — relations seen at lines ~862-864). Inbound webhook: `/webhooks/whatsapp/meta`, `/webhooks/whatsapp/twilio/status` (both on the JWT-bypass list, `jwtPublicRouteBypass.ts:266-267`).

### 6.5 RCS
Exists **only** as a platform-staff bench feature inside the Telnyx admin console, not wired into the unified messaging router or customer-facing send door: `apps/api/src/telnyx/telnyxClient.ts:523-546` (list RCS agents, `sendRcsMessage` with SMS fallback — comment: *"Real money, never retried"*) and `apps/api/src/telnyx/telnyxRoutes.ts:419-452` (`GET` list agents, `POST` send). No `TenantSmsNumber`/`ConnectChatThread` integration found — a customer cannot send RCS through the normal chat door today.

### 6.6 Inbound webhooks
- `/webhooks/telnyx/sms` — Ed25519-verified (§1.6), feeds the shared `ConnectChatThread`/`ConnectChatMessage` ingest (per CLAUDE.md history, "the ONE ingest + final-states-only DLR").
- `/webhooks/voipms/sms` — VoIP.ms has no push webhook reliability guarantee historically; also **polled** (`voipms poll` referenced in CLAUDE.md history) as a backstop, in addition to the webhook.
- `/webhooks/signalwire/sms`, `/webhooks/signalwire/sms-status`, `/webhooks/signalwire/registry` — signature-verified via `signalwire/signalWireWebhookAuth.ts`.
- `/webhooks/telnyx/mobile`, `/webhooks/telnyx/10dlc` — same Ed25519 pattern, different feature (Loopcom Mobile wireless events / 10DLC registration status).

### 6.7 `billingSmsSender` — explicitly NOT to be touched (per task instructions), noted only: this is the platform's own outbound sender identity for billing texts (pay links, OTP), VoIP.ms-number-hardwired per CLAUDE.md history, unrelated to a Works integration surface — flagged here only so the lead engineer does not confuse it with a general "send SMS as the platform" door.

### 6.8 Outbound webhook subscription model — **does not exist**
`grep -rn "WebhookSubscription\|outboundWebhook\|deliverWebhook"` across `apps/api/src` and `packages/db/prisma/schema.prisma` returns **zero matches**. There is no tenant-facing "register a URL, we'll POST events to it" concept anywhere in the platform today — inbound webhooks (carriers → Loopcom) are the only kind that exist. Building Works integration means building this primitive from scratch (see §8's recommendation).

---

## 7. Entitlement

- **No unified `tenant.features` JSON bag and no `IntegrationConnection`/"apps enabled" model.** Feature entitlement is split across three uncoordinated mechanisms:
  1. **Named boolean/enum columns directly on `Tenant`** for platform-level capabilities — `webrtcEnabled`, `smsSubscriptionRequired`, `smsBillingEnforced`, `crmMode`, `yiddishEnabled`, `numberPurchaseEnabled`, `linkedSipCallVisibilityEnabled`, `loginOtpRequired` (`schema.prisma:764-846`). Each is checked ad hoc wherever relevant, not through one resolver.
  2. **`ProviderCredential`** (`schema.prisma:2005-2022`) — one row per `(tenantId, provider)` with `isEnabled` — the closest thing to a per-tenant "integration connected" record, but scoped to carrier/provider credentials (Twilio/VoIP.ms/etc.), not general third-party apps.
  3. **Portal permission keys** (`PORTAL_PERMISSION_KEYS`, §2.5) — this is what actually gates whether a **page/route** is usable, resolved per-user (not per-tenant) via role bucket + custom-role grants + CRM access rows. The existing precedent for "a whole feature area is off unless granted" is exactly how `can_view_workspace_mobile` gates the entire Loopcom Mobile product (`server.ts:3051`, `{ prefix: "/mobile-service", permission: "can_view_workspace_mobile" }`) — new features are shipped with the key in **no default role bucket**, so nobody sees it until explicitly granted (same pattern CLAUDE.md's "Creative Studio" and "Loopcom Mobile" launches both used).
- **Billing plan (`BillingPlan`/`Subscription`, `schema.prisma:1380-1461`) carries no feature-flag JSON** — only pricing fields (`extensionPriceCents`, `smsPriceCents`, etc.) and subscription status. Billing plan and feature entitlement are **not** currently linked in the schema.
- **Where a "Works enabled for this tenant" flag would naturally live:** given the existing precedent (§7.1-3), the two idiomatic choices are (a) a new named boolean on `Tenant` (matching `webrtcEnabled`'s pattern) if it's a platform-wide on/off switch per tenant, or (b) a new small linked model (matching `ProviderCredential`'s per-tenant-per-integration shape, e.g. `WorksIntegration { tenantId, enabled, apiKeyHash, webhookUrl, webhookSecretEncrypted, createdAt }`) if Works needs its own credential material stored — **(b) is the better fit**, since Works will need a stored outbound-webhook URL and a signing secret per tenant, which `ProviderCredential` almost already models (it currently only stores *inbound* carrier credentials, but the shape — one row per tenant per external system, encrypted secret, `isEnabled` — is directly reusable).

---

## 8. Gap list + recommendation

| Works need | Status | Detail |
|---|---|---|
| SSO assertion mint/verify | **PARTIAL** | No dedicated assertion API, but `googleLogin.ts`'s one-shot HMAC-signed handoff-code pattern (§2.3) is a directly adaptable template: Loopcom could mint a short-lived, single-claim code Works exchanges server-to-server for identity + a Works-scoped token. |
| Entitlement check ("is Works on for this tenant") | **MISSING** | No feature-flag/integration-connection concept fits today (§7); needs a new model. |
| User/org sync | **PARTIAL** | `GET /internal/telephony/pbx-tenant-map` and `GET /internal/telephony/user-extensions` (`server.ts:37376`, `37452`) already return tenant↔extension↔user mappings server-to-server under the shared-secret gate — reusable as a sync source, but scoped to telephony identity, not full org/user profile, and gated by the flat internal secret (§1.6), not a partner-scoped credential. |
| Click-to-call | **MISSING** | `/crm/calls/originate` is advisory-only (§3); no server-side call-placement API exists. `AriActions.originate` (telephony) is real but has zero HTTP exposure and zero callers today. |
| Live call state | **PARTIAL** | `/ws/telephony` (§4) already streams everything needed (`LiveCall` shape is rich), but it's a session-JWT-gated WebSocket for browser clients, not a service-to-service subscription; no scoping to "give me only tenant X" for a non-user caller. |
| Inbound-call screen-pop delivery to an external URL | **MISSING** | The event exists on the WebSocket (§4.4) but there is no outbound-push mechanism of any kind (§6.8) — Works would have to hold a live WebSocket connection itself, which is not how Works's "field-service app on its own server" would want to consume events. |
| Call history | **EXISTS** | `GET /calls/history` (§5.1) — but needs a service-to-service auth wrapper; today it's JWT+portal-permission gated only. |
| Voicemail references | **EXISTS** | `GET /voice/voicemail` (§5.2), same caveat. |
| Transcription | **PARTIAL** | Voicemail transcription exists and is returned in the voicemail list (§5.2); call-recording/live-call transcription does not exist anywhere (§5.4). |
| Send SMS/MMS | **EXISTS** | `POST /chat/threads` + `POST /chat/threads/:id/messages` (§6.2) — provider-agnostic via `messagingDispatch.ts`; same JWT+portal-permission-gate caveat. WhatsApp exists similarly; RCS exists only as a platform-staff bench tool (§6.5), not customer-usable. |
| Message history | **EXISTS** | `ConnectChatThread`/`ConnectChatMessage` is the one message-history model (§6.2), same auth caveat. |
| Revoke | **MISSING/WEAK** | No session table, no token expiry, disable-check not enforced per-request (§1.3, §2.4) — revocation for a Works-issued credential needs its own, separate mechanism; do not reuse the user-session pattern for this. |

### Recommended shape (no code)
1. **New surface `/integrations/works/v1/*`** in `apps/api`, registered as its own Fastify plugin file (keeps it out of the 43k-line `server.ts`), authenticated by a **new, dedicated mechanism** — not the flat `CDR_INGEST_SECRET`-style shared secret (§1.6 shows why that doesn't scale to an external partner: one leaked value opens every internal door). Mint a per-tenant `WorksIntegration` credential (API key + HMAC secret, modeled on `ProviderCredential`'s shape, §7) and require `X-Works-Key` + `X-Works-Signature` (timestamp+body HMAC, reusing `urlSigningSecret.ts`'s primitive) on every call, checked with the existing `checkInternalSecret`-style constant-time comparison per-tenant secret (not one platform-wide value).
2. **SSO**: reuse the `googleLogin.ts` handoff-code pattern (§2.3) — Loopcom portal (already logged in) mints a one-shot code via a new `/auth/works/handoff` endpoint; Works exchanges it server-to-server against `/integrations/works/v1/sso/exchange` for a Works-scoped, **short-lived, expiring** token (do not reuse the no-`exp` session-JWT pattern here — that gap is acceptable for a browser session but wrong for a token handed to a second product).
3. **Entitlement**: add `WorksIntegration` model (tenant-scoped, `enabled`, credential fields, `webhookUrl`, `webhookSecretEncrypted`) per §7's recommendation; gate the new routes on `tenant.worksIntegration?.enabled`.
4. **Live call state / screen-pop**: build the one genuinely missing primitive — an **outbound webhook dispatcher** (new `WebhookSubscription`-equivalent + `deliverWebhook` job in `apps/worker`, HMAC-signed body using `urlSigningSecret.ts`) that taps the same in-memory event stream `TelephonySocketServer` already broadcasts (subscribe internally the way the portal's WebSocket does, but re-emit as signed HTTP POSTs to Works's registered URL) instead of asking Works to hold a raw WebSocket open.
5. **Click-to-call**: expose a new authenticated HTTP wrapper around the already-implemented-but-unused `AriActions.originate` (§3) — `POST /integrations/works/v1/calls/originate` in `apps/telephony` (or proxied through api), reusing the existing ARI client rather than inventing new PBX-call logic.
6. **Call history / voicemail / SMS send / message history**: reuse `GET /calls/history`, `GET /voice/voicemail`, `POST /chat/threads(+/messages)` verbatim under the new auth wrapper rather than rebuilding them — they are already tenant-scoped and feature-complete for Works's stated needs (transcription and RCS remain gaps to flag separately, not blockers).

**Six files that would change / be added** (illustrative, not exhaustive):
1. `apps/api/src/integrations/works/routes.ts` (new) — the `/integrations/works/v1/*` surface.
2. `apps/api/src/integrations/works/auth.ts` (new) — per-tenant HMAC verification, modeled on `internalSecret.ts` + `urlSigningSecret.ts`.
3. `packages/db/prisma/schema.prisma` — add `WorksIntegration` model + `Tenant.worksIntegration` relation, and (if outbound webhooks are made generic rather than Works-specific) a `WebhookSubscription`/`WebhookDelivery` model pair.
4. `apps/worker/src/webhookDispatch.ts` (new) — outbound signed-webhook delivery worker, sibling to `messagingDispatch.ts`.
5. `apps/telephony/src/routes/telephony.ts` — add an authenticated `originate` HTTP route wrapping the existing `AriActions.originate`.
6. `apps/api/src/jwtPublicRouteBypass.ts` — add the new `/integrations/works/*` prefix (its own in-handler auth, same pattern as every other `/internal/*`/webhook door) so the global JWT hook doesn't 401 it before the handler runs — the exact footgun called out at line 15 of that file.
