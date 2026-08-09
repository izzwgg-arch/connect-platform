# AGENT HANDOFF — "everything in Connect is loading very, very slow" (2026-08-06)

**Status: THREE fixes DEPLOYED and verified. One shipped but NOT reproduced.**
Commits on `feat/ivr-migration-takeover`: `abb1314a` (permission cache),
`4ad257f7` (triple tenant fetch + PBX single-flight), `5486746a` (IVR Studio
deferred ring groups + CSS transition scoping), plus a live nginx config change.

Read this before investigating ANY "the portal is slow" report, before adding a
permission check to a route, and before assuming a big server cannot be the
problem or that it can.

**Headline numbers, all measured in Izzy's own browser:**

| | Before | After |
|---|---|---|
| Dashboard, last API call lands | **22.1 s** | **~2–4 s** |
| Browser queue wait, average | 1,120 ms | **5 ms** |
| Requests waiting >1 s to be sent | 14 of 26 | **0** |
| api server time, avg over ~5,700 requests | 499 ms | **225 ms** |
| Permission table scans/sec (5 tables) | 55.1 | **4.5** |
| IVR Studio, last API call lands | 5.15 s | **3.41 s** |
| IVR Studio, page usable | 5.6 s | **2.8 s** |

---

## 1. ⛔ THE RULE: the box was never the bottleneck, and it was never one thing

Izzy pushed back mid-investigation: *"My server has 18 cores and 90 GB of RAM…
we are not even at half capacity. It should not be slow."* **He was right, and
that pushback is what found the real bug.** Throughout the incident the server
was **79% idle**, with 72 GB free, disk at 64%, and an uplink running at
**~0.5 Mbit/s**. On-box responses were **5–20 ms**. No amount of hardware would
have changed anything.

Four independent things stacked up. Each was individually survivable; together
they made a 22-second dashboard:

1. **HTTP/2 was never enabled** → the browser could only send 6 requests at a
   time (§3).
2. **Every request re-read the entire permission system** → ~500 ms of server
   time per request (§4).
3. **The dashboard fires 26 API calls**, several of them literal duplicates
   (§5).
4. **The server is in Lauterbourg, France; Izzy is in New York** → ~100–200 ms
   of travel on every single request, which multiplies everything above.

⛔ **Do not stop at the first cause.** Fixing HTTP/2 alone took 22.1 s → 2.1 s
and would have looked like a complete win, while the api was still burning half
a second of pointless database work on every request.

## 2. The card charge that "timed out" — exact cause

`POST /api/admin/billing/invoices/cmshq8a6f02xvmx13lgnq5vjq/pay` at **18:25:27**
from Izzy's IP returned **499** (nginx's code for *the client gave up waiting*).

An **api deploy started at 18:16 was still cutting over** at that moment
(`candidate_readiness=57737ms`, `stable_recreate=111641ms`). His payment hit the
api mid-restart.

⛔ **A paid customer action taken during an api deploy can simply die — the
blue/green cutover is not seamless for in-flight POSTs.** It was never Cardknox:
there were zero payment-gateway errors in the api logs. (A separate charge that
morning at 07:40:33 returned a genuine **402** decline — a real decline, not this.)

**44 deploys ran that day** vs 12 the day before (`ls /var/log/connect-deploys/`),
several sessions deploying the same box concurrently. That churn also produced
502 bursts — **189 at 09:39, 151 at 07:28, 147 at 07:35** — and drove nginx 499s
from ~5/hour to **124/hour from 14:00 on**.

## 3. HTTP/2 — nginx had it compiled in and never turned it on

`nginx -V` shows `--with-http_v2_module`, but there was **no `http2` directive
anywhere in `/etc/nginx/`**. Measured in Chrome: **51 of 51 requests came back
`nextHopProtocol: "http/1.1"`**. Chrome therefore capped at 6 connections per
host while the dashboard fired 26 API calls, so requests sat queued *before
being sent* — average 1,120 ms, max 2,419 ms, and the last call landed **22.1 s**
in. Server TTFB was only 245–1,000 ms. **The wait, not the work.**

**Applied live** (Izzy's explicit go-ahead), in the ACTIVE file
`/etc/nginx/sites-enabled/connectcomms` — note that is a **real file, not a
symlink**, and it holds the **only** server block listening on 443:

```
listen [::]:443 ssl http2 ipv6only=on;   # was: listen [::]:443 ssl ipv6only=on;
listen 443 ssl http2;                    # was: listen 443 ssl;
```

- Backup: `/root/nginx-connectcomms-backup-20260806-http2.conf`
- ⛔ nginx here is **1.24**, which takes `http2` as a **`listen` parameter**. The
  standalone `http2 on;` directive only exists from 1.25.1 — don't "modernise" it.
- Verified: ALPN negotiates `h2`, and `curl --http2` returns `HTTP/2 200`.
- ⛔ **WebSockets are FINE.** nginx has no RFC 8441 Extended CONNECT, so Chrome
  automatically opens a separate HTTP/1.1 connection for `/ws/telephony`. The
  101 upgrades kept flowing throughout, and the `http/1.1` entries still in the
  protocol mix afterwards are exactly those. Verify this after any TLS change —
  the live-call feed rides it.

## 4. ⛔ Every request re-read the whole permission system

This is the one Izzy's pushback uncovered. The api logs its own `responseTime`,
and over 45 minutes it averaged **499 ms of pure server work across 5,777
requests** (max 8.5 s) — network not involved:

| route | avg | p95 | max |
|---|---|---|---|
| `/calls/history` | 1245 ms | 3023 | 5512 |
| `/dashboard/communications` | 1217 ms | 3980 | 6605 |
| `/chat/threads` | 770 ms | 2028 | 4577 |
| `/dashboard/call-kpis` | 669 ms | 1712 | 2784 |
| `/voice/voicemail` | 553 ms | 1615 | 3782 |
| `/chat/unread-count` | **411 ms** | 1092 | 4473 |

411 ms to return a single number. A live 30-second sample of
`pg_stat_database` showed **276 transactions/sec but 184,000 rows returned/sec —
about 667 rows per request.** The per-second sequential-scan leaders were all
permission tables, none index-served.

**Cause:** `hasEffectivePortalPermission()` re-ran the FULL resolver on every
call — **five queries**: the role snapshot, the user's custom-role assignments
**twice**, CRM tenant settings, CRM user access. The double fetch was because
`getEffectiveCustomRolePermissions` takes a `tenantId` it deliberately ignores,
so the two call sites issued the identical query. Routes ask about several
permissions each (voicemail asks four) and one dashboard load fires 26 requests.

⛔ **It was NOT missing indexes.** `ConnectCdr`, `Extension`, `ContactPhone` and
`ConnectChatMessage` are all sensibly indexed; Postgres correctly prefers a seq
scan on tables this small. The bug was **query volume**, not query plans. Don't
go index-hunting here.

**Fix — `apps/api/src/permissionCache.ts`** (`abb1314a`): resolved permission
sets behind a short-TTL bounded cache, and the duplicate fetch removed.
**4 queries cold (was 5), 0 while warm.**

| table | scans/s before | after |
|---|---|---|
| `UserCustomRole` | 18.3 | **1.1** |
| `PlatformRolePermissionSnapshot` | 11.7 | **0.1** |
| `CustomRole` | 9.7 | **0.8** |
| `CrmTenantSettings` | 8.3 | **1.7** |
| `CrmUserAccess` | 7.1 | **0.8** |

⛔ **This is an AUTHORIZATION cache. Three rules keep it honest:**
1. **The TTL — not the invalidation — is what bounds staleness.** The api runs
   blue/green (`app-api-1` + `app-api-candidate-1`), so a write served by one
   process **cannot** clear the other's map. Never raise the TTL without
   accounting for that.
2. **A failed resolve (`null`) is never cached** — a database blip must not pin
   a user to fallback permissions for the whole TTL.
3. **Every permission WRITE path calls `invalidateAllPortalPermissions()`** —
   `customRoleRoutes` (create/update/delete/duplicate/assign),
   `admin/userCrmAccessRoutes` (both), `crm/routes` settings, and the
   `POST /admin/role-permissions` snapshot write. **Any new one must too.**

Escape hatch: `PORTAL_PERMISSION_CACHE_TTL_MS=0` disables it entirely.

**Known gap, deliberate and TTL-covered:** `crm/checklistRoutes`,
`crm/scriptRoutes` and `crm/quickDispositionRoutes` each upsert
`crmTenantSettings` with `enabled: true` in their CREATE branch, so writing a
tenant's very first script/checklist/disposition can flip CRM on without calling
an invalidator. Once per tenant; the TTL heals it.

Guarded by `permissionCache.test.ts` (keying, no cached failures, per-user
invalidation, expiry, bounding) and `portalPermissionQueryCount.test.ts`, which
asserts query counts through the **real** resolver — 30 warm resolves, zero
queries.

## 5. The IVR Studio

**5.15 s, 30 API calls.** Two separate problems.

### 5a. The tenant list was fetched three times (`4ad257f7`)

`/admin/tenants` and `/admin/pbx/tenants` each fired **three times** per load —
at 1019 ms, 1043 ms and 2003 ms, at ~760 ms of server time each.

⛔ **It was an effect-dependency bug, not a fetch bug.** The tenant-options
effect in `hooks/useAppContext.tsx` depended on `reloadTenantOptions`, a
`useCallback` rebuilt from `canPermission`, which is itself rebuilt whenever
`role`, `backendJwtRole` or the permission override settle — and during boot
those settle **separately**. Every settle re-ran the effect and refetched.

It now depends on the **boolean** `canSwitchTenants` and calls the stable module
import directly. Both endpoints are **1× each** after, verified in-browser.
`loadTenantOptions` also gained in-flight sharing as a backstop — deliberately
**not** a timed cache, because a just-created tenant must appear at once.

### 5b. The whole screen waited on the slowest PBX read (`5486746a`)

`/voice/pbx/ring-groups` is a live Ombutel MySQL read: **1.8 s avg, 2.2 s max
server-side, 2.8 s observed cold.** It sat inside the opening `Promise.all`, so
every part of the Studio waited on it — and `/voice/ivr/route-profiles/options`
waited on *that*.

Nothing above the fold needs it: it feeds the Teams card and the "A team" choice
in the key editor. It now loads **after first paint**, without `await`. Verified:
the blocking batch ends at **2,834 ms** and ring groups then runs
2,835 → 5,612 ms. **The page is usable ~2.8 s sooner.**

Queues moved with it, because the two are merged into one `teams` list —
deferring only ring groups would flash a wrong team count. The
both-sources-must-be-read rule (Landau Home has zero ring groups, one queue, and
`/voice/pbx/resources/queues` 404s for them) is preserved exactly, relocated.

⛔ **Teams arriving late needed a THIRD state, `teamsLoading`** — it must not be
folded into `teamsLoaded`. The existing copy for `!teamsLoaded` tells the
customer *"Couldn't load this customer's teams — check they're linked to the
phone system"*, which is a **lie** while the request is still in flight and sends
someone off to check a PBX link that is fine. Both surfaces now say "loading"
instead. This preserves the rule the key editor already documents: never let a
choice vanish or misexplain itself.

**Also fixed: `pbxReadCache` now single-flights.** It is defined inline in
`server.ts` (there is no `pbxReadCache.ts` — grep, don't guess) with a 20 s TTL,
and it previously only ever helped the **second** page load: concurrent misses
each opened their own MySQL connection to the PBX. Freshness is unchanged —
joining an in-flight load is never staler than starting another.

## 6. ⚠️ The scroll jank — fix shipped, NOT reproduced

Izzy reported the Studio "scrolling pretty lazily". A real defect was found and
fixed: six rules declared `transition:.14s`, which is shorthand for
**`transition: all`**, so the browser watched every animatable property — layout
ones included — on every `.btn/.stepcard/.choice/.target/.digitbtn/.recrow`.
Scrolling sweeps the pointer across those rows and fires hover transitions on all
of them. Every hover and state rule on those elements only ever changes
`border-color`, `color`, `background`, `opacity` or `filter`, so the transition
now names exactly those and layout is never animated.

⛔ **This was never confirmed to be the reported symptom.** The tenant selected
in Izzy's browser (**Create A Box**) has **no phone menus**, so the Studio renders
its empty state with `scrollHeight === viewport` and **nothing to scroll**.
Re-test on a tenant that has menus.

**Next suspects if it persists** (both need measuring, not assuming):
- the global `.btn` rule in `apps/portal/app/globals.css` transitions
  **`transform, box-shadow`** — both repaint-heavy, and global to every page;
- `.ivrs .sticky` is `position:sticky` sitting inside cards that carry
  `box-shadow`.

## 7. Method — how to measure this, and the traps

**Measure in the browser, not from the server.** The decisive numbers all came
from `performance.getEntriesByType('resource')` in Izzy's actual Chrome:
`requestStart - startTime` is **queue wait** (browser-side stall) and
`responseStart - requestStart` is **TTFB** (travel + server). Separating those
two is what distinguished "HTTP/1.1 queueing" from "slow server", and both were
real. `nextHopProtocol` is how you prove h2 vs http/1.1.

**Server-side per-route timing** — the api logs `responseTime` but the URL is on
the *matching* `req` line, so join on `reqId`:

```
docker logs --since 45m app-api-1 | python3 -c "…join o['reqId'] → req.url, then responseTime…"
```

**Live DB pressure, not lifetime totals** — sample `pg_stat_user_tables` and
`pg_stat_database` **twice 30 s apart** and diff. Lifetime counters are
meaningless here (`ConnectCdr` shows 1.8 M seq scans reading **400 GB** from an
86 MB table; `Extension` shows **5,042,055** scans on a **175-row** table). The
delta is what tells you what is happening now.

⛔ **Traps that each produced a wrong answer first:**
- **`pg_stat_statements` does not exist** on this database. Don't build a plan
  around it.
- **Never blame the customer's internet without a reference host.** Izzy's line
  was fine — ping to `1.1.1.1` was a steady **10–15 ms** while the same ping to
  loopcom ran **96–830 ms**. Traceroute showed hops 1–9 healthy (3–23 ms) and the
  jump at the transatlantic hop. His egress was stable; no dual-WAN flap.
- **`runningCount: 0` from the deploy queue does NOT mean you can deploy.**
  Direct deploys (`deploy-direct.sh`) never register in the queue, and the
  **heavy-job lock** is separate — a deploy will fail with
  `HEAVY JOB ALREADY RUNNING` while the queue reads idle. Check
  `pgrep -f run-heavy` as well.
- **`nohup … &` over ssh dies when the tool call's ssh session is torn down.**
  Use `setsid nohup … < /dev/null & disown`, then poll the log on a later
  connection. One deploy was silently lost to this and had to be re-run.
- **The load average lies about saturation.** It sat at 7–12 all day (vs 4.77 the
  day before) while the CPU was ~79% idle — that was deploy churn and I/O wait,
  not request load. Request volume was **flat at ~25k/hr all day**.

## 8. Shared-tree and deploy notes specific to this engagement

- ⛔ **A commit here can land on top of another session's work and become
  undeployable alone.** `abb1314a`'s parent turned out to be `9f181e39`
  (another session's permission-grant-by-chat feature), so deploying the
  permission cache **necessarily shipped that feature too**. That was surfaced
  to Izzy rather than hidden. Always run `git log --oneline <live>..<yours>`
  before deploying and say what rides along.
- **The api deploy for `abb1314a` was never run by this session** — a parallel
  session was already building the exact same commit, so the right move was to
  let it finish and verify, not start a competing build.
- `apps/portal/tsconfig.tsbuildinfo` is **tracked** and dirtied by `tsc` —
  `git checkout --` it before committing.
- **Stage explicit paths, never `git add -A`.** Several sessions were editing
  this tree concurrently the whole time; `agentGrantRoutes.ts` was mid-edit and
  syntactically invalid at one point, which masked every other typecheck error
  in `apps/api` until it was excluded.
- ⛔ Blocked-reason strings in the IVR Studio key editor are rendered **raw**,
  not through `t()`. The new "Still loading…" string follows that existing
  convention, so it is untranslated **like all its neighbours**. If Yiddish
  coverage matters there, that is a pre-existing gap across all of them, not
  something this change introduced.

## 9. Still open

1. **Re-test the Studio scroll on a tenant that has menus** (§6). Unverified.
2. **`/voice/pbx/ring-groups` is still 1.8 s** — it is off the critical path now,
   but still slow. Options: defer to when the destination picker is opened, or
   stale-while-revalidate (which would show a just-created team one load late — a
   real behaviour change, ask first).
3. **`/voice/pbx/resources/extensions` still fires 3×** on the Studio, from three
   genuinely different components (ivr-studio page, `MiniTeam`, `pbxData`).
   Needs a shared cache, not a one-liner.
4. **The server is in France.** ~100–200 ms per request is paid on every single
   call, forever, and nothing in the code recovers it. Moving it is the only fix.
5. **A deploy-queue process has burned ~97% of one core continuously for 83
   days** (`ops/deploy-queue/dist/server.js`). Unrelated to this incident, pure
   waste, never diagnosed.
6. **Consider blocking deploys during business hours** — §2 is a paid customer
   action dying mid-cutover, and it will happen again.
7. `AuditLog` has 47,121 sequential scans against **3** index scans (388k rows,
   82 MB) — effectively unindexed. Not this incident's cause; worth a pass.
