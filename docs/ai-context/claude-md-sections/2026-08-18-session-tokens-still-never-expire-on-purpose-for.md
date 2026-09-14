# ⛔⛔ AGENT HANDOFF — session tokens still never expire, ON PURPOSE for now: adding `expiresIn` today would BAN customers' offices, not sign them out (2026-08-18) — READ FIRST before adding `expiresIn`, before adding ANY per-request user re-check to the JWT hook, before "just rejecting DISABLED users' tokens", or before assuming a client survives a 401

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full detail: **`docs/ai-context/AGENT_HANDOFF_SECURITY_AUDIT_2026-08-16.md` §8**
(§8.1–8.6 read-only investigation; **§8.7 = step 1 BUILT and DEPLOYED, 2026-08-18,
portal only.**) Memory: [[token-expiry-blocked-on-client-401-handling]].

- ✅✅ **STEP 1 IS DONE (`93fb96d1`, portal DEPLOYED and container-verified
  2026-08-18): THE PORTAL / DESKTOP APP NOW SURVIVES A 401.** One rule, one
  file — `apps/portal/lib/sessionExpiry.ts`, wired into `services/apiClient.ts`:
  a `401 { error: "unauthorized" }` on a request that CARRIED a bearer token
  = session dead → clear the stored session → dispatch `cc-session-expired` →
  in a full window on an authenticated path, `window.location.replace(
  "/login?next=<path+search>")`. **Once per dead token** (twenty concurrent
  401s from twenty pollers = one clear, one hop). Then every request that
  would carry the dead token or no token on an authenticated path is **refused
  locally before it is sent** — that is what makes every background poller
  stop on the first 401 without editing each one; they tick for a few hundred
  ms into a local throw, then the hard navigation / `AuthGate` unmounts them.
  ⛔ **"Session dead" is told from "no permission" by the BODY, read from the
  api, not guessed:** the JWT hook answers `401 unauthorized`; every permission
  gate answers **`403 forbidden`**; `invalid_credentials` / `bad_signature` /
  `missing secret` are excluded. **Opening a screen you lack permission for
  does NOT sign you out**, and a test reads `server.ts`'s source to pin that
  contract — change the api's 401 body and `sessionExpiry.test.ts` goes red.
  ⛔ **Public pages are never redirected** (`/login`, `/p/`, `/pay/`, `/auth/`,
  `/onboarding/`, `/track/`, `/forms/`, `/privacy` — token cleared, nothing
  else) and **desktop passive windows are never redirected** (`/desktop/*`:
  `AuthGate` shows "Signed out — sign in again from the main Connect window"
  and comes back by itself on the next sign-in via the cross-window `storage`
  event). ⛔ **Pollers mounted OUTSIDE `AuthGate`** (from `app/providers.tsx`,
  so they live on `/login` too) got their own `hasBrowserAuthToken()` gate:
  `DesktopNotificationsBridge` (30 s), `RemoteSupportConsent` (5 s), the
  `useSipPhone` extra-accounts fetch. **The telephony WS** never opens without
  a token now, and on `1008 Unauthorized` asks `/me` once before deciding
  (its server also 1008s on its own DB hiccups); a sign-in event brings the
  feed back without a reload. Tests: 23, registered; **all four source guards
  fail against the pre-change files.** Typecheck 0; suite 156/158 (the two
  pre-existing). ⏳ **NOT PROVEN END TO END — nothing expires today and no
  real credentials were used, so nobody has watched a stale session get sent
  to `/login`.** Human acceptance recipe (3 min, DevTools → overwrite the
  three token keys with garbage) is in §8.7, and the negative that matters:
  **no further `/api/*` requests after the hop, and a 403 does not sign you
  out.** ⏳ Steps 2 (mobile) and 3 (server) are UNCHANGED — do not add
  `expiresIn` yet.
- ⛔⛔ **THE FINDING THAT STOPPED THE WORK: neither client handled a 401.** The
  mobile app STILL has **zero** 401 handling — `apps/mobile/src/api/client.ts` throws
  a slug on `!res.ok`, `AuthContext.tsx` never clears `cc_mobile_token`, and
  nothing shows the login screen; the phone keeps registering off its cached
  SIP bundle, then goes **relay-dead within 24 h** (TURN refresh needs the
  token — the 2026-07-29 `iceHasTurn:false` failure, self-inflicted), drops out
  of every `lastSeenAt` filter, and every screen errors — **with the user never
  told to sign in.** The portal/desktop **had** no global 401 handler either
  (fixed above): `AuthGate` only checked a token STRING existed, `/me` failure
  fell back to cached permissions, and the shell kept polling with the dead token.
- ⛔⛔ **AND A DEAD PORTAL TOKEN IS A 401 STREAM ON THE CUSTOMER'S OFFICE IP.**
  Mini-dialer 30 s, notifications bridge 30 s, panel 60 s, chat 7 s, SIP init
  backing off to 60 s, telephony WS reconnecting on every `1008`. `monitor.sh`
  bans at **>30 × 401 / 5 min**. Two parked desktop apps behind one office IP
  clear it. **So expiry would present as the 2026-08-17 blank-app incident —
  the whole office 403 on everything, and reopening cannot help.** Setting
  `expiresIn` is one line; its blast radius is every customer.
- ⛔ **"Just reject DISABLED users per request" is NOT the safe half** — same
  failure mode: the disabled person's parked desktop app becomes the 401 stream
  on the shared IP. Today a disabled user's token keeps working on every route
  (verified: the preHandler at `server.ts:6056` never touches the `User` row;
  `DISABLED` is checked only at login and invite-accept) — bad, but it bans
  nobody. **Client 401 handling must land first, regardless.**
- ⛔ **Three service principals mint tokens whose `sub` is NOT a `User.id`:**
  `scheduler:<id>` (`didSwitchSchedule.ts:117`, 2 m), `agent-voicemail` and
  `agent-vm-email` (agent image, 300 s, hand-rolled HS256, ⛔ manual rebuild to
  change). A per-request "user must exist and be ACTIVE" check that rejects an
  unknown `sub` **silently kills the DID switch scheduler, the drift
  reconciler, voicemail transcription and voicemail email.** The rule that fits
  what they already emit: no `User` row + short-lived (`exp − iat ≤ 15 min`) =
  service principal; no `User` row + long-lived or `exp`-less = reject.
- **Every mint site, so nobody re-derives it:** `/auth/login` `server.ts:5817`,
  `/auth/mobile-qr-exchange` `:6006`, `/auth/signup` `:5743` — all **no
  `expiresIn`**; `GET /me` `:6125` re-signs **only when the DB role differs**
  (the one existing "refresh", portal-only — the app persists it via
  `writeAuthToken`; mobile never calls `/me`); the 2-minute `injectAsService`
  tokens (`server.ts:41082`, `didSwitchSchedule.ts:117`) are fine and must stay.
  The 401 body is `{ "error": "unauthorized" }` for missing / bad / expired
  alike. Telephony WS, realtime and the agent verify with `jsonwebtoken`, which
  already enforces `exp` — the rejection half needs no api change, which is
  exactly why the flip is dangerous.
- ✅ **THE ORDER THAT IS SAFE (§8.6 of the doc), each step deployable alone:**
  (1) portal — global 401 → clear session → `/login?next=`, and every poller
  STOPS on the first 401 (portal-only deploy); (2) mobile — 401 → clear token →
  login screen, plus a sliding refresh so a phone in daily use never reaches the
  wall (**APK + TestFlight — Izzy's call**); (3) only then the server —
  `expiresIn` 30 d on the three user mint sites, a `sessionsInvalidatedAt`
  column + migration, a short-TTL cache (`permissionCache.ts` pattern) in front
  of the per-request check, the service-principal rule, and a grandfather
  window for `exp`-less legacy tokens (rejecting them on day one signs out
  every phone); (4) exempt `/api/auth/login` + `/api/me` 401s from the nginx
  ban counter so a client trying to recover cannot ban itself.
- ⏳ **Finding B itself is NOT fixed** — tokens still never expire. Step 1
  (portal) is done and deployed; the server work is unblocked only once step 2
  (mobile) is on every phone that matters.
