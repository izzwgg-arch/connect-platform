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
