# ⛔ AGENT HANDOFF — "everything is loading very, very slow" (2026-08-06) — READ FIRST for ANY portal-speed report, before adding a permission check to a route, or before blaming the server / the customer's internet

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_PORTAL_PERFORMANCE_2026-08-06.md`**
(`abb1314a` + `4ad257f7` + `5486746a` on `feat/ivr-migration-takeover`, api +
portal DEPLOYED and container-verified, plus a live nginx change).
**Dashboard 22.1s → ~2–4s; api server time 499ms → 225ms; IVR Studio 5.15s → 3.41s.**

- ⛔ **THE BOX WAS NEVER THE BOTTLENECK — and Izzy's pushback is what found the
  real bug.** Through the whole incident the server was **79% idle**, 72 GB free,
  uplink at **0.5 Mbit/s**, on-box responses **5–20 ms**. Hardware would have
  changed nothing. **Four causes stacked**, and fixing the first alone looked
  like a total win while the api was still wasting half a second per request.
  Never stop at the first cause, and never conclude "capacity" from load average
  (it sat at 7–12 all day while CPU was 79% idle — that was deploy churn).
- ⛔ **HTTP/2 had never been enabled.** nginx was built `--with-http_v2_module`
  but no `http2` directive existed anywhere, so **51 of 51 requests were
  http/1.1** and Chrome capped at 6 connections while the dashboard fires **26
  API calls** — average queue wait **1,120 ms**, 14 requests waiting over a
  second *before being sent*. Now `listen 443 ssl http2;` in
  `/etc/nginx/sites-enabled/connectcomms` (a real file, NOT a symlink; the only
  443 block). Backup `/root/nginx-connectcomms-backup-20260806-http2.conf`.
  ⛔ nginx is **1.24**, which takes `http2` as a **`listen` parameter** — the
  standalone `http2 on;` only exists from 1.25.1. ⛔ **WebSockets are fine**
  (no Extended CONNECT → Chrome opens a separate HTTP/1.1 connection for
  `/ws/telephony`), but verify the 101s after any TLS change.
- ⛔ **Every request re-read the WHOLE permission system.**
  `hasEffectivePortalPermission()` ran the full resolver per call — **5 queries**,
  one of them issued **twice** — and routes ask several times each. Postgres was
  doing **184,000 rows/sec to serve 276 transactions/sec (~667 rows per
  request)**. ⛔ **NOT missing indexes** (all sensibly indexed; Postgres correctly
  seq-scans tables that small) — it was query *volume*. Fixed by
  `apps/api/src/permissionCache.ts`: **4 queries cold, 0 warm**; permission
  seq-scans **55.1/s → 4.5/s**. ⛔ It is an **authorization** cache: the **TTL,
  not the invalidation**, bounds staleness (blue/green means one process can't
  clear the other's map), a failed resolve is never cached, and **every new
  permission WRITE path must call `invalidateAllPortalPermissions()`**.
  `PORTAL_PERMISSION_CACHE_TTL_MS=0` disables it.
- ⛔ **A card charge that "timed out" was a deploy, not the gateway.** Izzy's
  `POST …/invoices/:id/pay` at 18:25:27 returned **499** (client gave up) while
  an api deploy started at 18:16 was still cutting over. Zero Cardknox errors.
  **44 deploys that day** (vs 12 the day before) also produced 502 bursts and
  drove 499s from ~5/hour to **124/hour**. ⛔ **An in-flight paid action can die
  in a blue/green cutover.**
- ⛔ **Never blame the customer's internet without a reference host.** Izzy's
  ping to `1.1.1.1` was a steady **10–15 ms** while the same ping to loopcom ran
  **96–830 ms** — the server is in **Lauterbourg, France**, so every request pays
  ~100–200 ms of travel forever. That is the remaining floor, and only moving the
  server fixes it.
- **IVR Studio:** the tenant list was fetched **3×** per load — ⛔ an
  **effect-dependency bug**, not a fetch bug (the effect watched a `useCallback`
  rebuilt as `role`/`backendJwtRole`/permissions each settled separately during
  boot); now watches the **boolean**. And `/voice/pbx/ring-groups` (a live
  Ombutel MySQL read, **1.8 s**) sat in the opening `Promise.all` so the whole
  screen waited on it — now deferred past first paint, **page usable ~2.8 s
  sooner**. ⛔ Late-arriving teams needed a **third** state (`teamsLoading`):
  reusing `teamsLoaded` prints "check they're linked to the phone system" while
  the request is still in flight, which is a lie.
- ⚠️ **NOT REPRODUCED: the reported Studio scroll lag.** A real defect was fixed
  (six rules used `transition:.14s` = **`transition: all`**, so the browser
  watched every animatable property on every row while scrolling swept hover
  across them), but the tenant selected in Izzy's browser (**Create A Box**) has
  **no menus**, so the page had nothing to scroll. **Re-test on a tenant with
  menus.** Next suspects: the global `.btn` transitions `transform, box-shadow`;
  `.ivrs .sticky` sits inside shadowed cards.
- ⛔ **Deploy traps:** `runningCount: 0` does NOT mean you can deploy — direct
  deploys never register in the queue and the **heavy-job lock is separate**
  (`pgrep -f run-heavy`). And **`nohup … &` over ssh dies with the tool's ssh
  session** — use `setsid nohup … < /dev/null & disown` and poll the log later;
  one deploy was silently lost this way.
