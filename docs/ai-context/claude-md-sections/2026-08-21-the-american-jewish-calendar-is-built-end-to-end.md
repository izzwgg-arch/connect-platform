# ⛔⛔ AGENT HANDOFF — the American Jewish calendar is BUILT END TO END: it drives the IVR menu AND the hold music, with the a cappella switch — DEPLOYED AND VERIFIED, but NO TENANT IS SWITCHED ON (2026-08-21) — READ FIRST before adding ANY Hebrew-calendar/hebcal dependency to apps/api, before touching `holidayDates` or `computeCurrentMode`, or before answering "can the phone system know when Pesach is?"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_JEWISH_CALENDAR_MOCKUPS_2026-08-21.md`**
(**Plan + mockups only — no code, no dependency, no migration, no deploy, no PBX
write, no tenant row touched.** Mockups Izzy is choosing from:
<https://claude.ai/code/artifact/65ed6be1-6589-41c9-a4e3-9dc9007bac18>.)
Memory: [[jewish-calendar-mockups-only]].
Izzy, 2026-08-21: *"the system should always be updated with an American Jewish
calendar, not Israeli … if somebody says 'this and this holiday, this is my
schedule', the system will always know when that holiday is this year"*, plus
*"a button where people can see the calendar view month by month"*.

- ⛔⛔ **THE BUILD TRAP, found before writing any code: `@hebcal/core` is
  ESM-ONLY from v6 and `apps/api` is CommonJS** (`tsconfig.base.json`:
  `module: CommonJS`, `moduleResolution: Node`). v6.9.2 has **no `main`** and an
  `exports` map with only an `import` condition — proven live:
  `require('@hebcal/core')` → **`ERR_PACKAGE_PATH_NOT_EXPORTED`**, and classic
  Node resolution cannot read `exports` at all so TS will not resolve the types.
  `await import()` does not save it (TS downlevels it to `require()` under
  `module: CommonJS`). **It does not fail at build time — it fails when the API
  loads it, i.e. a container that will not boot: the `undici` class.**
  ✅ **Recommended way through: generate the table offline and ship DATA.**
  Measured: **1,835 rows / 69.5 KB of JSON covering 2026–2076** — every yom tov,
  chol hamoed, erev and fast day, already flagged diaspora, 15 holiday names.
  apps/api imports nothing; sunset is ~40 lines of NOAA astronomy. Matches this
  repo's own habit (hand-rolled SigV4 vs the AWS SDK, hand-rolled HS256 vs the
  LiveKit SDK, a tokeniser vs a highlighting library). The alternative is pinning
  **`@hebcal/core@5.x`**, the last line shipping a CJS build.
  ⛔ **Licence: `@hebcal/core` and `@hebcal/hdate` are GPL-2.0** (`@hebcal/noaa`
  LGPL-2.1). Server-side use is not distribution so it is fine in apps/api — **it
  must NEVER be bundled into the portal or the mobile app**, which is. Generating
  the table sidesteps it entirely: dates are facts.
- ⛔⛔ **AMERICAN vs ISRAELI IS FIVE WRONGLY-ANSWERED DAYS A YEAR, and one boolean
  decides it.** Computed both ways: on `il: true` the phone answers **normally on
  yom tov** on **Sun 27 Sep 2026 (Sukkot II)**, **Sun 4 Oct 2026 (Simchat
  Torah)**, **Fri 23 Apr 2027 (Pesach II)**, **Thu 29 Apr 2027 (Pesach VIII)**
  and **Sat 12 Jun 2027 (Shavuot II)** — nothing would ever error. Those five
  dates are the fixtures for the `il: false` test.
- ⛔⛔ **A DATE IS NOT ENOUGH — the day turns at sunset, and the current model
  cannot express it.** `computeCurrentMode` (`apps/api/src/ivrModeSelection.ts:18`)
  is `holidays.includes(localDate)` — a flat `"YYYY-MM-DD"` list, midnight to
  midnight. But **Rosh Hashanah 5787 is one continuous 49-hour closure across
  THREE Gregorian dates** (candle lighting Fri 11 Sep 6:54pm → havdalah Sun 13
  Sep 7:59pm, because it falls on Shabbos), and **Friday candle lighting in
  Monsey swings 4h 05m across the year** — earliest **4:09pm (4 Dec 2026)**,
  latest **8:14pm (25 Jun 2027)**. A fixed `close: "17:00"` is 51 minutes late in
  December and 3h 14m early in June; there is no right value. The rule that works
  is **"N minutes before candle lighting"**, which needs intervals, not dates.
- ✅ **The plumbing for that ALREADY EXISTS — do not rebuild it.**
  `sweepIvrModeBoundaries()` (`apps/api/src/server.ts:24988`) re-evaluates every
  active schedule **on the 60-second DID-switch tick** and republishes the moment
  the computed mode differs from the last successful publish's mode. So
  minute-accurate sunset boundaries need **no PBX change at all** — only
  `computeCurrentMode` has to learn intervals. `resolveDidmapProfileId` already
  routes assigned numbers through the mode, so a holiday flip reaches them.
- ⛔ **Nothing in this repo has ever touched a Hebrew date** — grepping
  `hebcal|hebrew|shabbos|zmanim|candle` returns only Yiddish *transcription*
  files. Greenfield.
- ✅✅ **WHOSE TIMES: SATMAR, 72 MINUTES (Izzy, 2026-08-21 — asked for Chabad, then
  *"if you can find Satmar even better"*). Handoff §8.**
  ⛔⛔ **"Use the Satmar calendar" is NOT a different calendar — it is ONE NUMBER.**
  The **dates are identical on every calendar** (Rosh Hashanah 5787 is 12–13 Sept
  on a Satmar luach, a Chabad calendar and hebcal alike) — the Hebrew calendar is
  arithmetic, not opinion. **Do not go hunting for a Satmar feed; there is no
  public one and none is needed.** What differs is **nightfall**, i.e. when the
  phone REOPENS, and hebcal exposes it as `havdalahMins` / `havdalahDeg`.
  **Measured for Monsey (KJ and Williamsburg within a minute or two):
  Satmar/Kiryas Joel = fixed 72 min after sunset (Rabbeinu Tam), publicly
  emphasised by the Satmar Rebbe → 5:40pm on 4 Dec 2026, 9:45pm on 25 Jun 2027.
  Chabad = 8.5° below horizon, 21–27 min EARLIER. 50 min = 22 min earlier.
  42 min = 30 min earlier.** Candle lighting is **18 min before sunset on all
  four** and is not disputed. ⛔ **Chabad ≈ the 50 min the first draft already
  used, so "use Chabad" would have changed almost nothing — Satmar is the change
  that matters, and it is +22 minutes every single week.**
  ⛔ **72 is the right DEFAULT because it fails in the safe direction:** too late
  and the phone stays closed a few extra minutes on a Saturday night and nobody
  notices; too early and **the phone tells callers the business is open while they
  are still keeping Shabbos.** Earlier opinions are opt-in, per customer.
  ⛔ **It is a halachic setting, not an engineering one** — expose it, never decide
  it. All mockup times recomputed on 72: Rosh Hashanah ends **8:21pm** (was 7:59),
  Yom Kippur **8:07pm**, Simchas Torah **7:45pm**; the RH stretch is **49½ hours**.
- ⛔ **`Tenant` has NO address column, only `timezone`** — so candle-lighting
  times have no lat/long to work from today. The E911 address lives in onboarding
  `answers` and not for every customer. A community/zip picker is the proposed
  answer and is **Izzy's decision**, along with: Shabbos auto-close or holidays
  only; one holiday menu or a greeting per holiday (today `holidayProfileId` is a
  **single** id, so Pesach and Yom Kippur necessarily share a greeting); which
  nightfall minhag (42/50/72 — the mockups use 50); whether it needs its own
  permission key; and whether Chol Hamoed defaults to open, closed or reduced.
- ✅✅ **THE HOLIDAY NAMES ARE DONE AND THEY ARE ASHKENAZI NOW (2026-08-21, Izzy's
  ask): 37 names run through Yiddish Labs English→Yiddish→English, 150 credits.**
  hebcal ships **Israeli** transliterations; the round trip brings them back
  **Ashkenazi**, which is what this customer base reads — Sukkot→**Succos**,
  Shavuot→**Shavuos**, Simchat Torah→**Simchas Torah**, Shmini Atzeret→**Shemini
  Atzeres**, Shabbat→**Shabbos**, Ta'anit Esther→**Taanis Esther**. **28 of 37
  adopted as-is.** Table + verdicts in handoff §7; working data in the scratchpad.
  ⛔⛔ **THE RULE IT EARNED: a machine cannot tell a better spelling from a
  destroyed meaning.** **`Yom Tov` → `יום טוב` → `"Good day"`** — a literally
  correct translation and a completely wrong NAME. My automatic classifier passed
  it, because from the outside it is identical to `Simchat Torah → Simchas
  Torah`: both are just "the string changed". **Adopting a round trip blind would
  have printed "Good day" on the calendar.** 2 rejected (Yom Tov, Nightfall→"At
  dusk"), 7 need review (`Chol Hamoed Pesach`→"The days of…", `Tzom Tammuz`→"The
  Fast of the…", `Erev Shabbat`→"…Kodesh", `Tu BiShvat`→"Chamishah Asar B'Shevat",
  `Ta'anit Bechorot`→תענית **בכורים** where the name is **בכורות**, `Leil
  Selichot`, `Fast day`) — suggestions recorded, **none applied silently**.
  ⛔ **Two mechanical YL artefacts, safe to strip:** it wraps anything it
  transliterated in **markdown underscores** (`_Simchas Torah_` — names it left
  alone come back bare, so the underscores are a reliable "I changed this"
  signal) and sometimes **appends the Hebrew in brackets**. ⛔ **Short proper
  nouns round-trip perfectly; longer/compound names come back as SENTENCES**
  (`די טעג פון…`, `דער תענית…`, `א תענית טאג`) — keep the input to bare names.
- ✅✅ **THE NAMES ARE APPROVED (Izzy, 2026-08-21): *"it looks great … it's
  perfect"*.** Settled as they stand — **Yiddish Labs verbatim on the 28 adopt
  rows, the 9 overrides on the review/reject rows** — and stamped into
  `docs/ai-context/jewish-holiday-names-yiddishlabs-2026-08-21.json` under
  `approval` + a per-row **`final.english` / `final.yiddish`**. ⛔ **Read
  `final.*`; the other fields are the audit trail of how it was reached.**
  ⛔ **A t→s spelling correction was raised and WITHDRAWN — do not re-apply it.**
  It came from reading the table's **first column** (the English that went IN,
  which still says Sukkot / Shavuot / Shabbat because it is the INPUT and the
  lookup key) as though it were the output. **The lesson is about the table, not
  the names: label a before/after column pair by what the reader will SEE, never
  by where the data came from.** The mockup's headers now read "Before — what
  hebcal calls it" and "Yiddish Labs → English — *this is what the screen will
  say*", with the before column greyed and the after column bold.
- ⛔⛔ **THE DISPLAY SETTING: THE WORD CHANGES, THE PAGE DOES NOT** (Izzy, explicit).
  A per-person setting **on the calendar screen — NOT the platform-wide language
  toggle**. The Yiddish name still renders RTL *inside itself*; confine that to
  the word: `<span dir="rtl">שמחת תורה</span>` +
  **`unicode-bidi: isolate`**. ⛔ **`isolate` is load-bearing** — without it the
  bidi algorithm lets the Hebrew reorder its neighbours, so `Succos — 3 days`
  renders with the dash and number in the wrong place. ⛔ **No `dir` attribute on
  ANY ancestor** — one `dir="rtl"` on a parent mirrors the whole page. A name with
  no Yiddish shows **English**, matching `useUiLanguage`'s never-guess rule.
- ⛔⛔ **FOUND IN PASSING AND NOT FIXED: the platform-wide Yiddish toggle ALREADY
  flips the page.** `apps/portal/hooks/useUiLanguage.tsx:127` wraps every child in
  `<div dir={lang === "yi" ? "rtl" : "ltr"}>`, so switching the portal to Yiddish
  today mirrors **billing, workspace, IVR Studio, IVR routing and music-on-hold**
  entirely — exactly what Izzy ruled out. **Deliberately NOT changed: one line,
  five live screens, his call.**
- ⛔ **Driving Yiddish Labs, practical:** **liveness is FREE and CURRENT from
  `AgentAuditLog` where `event = 'yiddishlabs.credit_check'`** (hourly,
  `{"state":"ok"}`) — ⛔ **a better check than the `max("createdAt")` from
  `AgentTranslation`** this file recommends elsewhere, which read "3 days ago"
  while the account was perfectly healthy (nobody had translated anything new;
  absence of translations is not absence of credits). `/agent/ui/translate` is
  **en→yi only** and cache-first — the reverse needs
  `YiddishLabsClient.translate(text, "en")` directly. ⛔ A script must live under
  **`/app/apps/agent/`** to resolve `@connect/security` (`/tmp` and `/app` both
  fail `MODULE_NOT_FOUND`), and ⛔ **`app-agent-1` gets recreated without warning**
  — feed script + input **via stdin per batch** so a restart costs one batch, not
  the run. ~20 s per name, ~4 credits per name for both passes.
- ✅✅ **BUILT END TO END (2026-08-21) — the calendar drives the IVR MENU *and* the
  HOLD MUSIC, and the a cappella switch is in. ⛔ CODE COMPLETE, NOTHING
  DEPLOYED, migration NOT applied, no tenant switched on, nobody has opened the
  screen.** Handoff §9. Izzy: *"build it end to end … wire the IVR, and make it so
  they can set hold music as well. Add in also sphera and the three weeks, nine
  days … The music should change automatically to non-music … basically cappella
  music."*
  **Where it lives:** `packages/shared/src/jewishCalendar/` (table + zmanim +
  resolver + names + communities + view builders), `apps/api/src/jewishCalendarSettings.ts`,
  `apps/portal/app/(platform)/pbx/ivr-studio/JewishCalendar.tsx`, migration
  `20260821140000_tenant_jewish_calendar`.
- ⛔⛔ **ONE ROW, TWO CONSUMERS.** `TenantJewishCalendar` is read by BOTH apps/api
  (which menu callers hear) and apps/worker (which hold-music class plays) — a
  tenant sets its city and minhag ONCE. **Two mappers exist only because the
  worker cannot import from apps/api** (`toJewishCalendarSettings` vs
  `workerJewishSettings`); ⛔ **their defaults must stay identical or the menu and
  the music disagree about what day it is.** A guard pins the worker's nightfall
  fallback to Satmar.
- ✅ **THE IVR SIDE ADDED NO NEW MACHINERY.** `computeCurrentMode` returns
  **`"holiday"`** when the calendar says closed, so `ivrFindActiveProfile`,
  `resolveDidmapProfileId` and the existing `holidayProfileId` already work — **no
  new publish path, no dialplan change, no PBX write.** The 60-second
  `sweepIvrModeBoundaries` flips the live menu at the boundary, which is exactly
  why sunset-accurate closures needed nothing new. ⛔ **ALL FIVE
  `computeCurrentMode` call sites were wired and a test reads `server.ts`'s SOURCE
  to prove it** — every defect of this shape here has been a missed caller.
- ⛔⛔ **THE A CAPPELLA ORDER IS THE FEATURE.** In `workerComputeHoldProfile`:
  **manual override → A CAPPELLA → one-time → holiday → weekly → after-hours →
  default.** A cappella sits ABOVE the schedule on purpose — below it, a one-time
  *"play the Chanukah playlist"* rule would put instrumental music on the line
  during the Nine Days, the exact thing this prevents. Only a live human override
  beats it. ⛔ **With no a cappella profile chosen the music is LEFT ALONE, never
  silenced** — dead air on hold is worse than the wrong music. ⛔ **The Nine Days
  are NESTED inside the Three Weeks**, so a customer keeping only the Nine Days
  still gets them with the Three Weeks off. Sefirah has three minhagim (`early`
  to Lag BaOmer / `late` from Rosh Chodesh Iyar / `whole`).
- ⛔ **FAILS OPEN EVERYWHERE:** disabled, past the table's end, unusable
  coordinates, a DB error, a missing table, a thrown resolver — all yield "not
  closed" and the ordinary weekly hours decide. **A calendar that cannot answer
  must never shut a working business's phone**, and a calendar fault must never
  change what is already playing on hold.
- ⛔⛔ **A BACKTICK INSIDE A `<style jsx global>{…}` BLOCK TERMINATES THE TEMPLATE
  LITERAL — AND COMMENTS ARE NOT EXEMPT.** Ten backticks in a CSS *comment* broke
  `ivr-studio/page.tsx` with 29 parse errors pointing 200 lines further down. Cost
  a full typecheck cycle to find; never use them in a styled-jsx block.
- ⛔ **The generator dropped Purim, Chanukah and Lag BaOmer** on the first cut —
  hebcal flags them `MINOR_HOLIDAY` and it only looked at chag/chol-hamoed/erev/
  fast. **Plenty of these businesses close for Purim, and a customer cannot
  override a day the table never mentions.** Fixed with a `minor` kind, open by
  default, overridable.
- ✅ **Proven as:** shared **442/442**, worker **109/109**, portal **259/261** (the
  two documented pre-existing), api typecheck **75 = the exact baseline** with
  none in an edited file, portal typecheck **0**, and ⛔ **11 source guards ALL
  replayed against `HEAD` and ALL failing there.** Migration DDL generated by
  `prisma migrate diff`, not hand-written; the `tenantJewishCalendar` accessor
  verified against the REAL generated client.
- ✅✅ **DEPLOYED AND VERIFIED 2026-08-21 (handoff §10).** Migration applied
  **13:09:24Z** (23 columns, defaults `enabled=false`/`satmar`/18/`early`,
  **0 rows — nobody switched on, so nothing changed for any customer**); **api**
  container `a9faa821` with `loadJewishCalendar` ×6 / `jewishSweep` ×2 / routes ×4
  grepped inside it; **all three routes answer 200 on production** (60-second
  self-signed SUPER_ADMIN token → `127.0.0.1:3001`); **portal** screen strings
  grepped in the shipped `.next`; **worker** `d24ee0c6` with the precedence read
  line-by-line out of the running container — **override 2862 → acappella 2879 →
  one_time 2889 → holiday 2893 → weekly 2903**, 0 restarts, 0 error lines.
  Live month view: `09-11 Closing early at 5:54pm before Rosh Hashana`,
  `09-12 + 09-13 Closed` (the two-day closure spanning both dates),
  `09-27 Closed` (Sukkos II — one of the five days Israel gets wrong).
- ⛔⛔ **THE RULE THIS BUILD EARNED, AND IT COST TWO REAL BUGS: A GREEN UNIT SUITE
  TELLS YOU THE PARTS WORK, NOT THAT THE DEPLOYED THING IS RIGHT. Probe the live
  route and grep the shipped bundle.** Neither bug was findable from the source.
  **(1) The verdict spoke the RAW hebcal name** — the live route returned a cell
  labelled **Succos** with the verdict beside it reading **"Closed — Sukkot"**,
  because the resolver works in raw table keys and the verdict was built straight
  from `v.reason`, never passing through the approved Yiddish Labs names. Every
  test passed: they asserted the LABEL and never that the verdict agreed with it.
  ⛔ Fixing it correctly broke my own assertion that `en.verdict === yi.verdict` —
  **that assertion was wrong**; the verdict carries the name, so it must change
  with the language. The real invariant is that the FACTS match (date, times,
  treatment, music).
  **(2) 117 KB of holiday table was shipping to every browser** — `sefirahEarly`
  and `Chag HaBanot` both in `.next/static/chunks/6879-*.js`, a **168 KB** shared
  chunk, even though **no portal file imports the calendar at all**.
  `packages/shared` declared no `sideEffects`, so webpack had to assume every
  module might have import-time side effects and could not tree-shake. ⛔ Checked
  the package before annotating — no module-scope calls, no globals, no timers —
  then set **`"sideEffects": false`**, which is correct for a pure utility package
  and shrinks every other consumer too. Both fixes: `6279f187`.
- ⛔⛔ **DEPLOY TRAPS RE-EARNED THE HARD WAY.** **Two of my own watchers stalled in
  the `pgrep` self-match trap this file already documents** — an
  `until ! pgrep -f "deploy-direct.sh"` loop matches its OWN command line and can
  never exit; both had to be killed by PID. ✅ **The fix is to split the literal so
  the waiter's command line does not contain it:**
  `PAT="deploy-""worker.sh"; until ! pgrep -f "$PAT"; do sleep 20; done`.
  ⛔ **Two sessions ran api deploys within a minute on the same branch** — mine won
  the migrate stage then lost the build lock (`HEAVY JOB ALREADY RUNNING`), theirs
  built the tip which contained my commits. Harmless only because it was the same
  branch: **check `ps` for a running `deploy-direct.sh` before starting one.**
  ⛔ **A portal deploy reporting `skip=unrelated_paths` is NOT necessarily wrong** —
  an earlier build may already have carried the commit. **Judge it by grepping the
  container for one of your own STRINGS**, never by the log line.
  ⛔ **An in-container probe script must sit where its imports resolve** — `/tmp`
  and `/app` both fail `MODULE_NOT_FOUND`, and `jsonwebtoken` is not in apps/api's
  deps. Hand-roll the HS256 token with `node:crypto`, or pull ids from psql and use
  a plain `fetch` with no imports at all.

- ⛔⛔ **THE SCREEN SHIPPED WITH BOTH HALVES HIDDEN, AND EVERY CHECK PASSED
  (2026-08-21, handoff §11).** Izzy opened it: *"I don't see anywhere where I can
  set schedules per holiday, and I don't see a calendar."* **Both were there.
  Both were hidden by the BUILD, not the design.** (1) The per-holiday list
  rendered only when `showHolidays` was true, which needed a non-empty
  `holidayOverrides` or a click on the third preset — a fresh calendar has
  neither, so `presetOf()` returned `"standard"` and **the one thing actually
  asked for was invisible on every new calendar**. (2) The month view sat behind a
  plain secondary button in the `foot`, beside Save, when the ask was literally
  *"a button where people can see the calendar view month by month"*.
  ✅ Fixed: the list is **always rendered**, headed **"A schedule for each
  holiday"** (named with the words someone would search for); the calendar is a
  **primary button in the card header**. Commit `05936a00`, **DEPLOYED and
  bundle-verified** (portal `d0e98b96`: both strings present, `showHolidays`
  **0 files**, holiday table still **0** in the client bundle).
  ⛔⛔ **THE RULE: A FEATURE THAT HAS TO BE DISCOVERED IS NOT BUILT.** Typecheck,
  unit tests, container greps and live route probes ALL passed — every one of them
  confirms the code EXISTS, and not one asks whether a person can find it. ⛔ And
  neither bug was in a function: one was a render condition, one was layout. That
  is why the guards in `apps/portal/lib/jewishCalendarVisibility.test.ts` read the
  component's SOURCE and assert **position** — the button sits between
  `jc-headright` and `card-b`, the footer does not contain it, no toggle gates the
  list. All five fail against the version he could not use.
- ⛔⛔ **THE DEPLOY-WAITER SELF-MATCH TRAP BIT A THIRD TIME AND DEFEATED THE
  OBVIOUS WORKAROUND.** Splitting the literal (`PAT="deploy-""direct.sh"`) does
  **NOT** work when the same command line later carries the real
  `bash scripts/deploy-direct.sh …` invocation — pgrep matches THAT and the waiter
  hangs forever (three stuck waiters killed by PID this session, one after 40
  minutes). ✅ **The reliable fix: put the deploy in a FILE and poll the LOG for a
  marker** — `setsid nohup /root/x-deploy.sh > /root/x.log &` then
  `until grep -q "MY_DEPLOY_EXIT=" /root/x.log; do sleep 20; done`. **A waiter that
  greps a file can never match itself.**

- ⏳ **WHAT IS STILL UNPROVEN, HONESTLY: Izzy HAS opened the screen and saved
  (Kiryas Joel, Satmar 72 min, 21 Aug 14:17 — 3× GET 200 + 1× PUT 200 from his own
  IP), so the screen, the community picker, the save, tenant scoping and the audit
  row are all proven by a real person.** ⛔ **NOBODY HAS SWITCHED IT ON** —
  `enabled` is still false on the one row, so it drives nothing; no caller has
  heard a calendar-driven menu and no hold music has switched. ⛔ The a cappella
  track must be created on the existing hold-music screens — this card only PICKS
  from profiles that already exist. The holiday-name language is per-browser
  `localStorage`, not a `User` column. ⛔ **Israel is deliberately unavailable** —
  the table is `il: false` only. ⛔ `reopenNextMorning` is stored and never read.
- ⛔ **(SUPERSEDED by the BUILT section above — kept for the decision history.) NOTHING IS APPROVED AND NOTHING IS BUILT.** When it is: ⛔ the existing
  flat `holidayDates: string[]` must keep working untouched for tenants already
  using it, and ⛔ **publish the mockup-vs-built comparison** before claiming the
  screen matches — the standing rule from the support-console build. Acceptance
  is in §6 of the handoff, and the negative that matters most is that a tenant
  with the Jewish calendar **off** behaves byte-identically to today.
