# ⛔ AGENT HANDOFF — the PBX ALREADY ships a queue wallboard, and Gesheft already has logins for it (2026-08-16) — READ FIRST before building ANY queue wallboard / call-centre dashboard, before querying queue history, or before believing Connect has queue reporting

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_QUEUE_WALLBOARD_2026-08-16.md`**
(**Read-only investigation — no PBX write, no code, no deploy.** Deliverable was
mockups only, per Izzy: "show me mockups before you build anything." Mockups:
<https://claude.ai/code/artifact/0b5450cd-b0ae-43bf-ad62-ef7ecd05d208>)

- ⛔ **THE RULE: check the PBX for an existing add-on before building a PBX-shaped
  feature.** `sonata-switchboard` (live queue monitoring, `/live-monitoring`) and
  `sonata-stats` (queue reporting, `/stats`) are **installed, served and answering
  200**; `sonata-stats.service` is running. Switchboard is plain PHP under nginx
  with **no systemd unit** — "the service isn't running" is not a valid diagnosis
  for it, and `/sonata/service/v1/` answering **404** at the bare path is normal.
- ⛔ **Gesheft is already IN the Switchboard and pointed at the wrong screen.**
  `astboard.users` holds two tenant-8 accounts — **Joel Landau** (ext 53,
  2025-12-24) and **Pinchas Meislish** (2026-03-01) — both on **`layout_id 1`
  (`layout.default`)**, whose widgets are `extensions`/`queues`/`conferences`/
  `parking_lots`. The stock layout, not a queue board. The catalog already
  contains **`queues_wallboard`**, `queue_members`, `queued_calls`,
  `queue_overview`, `queues_calls_counter`, `queues_stats_summary` — so "we have
  no wallboard" and "the PBX has a wallboard" are both true.
- ⛔ **Gesheft (PBX tenant 8) is the ONLY tenant on the whole PBX with queue
  traffic.** A queue feature is today a one-customer feature. Queues: **750 Phone
  Orders** (ringall/30s, 8 members), **751 Customer Service** (linear/15s, 3),
  **752 After Hours CS** (ringall/15s, 3). 30 days: 750 answers **92.1%** of
  2,041; **751 answers 45.3% and TIMES OUT 46.2%**; **752 answers 11.0% and times
  out 81.8%**. ⛔ **108, 117, 118 took ZERO queue calls in 30 days** and **102
  alone carries 48%** of Phone Orders. Flagged to Izzy, deliberately NOT acted on
  — strategy/membership changes are PBX writes.
- ⛔ **Query traps, each of which produced a wrong answer first:** queue names in
  the log are **`T8_Q750`**, not `750` (bare ext returns zero rows and reads like
  "no data"); the table is **`asterisk.queues_log`** (plural) — there is **no
  `asteriskcdrdb`** on this box; `ombu_queues` is keyed **`queue_id`** not `id`
  and `ombu_extensions` has **`name`**, not `description`; and `data1/2/3` are
  **varchar**, so `max()` string-compares (an abandon "max" came back below its
  own average) — `cast(dataN as unsigned)`. Field meaning is per-event:
  COMPLETE* → data1 hold/data2 talk, **ABANDON → data3 waittime**.
  `RINGNOANSWER` is **structural for ringall** (one per losing member per round),
  never a fault count.
- **Connect's side:** live queue state DOES exist —
  `apps/telephony/.../QueueStateStore.ts` from AMI, shipped as `LiveQueueState`
  over `/ws/telephony`. ⛔ But it is **in-memory, live-only, and rebuilt from zero
  on every telephony restart** (`callerCount` is a running counter, not a real
  depth read) — never build reports on it. ⛔ **Connect does not read
  `queues_log` at all**; ingesting it is the real cost of a native reports tab.
  ⛔ The existing `apps/portal/app/(platform)/crm/wallboard/page.tsx` is a **CRM**
  wallboard (campaigns/dispositions/tasks) — different feature, don't grow it into
  this one.
- ⛔ **Palette decision, already validated — do not re-litigate.** Agent state is
  never colour alone: Connect's `--success #34c27b` beside `--warning #f0b655`
  fails colourblind separation at **ΔE 5.2 protan** (below even the 6–8 floor) on
  the `#141f2b` panel, so a stacked answered/timeout/abandoned bar was rejected
  for per-queue answered-rate meters plus an exact table, and every state chip
  carries a symbol **and** a word.
- ✅ **Sonata Stats has a FULL REST API — 79 routes, mapped 2026-08-16** (handoff
  §4b). Laravel 10 + JWT at **`https://<pbx>/sonata/service/v1/api/<route>`**:
  `POST api/login` → bearer, then `summary`, `calls-by-queue`, `service-level`,
  `agents-on-queue`, `agent-availability`, `agent-pauses`, `call-traffic`,
  `disconnection-causes`, `call-detail/-events`, GET `queues`/`agents`/
  **`tenants`**, plus a scheduled-report engine. Reporting routes are **POST**
  with a filter body. ⛔ **This means Route C may not need the `queues_log`
  ingest at all** — Connect could ask Sonata. ⛔ `routes/api.php` + controllers are
  **ionCube-encrypted**; recover the surface from the plaintext Laravel route
  cache `bootstrap/cache/routes-v7.php`, where **`'methods'` precedes `'uri'`**
  (a regex assuming the reverse matches nothing). Verified live: `api/version`
  → 401, `api/summary` → **405 "Supported methods: POST"** (which is what proves
  routing resolves behind the nginx alias). ✅ Gesheft has **Stats** accounts too
  (`sonata_stats.users`, tenant 8 — same two people as `astboard.users`).
  ⛔ **UNPROVEN: the license gate.** Every route carries **`check_app`** and
  **`/var/lib/sonata/stats/lic/` is EMPTY** with no license table anywhere —
  a running UI is NOT proof the API is unlocked. One real login + `api/version`
  settles it; don't guess a credential. ⛔ The API also exposes DELETE
  (`users`, `roles`, `shifts`, `delete-license`) — least-privilege only, and
  reads are fine under the read-only guardrail but writes are not.
- ✅ **BUILT AND DEPLOYED 2026-08-16 — native, Route C** (`28861ec6` +
  `c21a6eca`; api + portal container-verified). Handoff §4c. **`/queues`**
  (supervisor console), **`/queues/wall`** (TV display), **`/queues/reports`**.
  Backend: `pbxQueueDirectory.ts` (config + membership from ombutel, and the
  ONE place `T<n>_Q<ext>` is assembled) + `pbxQueueStats.ts` (outcomes, service
  level, wait distributions, per-agent, hour/day/weekday) + `GET /voice/queues`
  and `POST /voice/queues/reports`. ⛔ **Live state is NOT a new API — it rides
  the existing `/ws/telephony` `LiveQueueState`; never add a REST "live queues"
  endpoint** (second source of truth for the same fact).
- ✅ **PER-USER PERMISSIONS, and the two editors differ on purpose** (`2ffa720f`):
  `/admin/permissions` (built-in roles) renders only sidebar items → **one
  Queues on/off**; `/admin/roles/[id]` (custom roles) also renders
  `ACTION_PERMISSION_KEYS` → the nav item **plus three** toggles,
  **`can_view_queues`** (live), **`can_view_queue_wallboard`** (TV mode),
  **`can_view_queue_reports`** (history). Three because the reports rank
  **named agents** — revoking them must leave the live board. TENANT_ADMIN has
  all three, END_USER none, SUPER_ADMIN automatic via the force-add bucket.
  ⛔ **The bug this fixed is worth remembering: a visible door that doesn't
  open.** The nav key first hung off `can_view_calls`, which **END_USER holds**,
  while the pages needed tenant-admin access — so every ordinary user would have
  seen a Queues item that denied them on click, reading as a broken app rather
  than a permission. It now hangs off `can_view_reports`, and a test asserts no
  bucket can hold the nav key without `can_view_queues`. ⛔ **Both layers are
  required**: routes use `requireRoleOrPortalPermission` (the role-only
  `requirePermission` is invisible to custom roles) **and** every page wraps
  itself in `PermissionGate` — hiding a sidebar item is presentation, not
  access, and a typed URL would otherwise still render. ⛔ Per
  [[custom-roles-are-authoritative]], a custom role created before these keys
  existed simply lacks them (fails closed) and needs them ticked on.
- ✅ **THE GRANT IS APPLIED (2026-08-16) — reports are LIVE with real data.**
  `connect_read` now holds `ombutel.*` **plus `asterisk.queues_log`**, nothing
  else. Proven in `app-api-1`: Phone Orders **2,020 offered / 1,866 answered
  (92.4%) / SL 78.5% @20s**, Customer Service 45.9%, After Hours 11.0%, agent
  102 at **48.2%** of Phone Orders, idle members 108/117/118 correctly flagged.
  ⛔ Apply such a grant from a **file** (`mysql < file.sql`) — inline backticks
  do not survive nested-shell quoting and fail with `Failed to open file`,
  which reads like a MySQL error and is not one.
  ⛔ The failure path still matters and is still tested: without the grant the
  route answers **200 `available:false` / `queue_log_access_denied`** and the
  screen prints the exact SQL — **deliberately never an empty report**, which
  would render as "this customer had no calls" about a queue doing 2,000/month.
- ⛔ **Light mode was broken and the fix is ink-vs-fill — do not collapse it
  back.** `--success`/`--warning`/`--danger`/`--accent` are DISPLAY colours: as
  TEXT they measure **2.28 / 2.15 / 3.76 / 3.68** on the light panel (success
  and warning effectively unreadable) versus 7.31 / 7.76 / 4.43 / 4.53 on dark.
  Text now uses `--qb-ink-*`, darkened for light only (5.38–5.93:1); fills,
  borders and edge stripes keep the display colour. 0 text uses left on a raw
  display colour, 36 fills correctly untouched. Button ink `#04121d` on accent
  was measured and KEPT (5.15 light / 7.31 dark — better than white on both).
- ✅ **TV mode is real** (`/queues/wall`, reached from `/queues`): Fullscreen
  API, **screen wake lock re-acquired on every `visibilitychange`** (the browser
  drops it whenever the tab hides, so acquiring once dies overnight), controls
  that fade after 4 s but never leave the DOM (still keyboard-reachable), and a
  per-display theme lock in `localStorage`. ⛔ That lock is **token overrides
  scoped to `.qw-root`, never `data-theme` on `<html>`** — the app context owns
  that attribute and leaving TV mode could strand the whole portal in the wrong
  theme.
- ✅ **CREATING A QUEUE ships from `/queues`** (`607d9c2e`) — everyday options up
  front, advanced collapsed, both in plain language. ⛔ It extends the
  **EXISTING `POST /voice/teams`**; no second creation path (that is how the two
  IVR publish paths drifted). `teamBuilder.createQueue` had **14 hardcoded
  values** — strategy, servicelevel, wrapuptime, joinempty, leavewhenempty,
  autofill, autopause, memberdelay, weight, penaltymemberslimit, the four
  `announce_*`, alertinfo, hangup destination and per-member penalty are now all
  configurable. ⛔ **Strategy was CHECKED before being offered** (the contract doc
  says only `ringall` was ever captured): the value passes straight into the
  generated `queues.conf` — `ringall` and `linear` both appear live — and a bad
  value fails loudly via `assertSaved`. ⛔ **`queue_callback_id` stays empty** —
  its panel screen was never recorded. ⛔ **The panel sends `""`, not `"0"`, for
  a blank numeric field** (`numField()`), because `servicelevel=0` and
  `servicelevel=` differ. ⛔ **Apply Changes is still never fired**, and the form
  says so before you submit. New key **`can_create_queues`**, which the route
  accepts **OR** the IVR-management key — the button checks the same pair, so it
  can never 403.
- ⛔⛔ **TWO THINGS A REAL CREATE FOUND THAT A 200 WOULD NOT HAVE** (`2c7657f3`,
  proven by creating a queue on the Loopcom Demo tenant and reading the row
  back): **(1) A QUEUE MUST HAVE A LAST DESTINATION.** The panel refused with
  *"Destination Module is required. | Destination is required."* — and
  `mod_dest`/`destination` were only sent when one was supplied, so any queue
  created without one failed at the very end of the form. Now refused up front
  and the field is required in the dialog (a "just hang up" option was removed —
  the phone system never accepted it). **(2) `autofill` and `autopause` are
  CHECKBOXES, not selects.** Sending `autofill=no` stored **yes**, because the
  panel reads *field present* as *box ticked* whatever the value is; an
  unchecked box must be **absent**. ⛔ `joinempty`/`leavewhenempty` ARE selects
  and DO carry "yes"/"no" — they round-tripped correctly in the same request,
  which is what proves the split is real. Everything else landed exactly as
  sent, **including `rrmemory`** — so the strategy list is now proven, not
  assumed. 8 guard tests in `teamBuilder.queue.test.ts` pin all of it.
- ⏳ **YIDDISH IS WIRED ON ALL FOUR QUEUE SCREENS BUT ONLY 26 OF 176 PHRASES
  TRANSLATED.** 150 fail at Yiddish Labs and the reason is **unreadable**:
  `/agent/ui/translate` catches bare (`catch { failed.push(s); }`) and throws
  away the HTTP status `processText` put in the message. Ruled out with evidence
  — **not rate limiting** (they fail spaced 8 s apart, one at a time), **not
  punctuation** (`"Longest wait - seconds"` fails in pure ASCII too), **not
  length** (`"Most callers allowed to wait"` succeeds, `"seconds"` fails).
  ✅ **It degrades safely** — an untranslated phrase renders English, which is
  the designed behaviour; the endpoint never invents Yiddish. To finish: log the
  status in that catch, **rebuild the agent** (⛔ reset the server clone first),
  re-warm, read the real reason.
- ⏳ **Listen/Whisper/Barge: VERIFIED FEASIBLE, deliberately NOT built.**
  `app_chanspy.so` is loaded; VitalPBX already ships `[sub-extension-spy]` in
  `extensions__20-baseplan.conf` mapping **`qS` listen / `qwS` whisper / `qBS`
  barge**; Connect already has AMI `Originate` (`TelephonyService.ts:607`).
  ⛔ But the stock subroutine is **interactive** — it `Read()`s the target
  extension and may `Authenticate()` — so it cannot be driven programmatically
  without adding a non-interactive context. Left unbuilt on purpose: silently
  listening to a live call needs its OWN permission key, a per-session audit row
  and a decision on notifying the agent.
- ⛔ **A Next.js App Router `page.tsx` may ONLY export a default component.** A
  named export fails the production build ("does not match the required types
  of a Next.js Page") and **`tsc --noEmit` does NOT catch it** — it passed every
  local check and died in the deploy's build stage. Portal helpers go in a
  sibling module, never the page file.
- ⏳ **NOT PROVEN: nobody has opened any of the three screens in a browser**,
  no report has rendered with data (needs the grant), and the live wait/agent
  values have never been watched during a real queue call.
- ⏳ **Superseded below, kept for context — the three routes originally offered:**
  (A: build a Sonata
  queue layout — a PBX write needing a mandate; **B, recommended**: do A now and
  let two weeks of real use write the spec; C: build native now). Open questions
  that change the design: one tenant vs platform; wall TV vs browser tab (a TV
  needs a no-login, never-expiring surface); alarms — ⛔ which **cannot** ride
  `ADMIN_ALERT` (muted platform-wide), so on-screen or escalation only.
  ⛔ **Listen/Whisper/Barge are drawn in the mockup and are UNVERIFIED** — they
  need `ChanSpy` confirmed on the PBX and a Connect permission gate; neither was
  checked. Don't promise them off the picture.
