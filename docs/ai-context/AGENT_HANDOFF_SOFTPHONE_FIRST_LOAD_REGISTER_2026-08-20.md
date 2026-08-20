# AGENT HANDOFF — "I have to reload a few times for it to register" (2026-08-20)

**Commits `a70dc721` (budget starvation) + `b409bfc8` (sign-in wake-up) on
`feat/ivr-migration-takeover` — portal-only.** Nothing touching the api, call
routing, the PBX, or any rate limit. Deploy state is at the bottom of this doc.

⛔⛔ **THE PRIMARY MECHANISM WAS FOUND SECOND (§3c, `b409bfc8`): the login page
signs in via `router.replace` — a CLIENT-SIDE navigation with NO page reload —
so the SIP provider that mounted on the signed-out login screen never
remounted, and its `init()` bail-out (`if (!hasBrowserAuthToken()) return`)
was final.** After every ordinary sign-in the phone engine simply was not
running: proven live at 03:52 CEST when Izzy's real sign-in loaded the entire
dashboard while the engine made ZERO credential fetches and opened no
telephony WS. The `window.location.assign` in the login page is only a 400 ms
fallback for embedded browsers — do not read it as "login reloads the page."
The first reload after sign-in was therefore GUARANTEED; the budget starvation
below is why one reload often wasn't enough.

Read this before diagnosing any "the softphone doesn't register until I
reload", before touching the init retry ladders in
`apps/portal/hooks/useSipPhone.ts`, and before raising either credential
endpoint's rate limit (⛔ still forbidden — the 2026-08-10 handoff's rule
stands).

---

## 1. The report

Izzy, 2026-08-19 evening: *"When I log into the online web app, especially the
Windows app, maybe the browser as well, I have to reload it a few times for it
to register. It should register the second time. It loads the first time, so it
shouldn't have to reload multiple times."*

"Register" = the softphone's SIP registration (the dialer's green
"Registered"). The page itself loads fine — it is the phone engine that stays
on "Not registered".

## 2. What the wire showed (nginx + api logs, 2026-08-19/20)

The whole episode is in `/var/log/nginx/access.log` around
`20/Aug/2026:03:04–03:14 +0200`, IP `50.48.58.53`, UA `@connect/desktop/0.1.6`:

- A parked window signed in as the **SUPER_ADMIN account** sat in a **fixed
  60-second retry loop** against `GET /api/voice/me/extension`, answered
  **`400 {"error":"PBX_NOT_LINKED"}` every time, for over an hour**
  (02:05→03:05 continuous). The admin tenant `connect-admin-tenant-v1`
  ("Connect Communications") has **no `TenantPbxLink` and the SUPER_ADMIN user
  has no extension row** — that account structurally cannot register, ever.
- 03:04:09: a full `/dashboard` load by the **Landau Home** window
  (izzwgg@gmail.com, USER, PBX T21) → extension fetch **200** + credential
  fetch **200** two seconds later → registered first try. **A healthy account
  with budget registers on the first load.**
- 03:05:53: Izzy logged into the SUPER_ADMIN account (landed on the new MFA
  setup page). From then on **two** windows carried that account: one drew
  `400 PBX_NOT_LINKED` every ~60 s, the other drew **`429 RATE_LIMITED`**
  every ~60 s — the two loops together are 120 requests/hour against the
  endpoint's **60/hour per-user budget** (`ext-fetch:<user.sub>`,
  `server.ts:10846`), so the budget stays permanently empty.
- Fleet-wide on 2026-08-19: **1,467 × 400, 215 × 429** on
  `/voice/me/extension` (vs 1,441 × 200). A real customer —
  yisraelweinstock@gmail.com, Gesheft ext 101, account fully provisioned —
  drew **~24 429s in six minutes** at 22:26 UTC from ~3 parallel window loops.
  Gesheft runs several desktop installs on one login, and the budget is keyed
  **per user**, so their installs starve each other.
- The 26 × 500 on the same endpoint were a 3-minute cluster (20:53–20:56 CEST)
  across three IPs during the evening's api deploy cutover — the known
  blue/green transient, not part of this defect.

## 3. Root cause — two faults, one experience

**(a) THE CLIENT: a setup-class failure retried like a transient one.**
`useSipPhone.ts`'s init ladder capped at a **fixed 60 s** for every failure —
including `PBX_NOT_LINKED`, `EXTENSION_NOT_ASSIGNED`,
`EXTENSION_NOT_PROVISIONED`, `FORBIDDEN`, WebRTC-config gaps and a missing SIP
password, none of which the client can ever fix. One such loop = 60
requests/hour = **the entire per-user budget**. Every additional signed-in
window doubles it. Once saturated, a **fresh page load on an account that
COULD register draws 429 on its first fetch**, the client backs off 60 s, and
the human reloads — sometimes winning a freed slot, sometimes not. That
lottery IS "I have to reload a few times."

**(c) THE ENGINE NEVER STARTED AFTER A SIGN-IN (`b409bfc8`).** See the box at
the top. Fixed with an `authTokenPresent` state in `useLocalSipPhone`: a
`storage` listener (cross-window sign-ins) plus a 2 s localStorage poll
(same-window — `storage` never fires for a window's own writes), zero network
while signed out. It keys the engine effect (`[reinitSeq, authTokenPresent]`)
AND the outbound-routes and extra-accounts effects (`[authTokenPresent]`),
which had the same signed-out bail-out and the same never-retry. Token
cleared → the same dependency tears the UA down, which is the correct
sign-out behavior. Three additional source guards pin all of it.

**(b) THE ACCOUNT: Izzy's SUPER_ADMIN login has no phone to register.**
izzywgg@gmail.com lives in the synthetic admin tenant, which has no PBX link
and no extension. On that login **no number of reloads can ever produce
"Registered"**. His phone identity is the separate Landau Home login
(izzwgg@gmail.com → T21 ext 101). ⛔ Nothing in code fixes (b) — it is a
product/config decision (link + assign an extension, or accept that the admin
login has no softphone). NOT done; Izzy's call.

## 4. The fix (`a70dc721`, all in `useSipPhone.ts`)

1. **A second, slow retry ladder for setup-class failures**: starts at 60 s,
   doubles to a **15-minute cap**. Setup-class = ApiError 400/403/404 from
   either credential endpoint, the post-fetch config gaps
   (WEBRTC_DISABLED / missing wsUrl / domain / username), and
   SIP_CREDENTIAL_NOT_SET. An admin fixing the setting still revives the
   phone within ≤15 min with nobody reloading anything.
2. **Transient failures unchanged**: network errors and the 401 token race
   keep the fast 5 s × 1.8 ladder; 429 keeps its 60 s floor.
3. **±15 % jitter on every retry** so several windows of one login don't march
   in lockstep against the shared budget.
4. Both ladders reset when a credential fetch fully succeeds.

Effect: a signed-in window on a can't-register account costs ~4–5
requests/hour after a few minutes instead of 60, so the budget is free and the
first load of a healthy window gets its fetch answered immediately.

⛔ **What was deliberately NOT done:** raising either rate limit
(`ext-fetch` 60/h, `sip-provision` 30/h — the safety net that caught the
2026-08-10 storm stays); moving the server's rate-limit check after the
cheap PBX_NOT_LINKED lookup (inverts the limiter's purpose); restructuring the
desktop multi-window engine architecture; and linking the admin tenant.

## 5. Tests

`apps/portal/lib/sipInitBackoff.test.ts` — 6 source guards (slow ladder + cap,
the 400/403/404 classifier, every setup-shaped failure path on the slow lane,
no fixed-60s re-arm, jitter, ladder reset). **Registered in the portal `test`
script in the same commit** (the file-list trap). CRLF-normalised read.
✅ **Replayed against `HEAD`'s pre-change file: all guards fail** — proven
non-vacuous. Portal typecheck **0 errors**; suite **195/197** (the two
documented pre-existing failures: `webrtcSdpDiagnostics`,
`campaignsIndexLayout`).

## 6. How to read this in the field

- The one-grep diagnostic:
  `grep "voice/me/extension" /var/log/nginx/access.log | awk '{print $9}' | sort | uniq -c`.
  Healthy = overwhelmingly 200 with roughly one fetch per sign-in. A steady
  drumbeat of 400s at 60 s intervals = a parked window on a can't-register
  account (pre-fix bundle, or a setup problem worth fixing); 429s = budget
  starvation. The api names the starved user:
  `docker logs app-api-1 | grep rate_limit_ext_fetch`.
- ⛔ **An already-open desktop window keeps the OLD bundle until the app is
  fully closed and reopened.** The old 60 s loops keep running until every
  install restarts — expect residual 400/429 noise from parked windows for
  days; judge the fix by windows opened after the deploy.
- ⛔ A 400 loop that keeps ticking on the NEW bundle at 60 s cadence past the
  first few retries means a path missed the classifier — that is what the
  source guards pin.

## 7. ⏳ NOT PROVEN / still open

- **Nobody has signed in and watched the dialer register on the first load**
  since the deploy. Acceptance (2 min, Izzy): fully close and reopen the
  Windows app, sign in on the **Landau Home** account → the dialer must read
  Registered on the FIRST load, no reload. Then re-run the grep in §6 —
  429s should go to ~zero for windows on the new bundle.
- **The SUPER_ADMIN login still cannot register and never could** — that is
  §3(b), needs Izzy's decision, and no amount of reloading changes it. The
  dialer on that login now says why ("PBX_NOT_LINKED …") instead of
  thrashing.
- Whether Gesheft's multi-install office still sees first-load 429s once
  their installs restart onto the new bundle — re-run the §6 grep filtered to
  their IPs after a business day.
