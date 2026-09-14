# ⛔⛔ AGENT HANDOFF — a shared secret could mint a platform-wide SUPER_ADMIN token from the public internet; the route is DELETED (2026-08-18) — READ FIRST before adding ANY route that hands back a credential, before putting a path on the JWT bypass list, and before leaving anything marked TEMPORARY in this codebase

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(one api commit on `feat/ivr-migration-takeover`. **api DEPLOYED and
container-verified.** No migration, no PBX write, no nginx change, **no env edit**,
no DNS change, no tenant row touched. Tests: `nodeEnvGates` 18/18,
`publicReadyJwtBypass` + `internalSecret` 21/21; api typecheck **75 errors, the
exact baseline**, none at an edited line.)

- ⛔⛔ **THE RULE THIS EARNED, and it is the one to carry forward: a shared secret
  may authenticate a MACHINE on a narrow door; it may NEVER be sufficient to mint
  an IDENTITY that outlives the request.** `POST /admin/dev/generate-observe-token`
  took a 48-character string and handed back a **SUPER_ADMIN JWT scoped to
  `tenantId "global"`, valid up to 120 minutes** — with **no user row behind it**
  (`sub: "dev-observe-token"`) and therefore **nothing in any audit trail naming a
  person**. Whoever held that one string held every tenant on the platform, and
  every action they took was unattributable. Compare `internalSecret.ts`, which is
  the correct shape: a secret proves *this request* came from a known machine and
  buys nothing beyond it.
- ⛔⛔ **IT WAS REACHABLE FROM THE PUBLIC INTERNET, AND THAT WAS PROVEN, NOT
  INFERRED.** It sat on the **JWT bypass list**, so it ran anonymously, and the
  2026-08-18 nginx deny covers **`/api/internal/` only** — this path is under
  `/api/admin/`, which nginx proxies straight through. A secret-less POST to
  `https://app.connectcomunications.com/api/admin/dev/generate-observe-token`
  answered **`404 {"error":"not_found"}` — the HANDLER's own refusal** — while a
  genuinely unrouted path answers **`{"error":"unauthorized"}`** from the JWT hook.
  ⛔ **That pair of responses is the general technique for proving a bypassed route
  is live without exercising it**: a handler-authored refusal and the framework's
  refusal look alike in the status line and differ in the body. Never conclude "the
  route isn't reachable" from a 404 alone.
- ⛔⛔ **AN EARLIER PASS CLOSED THE FAIL-OPEN BRANCH AND LEFT THE DOOR STANDING —
  that is the near-miss worth remembering.** The `if (NODE_ENV === "development")
  return true;` line was correctly removed hours earlier, which made the *secret*
  the only key and read as a fix. **It was not**: the finding was never the branch,
  it was that a secret could mint an admin. **When a route's gate is the bug,
  ask whether the route should exist at all before hardening its gate.**
- ✅ **DELETED OUTRIGHT — chosen over re-gating because it is PROVABLY unused, and
  the evidence was gathered BEFORE anything was removed.** **0** calls across
  **14 days of nginx access logs including all rotated `.gz`** on both hostnames;
  **no cron entry** (root crontab holds one unrelated `@reboot`); **no systemd
  timer**; and its only callers are ~20 one-off diagnostic scripts under `scripts/`
  from the March 2026 PBX↔Connect CDR investigation — **dated 2026-03-29/30 in the
  server clone**, ~4.5 months stale, invoked by nothing.
  ⛔ **The nginx log alone would NOT have settled it** — every one of those scripts
  posts to `127.0.0.1:3001`, which never touches nginx. **Check the schedulers and
  the callers' own age too**, or you are reading a log that structurally cannot
  contain the traffic you are looking for.
- **What was removed, in one api commit:** the route handler; its gate
  `canIssueDevObserveJwt`; the now-dead helper `constantTimeEqualStr` (its only
  caller); the `isDevObserveTokenPath` entry in **`jwtPublicRouteBypass.ts`** and
  its line in the bypass `if` chain; and the `DEV_OBSERVE_TOKEN_SECRET` stanza in
  `apps/api/.env.example`. Each removal site keeps a comment saying what stood
  there and why it must not return.
- ⏳ **LEFT FOR IZZY, DELIBERATELY: `DEV_OBSERVE_TOKEN_SECRET` is still on line 28
  of `/opt/connectcomms/env/.env.platform`.** ✅ **It is INERT — nothing in the
  codebase reads that name any more** (a guard test asserts that), so leaving it
  costs nothing and removing it is cosmetic. An env edit has no sanctioned deploy
  path of its own and belongs to him. ⛔ **Deleting the variable was never the fix
  and must not be mistaken for one** — an empty `DEV_OBSERVE_TOKEN_SECRET` already
  made the old gate refuse, so the exposure was always "someone holds the string",
  which only removing the route ends.
- ⛔ **The guard reads SOURCE, with comments STRIPPED, across BOTH files**
  (`nodeEnvGates.test.ts`). Stripping matters: the doc blocks recording this
  history contain the route name, and a naive `includes()` would pass on the
  comment and hide a reintroduced route. It asserts the route, the gate, **any
  reader of `DEV_OBSERVE_TOKEN_SECRET`**, and the bypass-list entry are all absent.
  ✅ **Proven non-vacuous: all 4 assertions fail when replayed against the
  pre-change blobs from `HEAD`.**
- ✅ **SIBLING SCAN DONE — no second route of this shape exists.** Swept
  `apps/api/src` for `TEMPORARY` / `TODO: remove` / `dev only` / dev-debug route
  paths / every `jwtSign` and `jwt.sign` call site. The great majority of
  `TEMPORARY` hits are the porting code's **"temporary number"** and are unrelated.
  Every other token minter is legitimate and was checked individually: `/auth/login`,
  the invite path and `/auth/mobile-qr-exchange` mint a session **for the
  authenticated user**; `didSwitchSchedule.ts:117` and
  `registerAgentGrantRoutes`'s `injectAsService` sign a **2-minute** token whose
  identity is **read from the `User` table** and drive the real route in-process via
  `app.inject`, carrying no more authority than that person already had.
  ⛔ **That in-process service-principal pattern is the sanctioned replacement** if a
  script ever needs admin authority again — never a route that hands a token to a
  caller. `/admin/apps/voip-ms/debug-dids` is *not* a sibling: it is JWT-gated like
  any admin route and is not on the bypass list.
- ⛔ **`/admin/dev/…` is NOT protected by the `/api/internal/` nginx deny, and
  neither is anything else outside that prefix.** Two independent things kept
  `/internal/*` shut on 2026-08-18 — nginx *and* the fail-closed secret. This route
  had neither. **A new bypassed route inherits no protection from either.**
- ⏳ **NOT PROVEN: nobody has exercised the surrounding admin surface by hand since
  the deploy.** Proven as a boot-healthy container carrying the change, the route
  answering as unrouted from outside, health/login/`/internal/*` all behaving, plus
  the tests above — not by a human clicking through the admin screens.
