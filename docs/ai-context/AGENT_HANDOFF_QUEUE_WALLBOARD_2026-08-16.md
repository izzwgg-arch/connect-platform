# AGENT HANDOFF — the PBX already ships a queue wallboard, and Gesheft already has logins for it (2026-08-16)

**Read-only investigation. No PBX write, no code, no deploy, no config change.**
Deliverable was mockups only, at Izzy's explicit instruction ("show me mockups
before you build anything").

Artifact (the three mockups + the decision):
<https://claude.ai/code/artifact/0b5450cd-b0ae-43bf-ad62-ef7ecd05d208>

---

## 1. The finding that changes the decision

⛔ **Do NOT start building a queue wallboard from scratch without reading this
section.** The PBX already has one, it is installed and running, and Gesheft
already has two accounts in it.

Installed VitalPBX add-ons (`dpkg -l`), all present on 209.145.60.79:

| Package | Version | What it is |
|---|---|---|
| `sonata-switchboard` | 4.5.0-4 | **Live queue/extension monitoring — the wallboard** |
| `sonata-stats` | 4.0.5-6 | **Queue reporting over `queues_log`** |
| `sonata-recordings` | 4.5.0-7 | recording browser |
| `sonata-dialer` | 4.5.0-5 | outbound campaigns |
| `sonata-billing` | 4.5.0-2 | call tariffing |

Both queue tools are **served and answering**:

- Switchboard → `https://<pbx>/live-monitoring` → **200**
  (nginx `/etc/nginx/pbx-addons/live-monitoring.conf`, alias
  `/usr/share/switchboard/www`, PHP-FPM)
- Stats → `https://<pbx>/stats` → **200**
  (nginx `/etc/nginx/pbx-addons/sonata-stats.conf`, alias
  `/usr/share/queues-stats/frontend/dist`; API at `/sonata/service/v1`)
- `sonata-stats.service` is **active (running)**. There is **no**
  `sonata-switchboard.service` — Switchboard is plain PHP under nginx, so
  "the service isn't running" is not a valid diagnosis for it.

⛔ `/sonata/service/v1/` answers **404** at the bare path. That is normal — it
is a router entry point, not an index. Do not read it as "the API is broken".

### Gesheft is already provisioned in the Switchboard

`astboard.users` (the Switchboard's own DB — **`astboard`, not `ombutel`**):

| user_id | user | full_name | ext | tenant | layout_id | created |
|---|---|---|---|---|---|---|
| 1 | admin | izzy | — | 1 | NULL | 2025-07-26 |
| 2 | guest | — | — | 1 | NULL | 2025-07-26 |
| 4 | Gesheft | Joel Landau | 53 | **8** | **1** | 2025-12-24 |
| 5 | contact@Gesheftkosher.com | Pinchas meislish | — | **8** | **1** | 2026-03-01 |

⛔ **Both Gesheft accounts are on `layout_id 1` = `layout.default`**, whose
`layout_widgets` rows are widgets 1–4: `extensions`, `queues`, `conferences`,
`parking_lots`. That is the stock layout — **it is not a queue wallboard**.
So the product is switched on and pointed at the wrong thing; nobody ever built
them a queue layout. This is why "we don't have a wallboard" and "the PBX has a
wallboard" are both true.

### The widget catalog already covers most of the ask

`astboard.widgets` (15 rows). Queue-relevant ones:

`queues` · `queued_calls` · `queue_members` · `queue_overview` ·
`queues_calls_counter` · `queues_stats_summary` · **`queues_wallboard`**
(widget 13, full width 12) · `my_queues` · `extensions` ·
`extensions_summary` · `my_extension` · `trunks` · `conferences` ·
`parking_lots` · `html_embed` (widget 14 — an escape hatch if a Connect-built
panel ever needs to appear inside Sonata).

---

## 2. Gesheft's queues — the real numbers

Gesheft is **PBX tenant 8** (`ombutel.ombu_tenants.tenant_id = 8`, name
`gesheft`). ⛔ **Gesheft is the ONLY tenant on the entire PBX with queue
traffic** — a 30-day `queues_log` sweep returns only `T8_Q750`, `T8_Q751`,
`T8_Q752` and `NONE`. Any "queues feature" is, today, a one-customer feature.

⛔ **Queue names in `asterisk.queues_log` are `T<tenant>_Q<ext>`** — e.g.
`T8_Q750`, **not** `750`. Querying by the bare extension returns zero rows and
reads like "no queue data exists". That cost a round here.

### Configuration (`ombutel.ombu_queues`, keyed `queue_id`, **not `id`**)

| ext | name | strategy | timeout | retry | announce position | members |
|---|---|---|---|---|---|---|
| 750 | Phone Orders | `ringall` | 30 | 5 | yes | 8 |
| 751 | Customer Service | `linear` | 15 | 5 | yes | 3 |
| 752 | After Hours CS | `ringall` | 15 | 5 | no | 3 |

Membership (`ombu_queue_members` → `ombu_extensions`, join on
`extension_id`; ⛔ the name column is **`ombu_extensions.name`**, there is no
`description` column on that table):

- **750 Phone Orders** — 101 Phone Orders, 102 Customer Service, 108 Office 2,
  111 Accounts Payable, 115 Phone Orders 2, 116 Phone Orders 3,
  117 Phone Orders 4, 118 Phone Orders 5
- **751 Customer Service** — 101, 102, 108
- **752 After Hours CS** — 104 Register 2, 105 Register 3, 106 Register 4

### Outcomes, 30 days to 2026-08-16 (`asterisk.queues_log`)

| queue | offered | answered | timed out | abandoned | avg wait | avg talk |
|---|---|---|---|---|---|---|
| 750 Phone Orders | 2,041 | **1,880 (92.1%)** | 1 | 142 (7.0%) | 34 s | 2m 21s |
| 751 Customer Service | 472 | **214 (45.3%)** | **218 (46.2%)** | 40 (8.5%) | 13 s | 1m 38s |
| 752 After Hours CS | 336 | **37 (11.0%)** | **275 (81.8%)** | 24 (7.1%) | 14 s | 1m 05s |

Per-agent on 750 (30 d): **102 → 902 calls (48% of the whole queue)**,
101 → 301, 116 → 283, 111 → 272, 115 → 122.
⛔ **108, 117 and 118 took ZERO queue calls in 30 days** — members on paper only.
On 752, only 105 meaningfully answers (35); 104 took **2**; 106 took none.

Hourly profile, 750 `ENTERQUEUE`, converted to ET (PBX logs UTC; ET = UTC−4):
9a 157 · **10a 300 (peak)** · 11a 285 · 12p 287 · 1p 226 · 2p 241 · 3p 261 ·
4p 198 · 5p 81.

**Open, flagged to Izzy, NOT acted on:** 751 and 752 lose more callers to
timeout than they answer. Changing strategy, timeout or membership is a PBX
write and Izzy's call.

### Query traps paid for here

- ⛔ `queues_log.data1/2/3` are **varchar**. `max(data1)` does a **string**
  compare and returns nonsense (an abandon "max wait" came back lower than the
  average). Always `cast(dataN as unsigned)` for min/max. `avg()` coerces and is
  safe.
- Field meaning is **per event**: `COMPLETECALLER`/`COMPLETEAGENT` →
  data1 = holdtime, data2 = talktime, data3 = position. `ABANDON` →
  data1 = position, data2 = origposition, **data3 = waittime**. Reading data1 as
  "wait" on an ABANDON row is wrong.
- `RINGNOANSWER` dominates the event counts (20,112 on 750) and is **structural
  for `ringall`** — every un-winning member logs one per ring round. It is not a
  fault count; do not surface it as one.
- ⛔ There is **no `asteriskcdrdb`** on this box and no `queue_log` table. It is
  **`asterisk.queues_log`** (plural, ~169k rows).

---

## 3. What Connect has today

- **Live state exists.** `apps/telephony/src/telephony/state/QueueStateStore.ts`
  keeps a `NormalizedQueueState` per queue from AMI `QueueCallerJoin` /
  `QueueCallerLeave` / `QueueMemberStatus` / `QueueMemberPaused`, and it ships to
  the portal as `LiveQueueState` over the existing `/ws/telephony` socket
  (`apps/portal/types/liveCall.ts`). Members carry `status`, `paused`,
  `callsTaken`, `lastCall`.
- ⛔ **It is live-only and in-memory.** It has no history, and it is **rebuilt
  from zero on every telephony restart** — `callerCount` is a running
  increment/decrement, not a read of the real queue depth. Do not build reports
  on it, and do not trust its counts across a restart.
- ⛔ **Connect does not read `queues_log` at all.** Every historical number in
  the mockups came from the PBX directly. Ingesting that is the actual build
  cost of a native reports tab, not the UI.
- **The existing `/crm/wallboard` is NOT this.**
  `apps/portal/app/(platform)/crm/wallboard/page.tsx` (2,413 lines) is a CRM
  wallboard — campaigns, dispositions, tasks, callbacks. It reads
  `LiveQueueState` but is not a queue wallboard. Do not extend it into one by
  accident; it belongs to a different feature.

---

## 4. Status / what is NOT done

⏳ **Nothing has been built. No decision has been made.** The deliverable was
mockups. Three routes were put to Izzy:

- **A** — build a queue layout in Sonata and assign it to Gesheft's two existing
  accounts (~a day; but it is a **PBX write**, so it needs an explicit mandate).
- **B — recommended** — do A now, let Gesheft use it for two weeks, and let what
  they actually watch become the spec for the native build.
- **C** — build native immediately; the live half is close, the reports half
  means ingesting `queues_log`.

Open questions handed to Izzy, all of which change the design: one tenant vs a
platform feature; wall TV vs browser tab (a TV needs a no-login, never-expiring
surface); whether supervisors get Listen/Whisper/Barge; whether the board raises
alarms.

⛔ **Listen / Whisper / Barge appear as buttons in the supervisor mockup and are
UNVERIFIED.** They need `ChanSpy` confirmed on the PBX and a permission gate in
Connect. Neither was checked. Do not promise them to a customer off the mockup.

⛔ **Alarms cannot ride `ADMIN_ALERT`** — alert email is muted platform-wide at
the send door. An on-screen alarm or an escalation is the only channel that
reaches a human.

---

## 4b. Sonata Stats HAS a full REST API (mapped 2026-08-16)

**This materially changes the cost of Route C.** Connect would not have to ingest
`queues_log` to get reports — it could ask Sonata for them.

- **Stack:** Laravel 10 + `tymon/jwt-auth` at
  `/usr/share/queues-stats/backend`. ⛔ `routes/api.php` and the controllers are
  **ionCube-encrypted** — do not try to read them. The route surface is instead
  recoverable in plaintext from the **Laravel route cache**,
  `bootstrap/cache/routes-v7.php` (a `var_export` array, ~141 KB). In that file
  **`'methods'` comes BEFORE `'uri'`** — a regex assuming the reverse silently
  matches nothing.
- **Base URL:** `https://<pbx>/sonata/service/v1/api/<route>`. Verified live:
  `GET api/version` → **401** `{"message":"Unauthenticated."}`, and
  `GET api/summary` → **405** *"Supported methods: POST"*. The 405 proves routing
  resolves correctly behind the nginx alias.
- **79 routes.** Auth is JWT: `POST api/login` (public) → bearer token; then
  `auth:api` on everything else. Reporting endpoints are **POST** with a filter
  body; list endpoints are GET.
- **The reporting surface** (all JWT, all POST unless noted):
  `summary`, `summary-dashboard`, `calls-by-queue`, `call-by-queue-detail`,
  `call-by-agent-detail`, `lost-calls-by-agents`, `abandoned-calls-track` (GET),
  `service-level`, `call-traffic`, `calltraffic-dashboard`,
  `disconnection-causes(-dashboard)`, `direct-calls(-detail)`,
  `outgoing-calls(-detail)`, `call-detail`, `call-events`,
  `agent-availability(-detail)`, `agent-pauses(-detail)`, `agent-by-hour`,
  `agent-session-time-by-day`/`-by-hour`, `agent-session-pause-duration(-detail)`,
  **`agents-on-queue`**; plus GET `queues`, `agents`, `extensions`, **`tenants`**,
  `users`, `roles`, `permissions`, `shifts`, `version`, `license-data`, and a
  scheduled-report engine (`report-builder`, `report-schedule`, `report-monitor`,
  incl. `report-schedule/send/{id}`).
- ✅ **It is tenant-aware** (`GET api/tenants`, and `sonata_stats.users.tenant_id`),
  so a Connect integration could scope per customer rather than leaking across
  tenants.
- ✅ **Gesheft already has Stats accounts too**, not just Switchboard:
  `sonata_stats.users` holds `Gesheft` / 6623885@gmail.com and
  `contact@Gesheftkosher.com`, both `tenant_id 8`, created 2025-12-24 and
  2026-03-01 — the same two people as `astboard.users`.
- ⛔ **UNPROVEN — the license gate.** Every route carries a **`check_app`**
  middleware (99 occurrences in the route cache), and
  **`/var/lib/sonata/stats/lic/` is EMPTY** — there is no license file, and no
  license table exists in any database on the box. Whether `check_app` passes
  is **not established**: proving it needs one real login, and I will not guess
  or enter a credential. `sonata-stats.service` is running and `/stats` serves
  200, so the UI is alive; that is not the same as the API being unlocked.
  **Acceptance test:** `POST /sonata/service/v1/api/login` with a known Stats
  user, then `GET api/version` with the bearer token — a version number means the
  API is usable, a license error means Route C's "just call Sonata" shortcut is
  closed until the add-on is paid for.
- ⛔ **The API also exposes DELETE routes** (`users/{user}`, `roles/{role}`,
  `shifts/{shift}`, `report-*`, `delete-license`) and POST `activate-product` /
  `migrate-product`. Any credential Connect stores for this must be
  **least-privilege**, and calling it is reaching into the PBX — reads are fine
  under the read-only guardrail, writes are not.

## 4c. BUILT AND DEPLOYED 2026-08-16 — Route C, native

Commits `28861ec6` + `c21a6eca` on `feat/ivr-migration-takeover`.
**api + portal DEPLOYED and container-verified.** Izzy chose to build native
and authorised the `queues_log` grant.

### What shipped

| Piece | Where |
|---|---|
| Queue config + membership reader | `apps/api/src/pbxQueueDirectory.ts` |
| Queue history + report aggregates | `apps/api/src/pbxQueueStats.ts` |
| Guard tests (14) | `apps/api/src/pbxQueueStats.test.ts` |
| Routes | `GET /voice/queues`, `POST /voice/queues/reports` (server.ts ~17559) |
| Supervisor console | `apps/portal/app/(platform)/queues/page.tsx` |
| Wall display | `.../queues/wall/page.tsx` |
| Detailed reports | `.../queues/reports/page.tsx` |
| Shared live/config join | `.../queues/queueBoard.ts` |
| Styles | `.qb-*` / `.qw-*` appended to `globals.css` |
| Nav + permission key | `navConfig.ts`, `portalPermissions.ts` (`can_view_pbx_queues`) |

- **Live state is NOT a new API.** It rides the existing `/ws/telephony`
  `LiveQueueState`. ⛔ Do not add a REST "live queues" endpoint — that would be
  a second source of truth for the same fact.
- Permission keys are **reused, not invented**: `can_view_live_calls` gates the
  status route, `can_view_reports` gates reporting, and the nav item's
  `can_view_pbx_queues` rides the `can_view_calls` legacy expansion.

### ⛔ The one thing left to run — the GRANT

Reports are built and deployed but **return no data until this runs on the
PBX**. Izzy approved it 2026-08-16; it is a PBX privilege change, so it stays a
human action under the read-only guardrail:

```sql
GRANT SELECT ON `asterisk`.`queues_log` TO 'connect_read'@'45.14.194.179';
FLUSH PRIVILEGES;
```

Until then the endpoint answers **200 with `available:false`,
`reason:"queue_log_access_denied"`** and the screen prints that exact SQL.
✅ **Proven live inside `app-api-1` on 2026-08-16** — the directory reader
returned all three Gesheft queues with correct members, and the stats reader
returned precisely `queue_log_access_denied`. Re-verify after the grant with
the same probe (§4d).

### Five traps encoded in code, each with a test

1. **Queue naming** — `T8_Q750`, never `750`. Assembled ONCE, in
   `queueLogName()`. A test asserts no other module builds it.
2. **`data1/2/3` are varchar** — `max()` string-compares. Every numeric read is
   `CAST(... AS UNSIGNED)`; a test greps for an uncast aggregate.
3. **Field meaning is per-event** — `ABANDON` carries waittime in **data3**
   (data1 is the position). A test pins the abandon query to data3.
4. **`time` is a varchar in UTC; `created` is a real timestamp in PBX-local
   time**, proven exactly **240 minutes** apart on live rows. Reports use
   `created`, and the range is evaluated **by MySQL** (`DATE_SUB(NOW(), …)`) so
   no JS timezone guess can exist. A test forbids `getUTCFullYear` here.
5. **`RINGNOANSWER` is structural under ringall** — 20,112 against 1,880
   answered calls. Carried as its own labelled field, never folded into a
   missed-call or per-agent fault count.

Plus: **config is authoritative for membership**. Live state is in-memory and
rebuilt from zero on telephony restart, so an agent absent from the live payload
renders **offline**, never "not a member" — otherwise a restart would appear to
delete a customer's team.

### ⛔ Deploy trap paid for here

**A Next.js App Router `page.tsx` may only export a default component.** A
named export (`export function describeStrategy`) fails the production build
with *"does not match the required types of a Next.js Page"* — and
**`tsc --noEmit` does NOT catch it**, so it passed every local check and failed
in the deploy's build stage. Portal helpers belong in a sibling module, never
in the page file. Fixed in `c21a6eca`.

### ⏳ NOT PROVEN

- **Nobody has opened any of the three screens in a browser.** Proven as
  plumbing: containers verified, modules executed live against the real PBX,
  typecheck clean, 14 + 33 tests green.
- **No report has ever rendered with data** — that needs the grant.
- **Wait-time and agent-state live values are unproven against a real ringing
  call.** The live join is written against `LiveQueueState` / `LiveCall` shapes
  but has not been watched during an actual queue call.
- Listen / Whisper / Barge are **not built** — deliberately. They need
  `ChanSpy` verified on the PBX and a permission gate; neither was done.

## 4d. Re-verification probe

Run inside the api container after the grant lands. Proves the whole chain
without a browser:

```bash
docker cp qtest.ts app-api-1:/app/apps/api/qtest.ts
docker exec -w /app/apps/api app-api-1 npx tsx qtest.ts
```
where `qtest.ts` calls `listQueuesFromOmbutel("8", inst.ombuMysqlUrlEncrypted)`
then `loadQueueStats({ queues, range: { kind: "lastDays", days: 30 } })`.
Expected after the grant: `STATS OK`, Phone Orders `offered=2041
answered=1880 (92.1%)`, service level ~78% @20s. ⛔ Delete the probe from the
container afterwards.

## 5. Design decisions already made (so they are not re-litigated)

- The mockups use **Connect's own theme tokens** (`--bg #0c1218`,
  `--panel #141f2b`, `--accent #22a8ff`, `--success #34c27b`,
  `--warning #f0b655`, `--danger #ea6068`) so the board reads as Connect, not as
  a bolt-on. Per the billing-theme lesson, no section gets its own palette.
- ⛔ **Agent state is never colour alone.** The palette was run through the
  data-viz validator against the `#141f2b` panel surface: `#34c27b` (answered/
  ready) beside `#f0b655` (timed out/ringing) fails colourblind separation at
  **ΔE 5.2 protan** — below even the 6–8 warn floor. So a stacked
  answered/timeout/abandoned bar was **rejected** in favour of one
  answered-rate meter per queue plus an exact table, and every state chip
  carries a symbol and a word. Do not "simplify" that back into a stacked bar.
- A **wall display and a supervisor console are two screens, not one screen at
  two sizes.** The wall board is read at 15 feet with no mouse; the console is
  operated. Merging them compromises both.
