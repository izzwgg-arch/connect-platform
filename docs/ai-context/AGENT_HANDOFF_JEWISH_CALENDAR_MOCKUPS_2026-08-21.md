# AGENT HANDOFF — the American Jewish calendar in IVR Studio: PLAN + MOCKUPS ONLY, awaiting Izzy's pick (2026-08-21)

⛔⛔ **NOTHING IS BUILT. No code written, no dependency added, no migration, no
deploy, no PBX write, no tenant row touched.** The only artefacts are this
document, a CLAUDE.md section, a memory file, and the published mockups.

**Mockups Izzy is choosing from:**
<https://claude.ai/code/artifact/65ed6be1-6589-41c9-a4e3-9dc9007bac18>

Izzy, 2026-08-21: *"In IVR Studio, I would like to add the Jewish calendar to it.
From now to the end of time, the system should always be updated with an American
Jewish calendar, not Israeli. It's different… The system should always know when
every Jewish holiday is. If somebody says, 'this and this holiday, this is my
schedule,' the system will always know when that holiday is this year… Also make
a button where people can see the calendar view month by month… Show me mockups
before you build anything."*

---

## 1. What exists today (read from the code, not assumed)

| Piece | Where | Shape |
|---|---|---|
| Schedule row | `IvrScheduleConfig` (`packages/db/prisma/schema.prisma:3635`) | one per tenant, `@unique tenantId` |
| Weekly hours | `businessHoursRules` Json | `[{day:0-6, open:"HH:MM", close:"HH:MM"}]` — **one window per weekday** |
| Holidays | `holidayDates` Json | **a flat array of `"YYYY-MM-DD"` strings, typed by hand** |
| Which menu when | `defaultProfileId` / `afterHoursProfileId` / `holidayProfileId` | one menu each; **exactly one holiday menu for every holiday** |
| The decision | `computeCurrentMode()` (`apps/api/src/ivrModeSelection.ts:18`) | `holidays.includes(localDate)` → `"holiday"` |
| The UI | `HoursCard` (`apps/portal/app/(platform)/pbx/ivr-studio/page.tsx:2325`) | a `<input type="date">` + "Add", chips with an × |
| Route | `GET`/`PUT /voice/ivr/schedule` (`apps/api/src/server.ts:24291` / `:24305`) | zod: `holidayDates: z.array(z.string())` |
| The flip | `sweepIvrModeBoundaries()` (`apps/api/src/server.ts:24988`) | **runs on the 60-second DID-switch tick**; republishes only when the computed mode differs from the last successful publish's mode |

⛔ **Nothing in the repo has ever touched a Hebrew date.** Grep for
`hebcal|hebrew|shabbos|zmanim|candle` across the tree returns only Yiddish
*transcription* files and unrelated docs. This is greenfield.

### The three real limitations

1. **Dates go stale.** The stored list is Gregorian. Next year the same strings
   are ordinary weekdays and the phone answers normally on yom tov. Nothing
   warns, nothing errors.
2. **Whole days only.** `includes(localDate)` is midnight→midnight in the tenant
   timezone. It cannot express "closed from 6:54pm Friday to 7:59pm Sunday",
   which is what a yom tov actually is.
3. **One holiday menu.** `holidayProfileId` is a single id, so Pesach and Yom
   Kippur necessarily share a greeting.

✅ **What is already right, and must not be rebuilt:** the 60-second sweep means
**minute-accurate sunset boundaries need no new machinery at all** — only
`computeCurrentMode` has to think in intervals. And the per-number didmap pointer
already resolves *through* the mode (`resolveDidmapProfileId`), so a holiday flip
reaches assigned numbers.

---

## 2. The engine — verified, not assumed

Everything below was **run**, in the session scratchpad, against `@hebcal/core`
6.9.2. No number in the mockups is illustrative.

- The Hebrew calendar is fixed arithmetic (Hillel II) — a **calculation, not a
  feed**. That is what makes "from now to the end of time" literally achievable:
  nothing to renew, no annual update anybody can forget.
- `HebrewCalendar.calendar({ il: false, … })` is the American/diaspora setting.
  `candlelighting: true` + a `Location` yields per-event `eventTime` for candle
  lighting and havdalah; flags carry `CHAG`, `CHOL_HAMOED`, `EREV`,
  `YOM_TOV_ENDS`, `MAJOR_FAST`, `MINOR_FAST`, `LIGHT_CANDLES`.

### ⛔ American vs Israeli — the difference is FIVE WRONGLY-ANSWERED DAYS A YEAR

Computed both ways for Monsey, NY. On `il: true` these days come back as
Chol Hamoed or do not exist, so the phone would answer **normally on yom tov**:

| Date | American (`il: false`) | Israeli (`il: true`) |
|---|---|---|
| Sun 27 Sep 2026 | **Sukkot II — yom tov** | Sukkot II (Chol Hamoed) |
| Sun 4 Oct 2026 | **Simchat Torah — yom tov** | not a separate day |
| Fri 23 Apr 2027 | **Pesach II — yom tov** | Pesach II (Chol Hamoed) |
| Thu 29 Apr 2027 | **Pesach VIII — yom tov** | Pesach ended the day before |
| Sat 12 Jun 2027 | **Shavuot II — yom tov** | Shavuot is one day |

⛔ **One boolean, five wrong days a year, forever, and nothing would ever error.**
Whatever gets built, `il: false` gets its own test with at least these five dates
pinned as fixtures.

### ⛔ A date is not enough — the day turns at sunset

- **Rosh Hashanah 5787** runs candle lighting **Fri 11 Sep 6:54pm** → havdalah
  **Sun 13 Sep 7:59pm** — it falls on Shabbos, so that is **one continuous
  49-hour closure spanning three Gregorian dates**. A whole-day list marks Sat +
  Sun and leaves Friday evening answering normally.
- **Friday candle lighting in Monsey swings 4h 05m across the year**: earliest
  **4:09pm (4 Dec 2026)**, latest **8:14pm (25 Jun 2027)**. There is no single
  Friday closing time that is right. A fixed `close: "17:00"` is 51 minutes late
  in December and 3h 14m early in June.
- The useful rule is therefore not a clock time but **"N minutes before candle
  lighting"**, which the calendar can drive.

---

## 3. ⛔⛔ THE BUILD TRAP — found before writing any code

**`@hebcal/core` is ESM-only from v6, and `apps/api` is CommonJS.**

- `tsconfig.base.json`: `"module": "CommonJS"`, `"moduleResolution": "Node"`.
- `@hebcal/core@6.9.2` `package.json`: `"type": "module"`, **no `main`**, and an
  `exports` map with only an `"import"` condition.
- Proven in the scratchpad: `require('@hebcal/core')` →
  **`ERR_PACKAGE_PATH_NOT_EXPORTED`**.
- Classic `moduleResolution: "Node"` cannot read `exports` at all, so TypeScript
  will not even resolve the types.
- `await import()` does not save it — with `module: CommonJS`, TypeScript
  downlevels `import()` to `require()`.

⛔ **This does not fail at build time. It fails when the API tries to load it —
i.e. a container that will not boot.** That is exactly the `undici` failure this
repo already has a guard test for (`apps/api/src/dependencyHygiene.test.ts`).

### Licences, verified from the npm registry

| Package | Version | Licence |
|---|---|---|
| `@hebcal/core` | 6.9.2 | **GPL-2.0** |
| `@hebcal/hdate` | 0.22.8 | **GPL-2.0** |
| `@hebcal/noaa` | 0.12.3 | LGPL-2.1 |
| `kosher-zmanim` | 0.9.0 | LGPL-3.0 |

GPL-2.0 obligations attach on **distribution**. Running it on our own server to
answer API calls is not distribution (GPL-2.0 has no network clause — that is
AGPL), so server-side use is fine. ⛔ **But it must never be bundled into the
portal's browser bundle or the mobile app** — that *is* distribution and would
oblige us to offer source for the combined work. Compute server-side, ship plain
dates and times to the client. That is the right architecture anyway: the
dialplan decision has to be server-side regardless.

### The two ways through

| Approach | Cost |
|---|---|
| **Pin `@hebcal/core@5.x`** | v5.4.11 ships `main: ./dist/index.cjs`, so `require()` works with no tsconfig change. Freezes us on a superseded major and puts GPL-2.0 code in apps/api. |
| **Generate a table offline, ship data** ✅ **recommended** | Run the calculation once and check in the answer. **Measured: 1,835 rows / 69.5 KB of JSON covering 2026–2076** — every yom tov, chol hamoed, erev and fast day, already flagged diaspora, across 15 distinct holiday names. apps/api imports nothing. Sunset is ~40 lines of standard NOAA astronomy, testable against known times. No dependency, no licence question, no ESM problem, every date auditable. |

The second matches what this codebase already does when it can: hand-rolled
SigV4 rather than the AWS SDK (Polly), hand-rolled HS256 rather than the LiveKit
SDK, a tokeniser inside the component rather than a syntax-highlighting library.
⛔ Regenerating for another fifty years is one command; a guard should alarm when
the table's end is within ~2 years.

**Reproduction of every figure above:** the scratchpad scripts `probe.mjs`,
`probe2.mjs`, `month2.mjs`, `table.mjs`. They are throwaway and were **not**
committed — the numbers are recorded here instead.

---

## 4. The mockups — three options

All three are drawn in the IVR Studio's **own** palette, copied verbatim from
`page.tsx`'s `StudioStyles` (`--panel:#16212e`, `--accent:#3ba0f2`,
`--menu:#a98fe0`, `--vm:#e8a33d`, `--ok:#3ec37e`, radius 16px) so the build is a
**port, not a re-derivation** — the 2026-08-21 support-console lesson.

- **Option A — one switch and a preset.** Toggle, city, calendar (American /
  Israel), and a three-way preset (Standard / Yom tov only / Choose per holiday),
  plus "close early N before candle lighting" and "reopen after yom tov". Four
  answers and it runs itself.
- **Option B — the holiday list.** Every holiday is a row with its own setting
  (Closed all day / Closes early / Normal hours) **and its own menu**, set
  against the **name**; the calendar supplies the dates, read-only, forever. This
  is the literal answer to *"this and this holiday, this is my schedule."*
- **Option C — the calendar view.** Month grid, Hebrew + Gregorian, prev/next,
  click a day → what the phone will actually do and **why**. Live in the mockup
  with real September–November 2026 data for Monsey.

**Recommendation given: they are one screen, not three.** A is the face; B opens
from A's third preset; C ships as the read-only calendar view reachable from
both. Option C *as an editor* was deliberately drawn as a view instead — an
editable calendar invites one-off dates again, which is the habit this replaces.

---

## 5. ⏳ OPEN — Izzy's decisions, none of them made

1. **Shabbos too, or holidays only?** Recommended: yes, as an option. It is
   arguably worth more than the holiday half (the 4-hour candle-lighting swing),
   but it takes over the Friday/Saturday rows customers already set.
2. **One holiday menu or a greeting per holiday?** Recommended one now,
   per-holiday next — the latter needs a schema change. The payoff of naming
   holidays: record *"we're closed for Pesach"* once and it plays on the right
   days every year.
3. ⛔ **Where does the location come from?** **`Tenant` has no address column** —
   only `timezone`. The E911 address exists but lives in onboarding `answers`
   and not for every customer. Recommended: a picker of the communities we serve
   plus a zip fallback. Should sign-up ask for it too?
4. **Which minhag for the times?** 18 min before sunset for candle lighting is
   near-universal in America; nightfall is 42 / 50 / 72 minutes depending on
   community. The mockups use 50. Must be a setting.
5. **Who gets it?** Its own permission key (the voice-changer pattern) or simply
   part of the Studio? Recommended: not gated — nearly every customer here needs
   it.
6. **Chol Hamoed — open, closed or reduced?** The Standard preset guesses
   *reduced hours*. Worth confirming with real customers.

---

## 6. If it is approved — the shape of the work

1. **The calendar source.** Generate + check in the holiday interval table
   (diaspora), plus a small NOAA sunrise/sunset routine. Tests: the five
   diaspora-vs-Israel dates, the 49-hour Rosh Hashanah stretch, the December and
   June Friday extremes.
2. **`computeCurrentMode` learns intervals.** ⛔ The existing flat
   `holidayDates: string[]` must keep working untouched for tenants already using
   it — this repo does not break legacy tenants. The PUT zod schema likewise
   accepts both shapes.
3. **Location on the tenant** + the picker.
4. **The screens**, ported from the mockups.
5. ⛔ **Publish the comparison** before claiming the screen matches the mockup —
   the standing rule from the support-console build.

⏳ **Acceptance, when there is something to accept:** set a tenant to the
Standard preset, then check the calendar view says *Closed — yom tov* on
**Sun 27 Sep 2026** and **Sun 4 Oct 2026** (the two days an Israeli calendar gets
wrong this autumn), and that a real call on erev Shabbos hits the closed menu at
candle lighting minus the configured offset — **not** at a fixed clock time.
⛔ The negative that matters most: a tenant with the Jewish calendar **off** must
behave byte-identically to today.

---

## 7. The holiday NAMES — run through Yiddish Labs both ways (2026-08-21, same day)

Izzy: *"Take all the holidays and, inside Connect, run it through Yiddish Labs to
translate them to Yiddish. Take the Yiddish version and run it again through
Yiddish Labs and translate from Yiddish to English. Take both versions … and use
those as the holiday names. Make it a setting that the person can set if it says
in Yiddish or English, but even if it says in Yiddish, don't flip around the whole
page to go from right to left. Just the actual word should change."*

**Done: 37 names, both passes, against the live account. 150 credits.** Raw
output and verdicts are in the mockups artifact; the working files are in the
session scratchpad (`names-final.json`, `namemap.json`).

### ✅ Why the round trip is a genuinely good idea

hebcal ships **Israeli** transliterations. Sending them out to Yiddish and back
returns **Ashkenazi** ones, which is what this customer base reads:

| hebcal | → Yiddish | → English again |
|---|---|---|
| Sukkot | סוכות | **Succos** |
| Shavuot | שבועות | **Shavuos** |
| Simchat Torah | שמחת תורה | **Simchas Torah** |
| Shmini Atzeret | שמיני עצרת | **Shemini Atzeres** |
| Shabbat | שבת | **Shabbos** |
| Ta'anit Esther | תענית אסתר | **Taanis Esther** |
| Asara B'Tevet | עשרה בטבת | **Asara B'Teves** |

**28 of 37 came back clean and are adopted as-is.**

### ⛔⛔ THE RULE THIS EARNED: a machine cannot tell a better spelling from a destroyed meaning

**`Yom Tov` → `יום טוב` → `"Good day"`.** A literal, correct translation and a
completely wrong *name*. Adopting the round trip blind would have printed
**"Good day"** on the calendar. My automatic classifier passed it — from the
outside it is indistinguishable from `Simchat Torah → Simchas Torah`: both are
just "the string changed". **Every round-tripped name needs a human verdict; the
cleanup that can be automated is only the cosmetic kind.**

**2 rejected, 7 need review** (suggestions recorded, none applied silently):

| Name | YL gave | Use instead | Why |
|---|---|---|---|
| Yom Tov | Good day | **Yom Tov** | ⛔ meaning translated away |
| Nightfall | At dusk / פארנאכטס | **Nightfall** / צאת הכוכבים | ⛔ פארנאכטס is "toward evening", not tzeis |
| Chol Hamoed Pesach | The days of Chol HaMoed Pesach | Chol HaMoed Pesach | די טעג פון = "the days of" |
| Tzom Tammuz | The Fast of the Shiva Asar B'Tammuz | Shiva Asar B'Tammuz | expanded, but landed on the better name |
| Erev Shabbat | Erev Shabbos Kodesh | Erev Shabbos | YL added "Kodesh" |
| Tu BiShvat | Chamishah Asar B'Shevat | Tu B'Shvat | correct but nobody says it |
| Ta'anit Bechorot | תענית **בכורים** | תענית **בכורות** | bikkurim ≠ bechoros; English came back right |
| Leil Selichot | The night of Selichos | Leil Selichos | phrase expansion |

### ⛔ Two mechanical artefacts of the YL text API, safe to strip

1. It wraps anything it transliterated in **markdown underscores** — `_Simchas Torah_`.
   Names it left alone come back bare (`Chanukah`, `Purim`), so the underscores
   are a reliable "I changed this" signal, not noise.
2. It sometimes **appends the Hebrew in brackets** — `Chol HaMoed (חול המועד)`.

Both are cosmetic and stripped in code. ⛔ Nothing that changes a **word** is
stripped automatically.

### ⛔ Longer / compound names get turned into sentences

Short proper nouns round-trip perfectly. Anything longer tends to come back as
prose (`די טעג פון…`, `דער תענית…`, `א תענית טאג`). **Keep the input to bare
names**, and expect compound ones to need review.

### The display setting, and the no-flip rule

- **Its own per-person setting on the calendar screen** — NOT the platform-wide
  language toggle, because that one changes everything else too.
- The Yiddish name still renders right-to-left **inside itself**; the rule is to
  confine that to the word:
  ```html
  <span class="hol-name" dir="rtl">שמחת תורה</span>
  .hol-name { direction: rtl; unicode-bidi: isolate; }
  ```
- ⛔ **`unicode-bidi: isolate` is load-bearing.** Without it the bidi algorithm
  lets the Hebrew reorder its neighbours, so `Succos — 3 days` renders with the
  dash and number in the wrong place.
- ⛔ **No `dir` attribute on any ancestor.** One `dir="rtl"` on a parent mirrors
  the whole page — exactly what Izzy ruled out. The published mockup has **zero**
  `dir=` on any container, asserted.
- A name with no Yiddish shows **English**, matching the existing rule in
  `useUiLanguage`: never a guess.

### ⛔⛔ FOUND IN PASSING: the platform-wide Yiddish toggle ALREADY flips the page

`apps/portal/hooks/useUiLanguage.tsx:127` wraps every child in
`<div dir={lang === "yi" ? "rtl" : "ltr"} …>`. So switching the portal to Yiddish
today mirrors **billing, workspace, IVR Studio, IVR routing and music-on-hold**
entirely. That is the behaviour Izzy just said he does not want — but changing
that one line changes five screens customers already use, so it was **deliberately
NOT touched**. His call, separately from this feature.

### ⛔ Practical notes for the next person who drives Yiddish Labs

- **Liveness, free and current: read `AgentAuditLog` where
  `event = 'yiddishlabs.credit_check'`.** It runs hourly and records
  `{"state":"ok"}`. ⛔ This is a **better check than the `max("createdAt")` from
  `AgentTranslation`** that this file recommends elsewhere — that read "3 days
  ago" while the account was perfectly healthy, because nobody had translated
  anything new. Absence of translations is not absence of credits.
- `/agent/ui/translate` is **en → yi only** and cache-first. The reverse
  direction needs `YiddishLabsClient.translate(text, "en")` directly.
- ⛔ **A script must live under `/app/apps/agent/`** to resolve `@connect/security`
  and `@prisma/client` — `/tmp` and `/app` both fail `MODULE_NOT_FOUND`.
- ⛔ **`app-agent-1` was recreated mid-run**, wiping a `docker cp`'d script. Feed
  the script and its input **via stdin per batch** (`docker exec -i … 'cat > f && tsx f'`)
  so a restart costs one batch, not the run. ~10 s per call, so ~20 s per name —
  batch 6 at a time and keep each exec under the tool timeout.
- Cost: **~4 credits per name** for both passes (1–3 per call, longer names cost more).

---

## 8. Whose times — SATMAR, 72 minutes (Izzy, 2026-08-21)

Izzy: *"use Chabad calendar USA"* then, moments later, *"if you can find Satmar
even better."* Satmar it is, and it resolved decision §5.4.

### ⛔⛔ "Use the Satmar calendar" is NOT a different calendar — it is one number

**The dates are identical on every calendar.** Rosh Hashanah 5787 is 12–13
September 2026 on a Satmar luach, a Chabad calendar, an Artscroll luach and
hebcal alike. The Hebrew calendar is arithmetic, not opinion; nobody publishes a
different version of it. ⛔ **So do not go looking for a Satmar data source —
there is no public Satmar API or feed, and none is needed.**

What genuinely differs is **nightfall** — when Shabbos and yom tov end, i.e. when
the phone reopens. hebcal exposes exactly that as `havdalahMins` /
`havdalahDeg`, so the whole question is a per-customer setting.

### The measured difference — 22 minutes, every week

Computed for Monsey (Kiryas Joel and Williamsburg land within a minute or two):

| Whose | Reckoning | Fri 4 Dec 2026 | Fri 25 Jun 2027 | vs Satmar |
|---|---|---|---|---|
| **Satmar / Kiryas Joel** | **fixed 72 min after sunset (Rabbeinu Tam)** | **5:40pm** | **9:45pm** | — |
| Chabad | 8.5° below horizon | 5:13pm | 9:24pm | 21–27 min earlier |
| R' Moshe / common US | 50 min | 5:18pm | 9:23pm | 22 min earlier |
| Three medium stars | 42 min | 5:10pm | 9:15pm | 30 min earlier |

**Candle lighting is 18 minutes before sunset on all four** — that part is not in
dispute, and no evidence was found that Satmar differs on it.

⛔ **Chabad ≈ what the first draft already had.** Chabad's 8.5° lands within about
five minutes of 50 minutes, so "use Chabad" would have changed almost nothing.
**Satmar is the change that matters.**

Sources for the Satmar practice (searched, not assumed): Satmar/Kiryas Joel keep
a **fixed 72 minutes**, publicly emphasised by the Satmar Rebbe; 72 min is
documented as standard Chasidic/Charedi practice. Chabad publishes 8.5° as its
own method.

### ⛔ Why 72 is the right DEFAULT regardless of who the customer is

**It fails in the safe direction.** Set nightfall later than a customer actually
holds and the phone stays closed a few extra minutes on a Saturday night — nobody
notices. Set it earlier and **the phone tells callers the business is open while
they are still keeping Shabbos.** For this customer base only one of those is
acceptable. So 72 is the default and the earlier opinions are opt-in.

⛔ **This is a halachic setting, not an engineering one.** The numbers above are
measured and the sources are cited, but which opinion a given business holds is
theirs (and their rav's) to state — the product must expose it, never decide it.

### What changed in the mockups

Everything recomputed on 72 minutes. Rosh Hashanah now ends **8:21pm** (was
7:59pm), Yom Kippur **8:07pm**, Sukkos **7:57pm**, Simchas Torah **7:45pm**,
Pesach VIII **9:03pm**, Shavuos **9:41pm**. The Rosh Hashanah stretch is
**49½ hours**. Handoff §5 decision 4 is now **answered**; the setting stays
per-customer because a Chabad business on the same street wants 8.5°.

---

## 9. BUILT (2026-08-21) — the calendar drives the IVR *and* the hold music

Izzy: *"go ahead and build it end to end. Put it in the IVR Studio and wire the
IVR, and make it so they can set hold music as well. Add in also sphera and the
three weeks, nine days … The music should change automatically to non-music …
it's basically cappella music."*

⛔ **Everything below is CODE COMPLETE and TESTED, and NOTHING IS DEPLOYED yet.**
No migration has been applied to production, no tenant has the calendar switched
on, and nobody has opened the screen.

### The shape

| Piece | Where |
|---|---|
| Holiday table (generated data, 2,870 rows / 117 KB, 2026–2081) | `packages/shared/src/jewishCalendar/holidayTable.json` |
| The generator (offline, the ONLY hebcal user) | `scripts/jewish-calendar/generate-table.mjs` |
| Sunset / nightfall (hand-rolled NOAA) | `packages/shared/src/jewishCalendar/zmanim.ts` |
| The resolver — intervals, closures, music periods | `packages/shared/src/jewishCalendar/jewishCalendar.ts` |
| Approved Yiddish/English names | `packages/shared/src/jewishCalendar/holidayNames.ts` |
| Community list (diaspora only) | `packages/shared/src/jewishCalendar/communities.ts` |
| Month grid + holiday list builders | `packages/shared/src/jewishCalendar/calendarView.ts` |
| Row → settings, and the loader | `apps/api/src/jewishCalendarSettings.ts` |
| IVR decision | `apps/api/src/ivrModeSelection.ts` — `computeCurrentMode(…, jewish)` |
| Routes | `GET`/`PUT /voice/jewish-calendar`, `GET …/month`, `GET …/holidays` |
| Hold music | `apps/worker/src/main.ts` — `workerComputeHoldProfile(…, jewishHold)` |
| The screen | `apps/portal/app/(platform)/pbx/ivr-studio/JewishCalendar.tsx` |
| Schema | `TenantJewishCalendar`, migration `20260821140000_tenant_jewish_calendar` |

### ⛔ ONE ROW, TWO CONSUMERS — that is the design

`TenantJewishCalendar` is read by BOTH `apps/api` (which menu callers hear) and
`apps/worker` (which hold-music class plays). A tenant sets its city and its
minhag **once**. Two mappers exist (`toJewishCalendarSettings` in api,
`workerJewishSettings` in the worker) only because the worker cannot import from
apps/api — ⛔ **their defaults must stay identical or the menu and the music
disagree about what day it is.** A guard test pins the worker's nightfall
fallback to Satmar.

### ⛔ THE IVR SIDE REUSES THE EXISTING HOLIDAY MACHINERY

`computeCurrentMode` returns **`"holiday"`** when the calendar says closed, so
everything downstream — `ivrFindActiveProfile`, `resolveDidmapProfileId`, the
existing `holidayProfileId` — already works. **No new publish path, no new
dialplan, no PBX change.** The 60-second `sweepIvrModeBoundaries` flips the live
menu at the boundary, which is why sunset-accurate closures need nothing new.

⛔ **All five `computeCurrentMode` call sites were wired, and a test reads
server.ts's SOURCE to prove it.** Every defect of this shape in this repo has
been a caller that was missed — the two IVR publish paths, the two SMS ingest
paths, the two invite paths. A unit test passes straight through that.

### ⛔ THE A CAPPELLA SWITCH, AND WHY THE ORDER IS THE FEATURE

In `workerComputeHoldProfile` the precedence is now:

1. **manual override** — a person choosing right now; they can see what day it is
2. **a cappella** — Sefirah / Three Weeks / Nine Days
3. one-time rule → holiday → weekly → after-hours → default

⛔ **A cappella sits ABOVE the schedule deliberately.** Below it, a one-time
"play the Chanukah playlist" rule would put instrumental music on the line during
the Nine Days, which is the exact thing this exists to prevent.

⛔ **With no a cappella profile chosen, the music is LEFT ALONE** — not silenced.
A customer who has not picked one has not asked for anything, and dead air on
hold is worse than the wrong music. The branch requires the calendar enabled AND
a profile chosen; a guard test pins both.

⛔ **The Nine Days are nested inside the Three Weeks**, so a customer who keeps
only the Nine Days still gets them with the Three Weeks switched off. Sefirah has
three minhagim (`early` to Lag BaOmer, `late` from Rosh Chodesh Iyar, `whole`).

### ⛔ FAILS OPEN EVERYWHERE

Disabled, past the end of the table, unusable coordinates, a database error, a
missing table, a thrown resolver — every one of them yields "not closed" and the
ordinary weekly hours decide. **A calendar that cannot answer must never shut a
working business's phone**, and a calendar fault must never change what is
already playing on hold.

### Two bugs found while building, both worth carrying

1. ⛔ **The generator dropped Purim, Chanukah and Lag BaOmer entirely.** hebcal
   flags them `MINOR_HOLIDAY`, and the first cut only looked at
   chag/chol-hamoed/erev/fast. Plenty of these businesses close for Purim, and a
   customer cannot override a day the table never mentions. Fixed; the table now
   carries a `minor` kind, open by default and overridable.
2. ⛔⛔ **A BACKTICK INSIDE A `<style jsx global>{\`…\`}` BLOCK TERMINATES THE
   TEMPLATE LITERAL.** Ten of them, in a CSS *comment*, broke `page.tsx` with 29
   parse errors that pointed at lines 200 further down. Comments are not exempt.

### Proven as

- **shared 442/442**, **worker 109/109**, **portal 259/261** (the two documented
  pre-existing failures), api suite at its baseline.
- **api typecheck 75 errors — the exact baseline**, none in an edited file.
  **portal typecheck 0.**
- **11 source guards, ALL replayed against `HEAD` and ALL failing there.**
- Migration DDL generated by `prisma migrate diff`, not hand-written; the
  `tenantJewishCalendar` accessor verified against the REAL generated client.

### ⏳ NOT DONE / NOT PROVEN

- ⛔ **Nothing is deployed and the migration has NOT been applied.** No tenant has
  `enabled: true`, so applying it changes nothing for anybody until someone
  switches it on.
- **Nobody has opened the screen in a browser**, and no caller has heard a
  calendar-driven menu.
- **The a cappella profile has to be created on the existing hold-music screens**
  — this card only picks from profiles that already exist. There is no upload
  flow here.
- **The holiday-name language is per-browser (`localStorage`), not per-user in the
  database.** A cross-device setting needs a `User` column; flagged rather than
  built, because the existing `uiLanguage` flips the whole page.
- **Israel is deliberately unavailable.** The table is `il: false` only; an
  Israeli tenant needs its own generated table before a city can be offered.
- ⏳ **Acceptance, when it deploys:** switch it on for one tenant, set the
  community, and check the calendar view says *Closed — yom tov* on **Sun 27 Sep
  2026** and **Sun 4 Oct 2026**. Then the negative that matters most: a tenant
  with the calendar **off** must behave byte-identically to today.

### ⚠️ Two loose ends recorded rather than quietly left

**1. `reopenNextMorning` is stored and NOT read.** It is on the model, in the
settings type and in the zod schema, and nothing consults it — because the
behaviour it describes already happens for free. Once the closure ends at
nightfall the calendar says "not closed" and the tenant's ordinary weekly hours
take over, which at 8:21pm means the after-hours menu until morning anyway. The
field would only matter if we wanted the HOLIDAY menu to keep playing until the
next morning instead of the after-hours one — a real distinction, but nobody
asked for it. ⛔ Left in place rather than dropped, because removing a column
costs a second migration for no behavioural gain; **do not wire it without
deciding what it should actually do.**

**2. The 117 KB holiday table may be reaching the browser bundle.**
`packages/shared/package.json` does **not** declare `"sideEffects": false`, so
webpack must assume every module in the package has import-time side effects and
will not tree-shake `holidayTable.json` out of any portal chunk that imports
`@connect/shared`. The Studio's own `JewishCalendar.tsx` does **not** import
shared — it only calls the API — but several other portal pages do.

⛔ **Not fixed, because it cannot be verified without a build, and an unmeasured
bundler change is exactly the kind that bites.** The decisive check costs one
command after a portal deploy:

```
docker exec app-portal-1 sh -lc 'grep -rl "sefirahEarly" /app/apps/portal/.next/static 2>/dev/null | head'
```

A hit means the table is shipping to browsers. The fix is then either
`"sideEffects": false` on the shared package (correct for a pure utility package,
and it would shrink every other consumer too) or moving the calendar exports off
the shared ROOT index onto a subpath. **Measure before and after either way.**

---

## 10. DEPLOYED (2026-08-21) — and the two bugs only a live probe found

### What is live, and how each was proven

| Piece | Proof |
|---|---|
| Migration | `_prisma_migrations` row `finished_at` **13:09:24Z**, `rolled_back_at` null, **23 columns**, defaults `enabled=false` / `satmar` / `18` / `early`, **0 rows** |
| api | container `.build-commit` `a9faa821`; `loadJewishCalendar` ×6, `jewishSweep` ×2, `voice/jewish-calendar` ×4 grepped **inside the running container** |
| Routes | all three answer **200 on production** via a 60-second self-signed SUPER_ADMIN token against `127.0.0.1:3001` |
| portal | four of the screen's own **strings** grepped in the shipped `.next` |
| worker | `jewishHold` ×4, `workerJewishSettings` ×2, `acappella` ×7; **precedence read line-by-line out of the running container**: override 2862 → **acappella 2879** → one_time 2889 → holiday 2893 → weekly 2903; 0 restarts, 0 error-level lines |

Live month view for Loopcom Demo, September 2026:
```
2026-09-11  Closing early at 5:54pm before Rosh Hashana
2026-09-12  Closed
2026-09-13  Closed          <- the two-day closure, both dates
2026-09-27  Closed          <- Sukkos II, one of the five days Israel gets wrong
holidays (lang=yi): ראש השנה · צום גדליה · יום כיפור · סוכות
```

### ⛔⛔ BUG 1 — the verdict spoke the RAW hebcal name

The live route returned a cell labelled **Succos** with the verdict beside it
reading **"Closed — Sukkot"**. The resolver works in the table's raw keys and the
verdict was built straight from `v.reason`, so it never passed through the
approved Yiddish Labs names. **Every unit test passed** — they asserted the label,
never that the verdict agreed with it.

Fixed with a `localise()` in `buildMonthView`, and a guard that fails if a raw
name reaches the screen. ⛔ It correctly broke an earlier assertion of mine that
`en[i].verdict === yi[i].verdict` — that assertion was **wrong**: the verdict
carries the holiday name, so it must change with the language. The real invariant
is that the FACTS match, and the test now asserts date, times, treatment and music
are identical while letting the names differ.

### ⛔⛔ BUG 2 — 117 KB of holiday table was shipping to every browser

Suspected earlier, then **measured**: `sefirahEarly` and `Chag HaBanot` both
appear in `/app/apps/portal/.next/static/chunks/6879-*.js`, a **168 KB** shared
chunk. `packages/shared` declared no `sideEffects`, so webpack had to assume every
module in it might have import-time side effects and could not tree-shake the
JSON out — even though **no portal file imports the calendar at all**.

Checked before annotating rather than assuming: no module-scope calls, no globals,
no timers anywhere in the package (the single `console.error` is inside a function
body). `"sideEffects": false` added, which is the correct annotation for a pure
utility package and shrinks every other consumer too.

⛔ **The rule both of these earn: a green unit suite tells you the parts work, not
that the deployed thing is right. Probe the live route and grep the shipped
bundle.** Neither bug was findable from the source.

### ⛔ Deploy notes worth carrying

- **Two sessions ran api deploys within a minute of each other on the same branch.**
  Mine won the migrate stage and then lost the build lock
  (`HEAVY JOB ALREADY RUNNING`); theirs built the tip, which contained my commits.
  No harm, because it was the same branch — but **check `ps` for a running
  `deploy-direct.sh` before starting one.**
- ⛔⛔ **Two of my own watchers stalled in the `pgrep` self-match trap this file
  already documents** — an `until ! pgrep -f "deploy-direct.sh"` loop matches its
  OWN command line and can never exit. Both had to be killed by PID. **The fix is
  to split the literal so the waiter's command line does not contain it:**
  `PAT="deploy-""worker.sh"; until ! pgrep -f "$PAT"; do sleep 20; done`.
- A portal deploy reporting `skip=unrelated_paths` is **not** necessarily wrong —
  an earlier build may already have picked the commit up. ⛔ **Judge it by grepping
  the container for one of your own STRINGS**, never by the log line.
- ⛔ `deploy-direct.sh` cannot deploy the worker. It is
  `DEPLOY_BRANCH=… DEPLOY_FORCE_RESTART=1 bash scripts/deploy-worker.sh`, and the
  worker has **no `/app/.build-commit`** — grep a marker string instead.
- ⛔ An in-container probe script must sit under a package that can resolve its
  imports. `/tmp` and `/app` both fail `MODULE_NOT_FOUND`; `jsonwebtoken` is not
  in apps/api's deps either — hand-roll the HS256 token with `node:crypto`, or
  pull the ids from psql and use a plain `fetch` with no imports at all.

---

## 11. ⛔⛔ THE SCREEN SHIPPED WITH BOTH HALVES HIDDEN (2026-08-21)

Izzy opened the built screen and said: *"I don't see anywhere where I can set
schedules per holiday, and I don't see a calendar."*

**Both were there. Both were hidden, and both by the build rather than the
design.**

1. **The per-holiday list rendered only when `showHolidays` was true**, and that
   needed either a non-empty `holidayOverrides` or a click on the third preset.
   A fresh calendar has neither, so `presetOf()` returned `"standard"` and the
   list never appeared. **The single thing that was actually asked for — set it
   against the HOLIDAY and let the dates move themselves — was invisible on every
   new calendar.**
2. **The month view was behind a plain secondary button in the `foot`**, beside
   Save, where it reads as an afterthought. The ask was literally *"a button
   where people can see the calendar view month by month"*.

✅ **Fixed:** the list is **always rendered**, headed **"A schedule for each
holiday"** (named with the words someone would search for), and the calendar is a
**primary button in the card header**.

⛔ **THE RULE: a feature that has to be discovered is not built.** Both mockups
drew these as prominent sections; the build buried them and every check I ran —
typecheck, unit tests, container greps, live route probes — passed, because all
of them confirm the code EXISTS. None of them asks whether a person can find it.

⛔ **Neither bug was in a function.** One was a render condition, one was layout.
That is why the five guards in `apps/portal/lib/jewishCalendarVisibility.test.ts`
read the component's SOURCE and assert *position* — that the button sits between
`jc-headright` and `card-b`, that the footer does not contain it, that no toggle
gates the list. All five fail against the version Izzy could not use.

⛔ **And the deploy waiter trap bit a THIRD time, defeating my own workaround.**
Splitting the literal (`PAT="deploy-""direct.sh"`) does **not** work when the same
command line later contains the real `bash scripts/deploy-direct.sh …`
invocation — pgrep matches that instead, and the waiter hangs forever. ✅ **The
reliable fix is to put the deploy in a FILE and poll the LOG for a marker:**

```
cat > /root/x-deploy.sh <<"SH"
#!/usr/bin/env bash
cd /opt/connectcomms/app || exit 1
bash scripts/deploy-direct.sh portal --branch <branch>
echo "MY_DEPLOY_EXIT=$?"
SH
chmod +x /root/x-deploy.sh
setsid nohup /root/x-deploy.sh > /root/x.log 2>&1 < /dev/null & disown
# then: until grep -q "MY_DEPLOY_EXIT=" /root/x.log; do sleep 20; done
```

A waiter that greps a **file** can never match itself.

### ✅ The fix is DEPLOYED, and the whole feature RE-VERIFIED two days on

Portal `d0e98b96` carried it, confirmed by grepping the shipped bundle rather
than by the deploy's exit line: *A schedule for each holiday* ✓, *See the
calendar* ✓, `jc-calbtn` ✓, **`showHolidays` gone (0 files)** ✓, and the holiday
table **still out of the client bundle** ✓.

**Re-verified live 2026-08-23** — two days and many other sessions' deploys later,
on api `ed81e9f4` / portal `4972f0c8`:

```
api      loadJewishCalendar 6 | jewishSweep 2 | routes 4
worker   override 2862 → acappella 2879 → one_time 2889     (still above the schedule)
portal   both once-hidden halves present; showHolidays 0; table in client bundle 0
row      Connect Communications | enabled=f | kiryas-joel | satmar
```

⛔ **Still `enabled = false`. Nobody has switched it on**, so it drives no menu and
no hold music. That remains the one unproven step, and it is a decision rather
than a task.
