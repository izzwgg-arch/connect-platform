# Handoff — IVR migration, Studio rebuild, Yiddish interface (2026-08-03/04)

> **⛔ IVR RUNTIME SUPERSEDED — read `AGENT_HANDOFF_IVR_RUNTIME_2026-08-06.md`
> before trusting anything here about what callers hear.** On 2026-08-06 the
> runtime was found to IGNORE a number's assigned menu entirely (it played one
> tenant-global menu), publishing never copied recordings to the PBX, and a
> publish reported success before Asterisk applied it. The Studio/scheduling
> design notes below still stand; the "what happens on a call" half did not.

Branch `feat/ai-agent`. Everything below is deployed to production unless
marked otherwise.

## 1. IVR migration — taking menus off the PBX

VitalPBX has **no REST API for IVRs**, so the whole call flow is read from the
`ombutel` MySQL: `ombu_inbound_routes → ombu_destinations →
ombu_destinations_category → ombu_modules` decodes a destination's TYPE, and
`ombu_destinations.index` is the target's ROW id (never the dialled number —
`extension_id 3` dials `108`). New helper action `POST /flow-map` returns the
whole graph per tenant; it needed two extra SELECT grants
(`ombu_time_groups`, `ombu_time_groups_schedules`).

**Menu-at-a-time migration is safe** because anything not yet taken over is
referenced straight back into VitalPBX's own dialplan:
`Goto(T<t>_app-ivr,IVR-<id>,1)` and `Goto(T<t>_app-time-condition,TC-<id>,1)`,
both verified live. A half-migrated tenant is not a broken tenant.

`apps/api/src/ivrMigration.ts` (35 tests) translates a PBX menu into Connect
rows. It never guesses: an unresolvable destination is reported by name.

Screens: **PBX → IVR Migration** lists all 44 menus across 17 tenants with
status (on the PBX / copied / live), a full pre-flight preview, and Go live /
Back to PBX which reuse the existing DID switch endpoints.

**A plus center is copied** (Home Main + A plus main + After hours main, hours
Sun 11–5 and Mon–Thu 9:30–5). Both DIDs are still `routingMode=pbx` — the
flip is deliberately NOT done.

## 2. IVR Studio rebuild

The map is the page; four plain choices (a person / a team / voicemail /
another menu / hang up) instead of nine dialplan concepts; every choice reads
itself back before saving; menus can be created and renamed; opening hours.

Wording and dialplan refs both live in `packages/shared/src/ivrPlainLanguage.ts`
so the **assistant and the screen can never drift**. `GET /voice/ivr/explain`
returns the same sentences the screen shows, plus a review link.
`POST /voice/ivr/menus/build` lets the assistant build a whole menu — it takes
INTENT ("key 1 → person, ext 101"), never a dialplan ref, so it structurally
cannot invent a destination. **It never publishes.**

## 3. Yiddish interface

**Yiddish Labs DOES translate** (`/process/text`, `action: translate-yiddish`).
Its key is NOT in env — the env value is a placeholder; the real key is
encrypted in the `AgentSecret` table. See
[[yiddish-labs-real-capabilities]] in memory.

Chain: wizard question → `Tenant.yiddishEnabled` → `can_use_yiddish` →
`User.uiLanguage` → toggle in the Topbar (every screen) → `useUiLanguage()`
batches a screen's phrases into one cache-only call → assistant reads the same
preference.

`POST /agent/ui/translate` (internal) ← `POST /ui/translate` (permission
checked). Results are PINNED in the cache the chat bridge already uses. **A
page load never warms** — cache-only, ~60ms. Untranslated phrases render in
**English**, never a guess.

142 phrases warmed (all sidebar labels + Studio vocabulary). `NAV_PHRASES` is
generated from `navConfig` so a new nav item can't ship untranslated.

Enabled on the two Connect Communications tenants only; all 46 customers
untouched.

## 4. Teams (ring groups + queues) — PARTLY BUILT

No API for ring groups; queue REST create is untrustworthy. Both go through the
panel robot. Contract captured from Izzy's own session:
`docs/ai-context/PBX_PANEL_RING_GROUP_QUEUE_CONTRACT.md`.

Built: `packages/shared/src/teamNumbering.ts` (800s/900s allocator, 10 tests),
`apps/api/src/pbx/teamBuilder.ts` (createRingGroup / createQueue),
`GET /voice/teams/next-number`.

**Not built yet:** the create-a-team UI, the POST endpoint that runs the
builder, and the queue **callback** (that panel screen was never recorded).

## Traps that cost real time — do not repeat

- **Panel saves are `multipart/form-data`.** A url-encoded-only recorder stores
  `"[object FormData]"` and loses the entire payload.
- **An unchecked checkbox must be OMITTED.** Sending `foo=no` CHECKS it.
- **`ext-local` does not exist on this PBX.** Voicemail is
  `sub-extensions-vm,VM|VMB|VMU-<ext>,1`. The old form silently dropped callers
  out of the dialplan.
- **`/voice/pbx/ring-groups` answers 200 with `rows: []` + `skipReason`** when
  it can't read the PBX — a soft failure shaped like success.
- **A cross-tenant screen must resolve the destination server-side.** The copy
  button briefly used the tenant switcher's id and would have filed one
  customer's menus into another customer's account.
- **A React provider whose `children` is a stable element does not re-render
  its tree.** Arriving translations were invisible until the context value
  itself changed.
- **NEVER fire `generateConfigurations`** (Apply Changes). It regenerates the
  whole PBX and is Izzy's click.

## Open items

1. Yiddish Labs credits ran to **−4** mid-session; topped up. Same account
   funds Yiddish call transcription, which was therefore silently failing too —
   worth checking how long.
2. Record the queue **callback** screen.
3. `one_by_one` was never captured (only `ringall`); the literal is known from
   the DB but the first robot run should verify it.
4. Billing/workspace string coverage for Yiddish.
5. The A plus center **go-live flip on 8457823064** is still pending Izzy.

---

# Session 2 — post-payment flow, ElevenLabs, team builder (2026-08-04, later)

## What shipped

**The gap after paying.** A customer who had just handed over a card sat on a
static thank-you page with no idea whether anything was happening, then landed
in the full IVR Studio — a screen built for someone who already knows what an
IVR is.

- `GET /onboarding/:token/progress` returns named build stages (paid, number,
  extensions, invites) plus `current` / `built` / `failed`.
- `apps/portal/app/onboarding/[token]/success/page.tsx` polls it every 4s and
  ticks each stage off. On failure it leads with "your payment went through and
  your number is safe", because that is the only thing the customer is actually
  worried about at that moment.
- It hands to `/pbx/ivr-studio?firstrun=1`.

**`FirstRunSetup.tsx` — the five questions.** What callers hear first, who
answers, what happens if nobody picks up, opening hours, then a plain-English
read-back before anything is turned on. One question per screen; skippable on
every screen; **nothing is written until the last screen**, so backing out
leaves no debris. It builds through the same `/voice/ivr/menus/build` the
assistant uses — there is no second, lesser way to make a menu.

**ElevenLabs — generating a greeting instead of recording one.**
- `apps/api/src/voice/elevenLabs.ts` — TTS client. Asks for **`pcm_8000`**,
  which is the native rate of the phone network, and writes the WAV header
  itself, so at that rate there is **no conversion step at all**. Plans without
  8 kHz fall back to `pcm_16000` + one ffmpeg downsample rather than failing.
- `elevenLabsKey.ts` — reads the key the agent stored in `AgentSecret`
  (both processes share `CREDENTIALS_MASTER_KEY` and the database). The env
  fallback rejects placeholders, exactly as the agent's SecretStore does; if
  the two ever disagree the feature is on in one process and off in the other.
- `elevenLabsRoutes.ts` — `/voice/elevenlabs/status`, `/voices`, `/preview`
  (saves nothing — audition freely), and `/voice/ivr/prompts/generate` which
  reuses the whole existing upload pipeline: store tenant-scoped → push to the
  PBX helper → record sync status on the catalog row.
- Defaults are tuned for a menu, not an audiobook: stability .75, style 0,
  speed .95. Those knobs live behind "Advanced".
- **Generated audio is play-only.** `source: "generated"` on the row drives it:
  no download button, `Content-Disposition: inline`, `Cache-Control: no-store`
  on both send paths of the stream route. Honest limit — anything that plays in
  a browser can be captured; this removes the ordinary way a file walks out.

**`MakeTeam.tsx` + `POST /voice/teams` — ring groups and waiting lines.**
The panel contract and the number allocator already existed; nothing could
reach them. The UI never asks "ring group or queue" — it asks what should
happen to the caller. Members are drag-ordered (that order IS the ring order
for `one_by_one`), with arrow buttons alongside so it works on a phone and with
a keyboard. Server side, members arrive as extension NUMBERS and are resolved
to row ids against **one** live read that also supplies the free-number picture
and the tenant path. An unknown extension refuses the whole request rather than
creating a team that silently rings nobody.

**Yiddish.** 174 new phrases warmed through Yiddish Labs (0 failures) across
the three new Studio screens and the billing workspace, which now carries the
toggle. Amounts, dates, invoice numbers and tenant names are never sent — they
are the customer's data, not interface wording.

## Traps found this session

- **Writing a file non-atomically truncated it to zero bytes** when the write
  threw mid-way (a surrogate pair in the content). Every scripted edit now
  writes `<file>.tmp` and `os.replace`s it. Recovered from git.
- **`teams.map((t) => …)` shadows the translator `t`** and would have silently
  left that whole branch in English. Any file using `useUiLanguage` must not
  bind `t` as a callback parameter.
- **A phrase handed to `t()` but missing from that file's `PHRASES` list is
  never fetched** and stays English forever. `scratchpad/checkphrases.py`
  compares the two; run it after touching either.
- **`deploy-direct.sh` serialises on a heavy-job lock.** Firing a second deploy
  while one is building fails with `HEAVY JOB ALREADY RUNNING`, not a queue.
  Wait on `pgrep -f 'deploy-direct.sh <app>'` first.
- **An import of a package apps/api does not DECLARE kills the container on
  boot, and only once something reaches the file.** `pbx/teamBuilder.ts`
  imported `FormData` from `undici` — fine for months because nothing in the
  running server touched it; the moment a route registered it the API died on
  `Cannot find module 'undici'` and blue/green refused to cut over (live
  traffic was never affected). `tsc --noEmit` cannot see this: it resolves
  types, not runtime installs. Neither can `require.resolve` locally — the dev
  machine's pnpm store hoists `undici` and resolves it happily; the container's
  layout does not. Guarded now by `apps/api/src/dependencyHygiene.test.ts`.
- **`packages/shared` tests run under `tsx --test`, not vitest.** `npx vitest
  run` there reports "No test suite found" for all 43 files, which looks like a
  catastrophe and is nothing. Use `npm test` (235 tests; the single
  `can_view_admin_roles` failure is pre-existing).

## Still open

1. Record the queue **callback** screen (Izzy pinned it).
2. ~~`one_by_one` was never captured.~~ **Verified 2026-08-04** by a read-only
   query on the PBX: `SELECT DISTINCT strategy FROM ombutel.ombu_ring_groups`
   returns exactly `one_by_one` and `ringall`, both written by the panel itself
   on real ring groups. The column is a plain `varchar(255)`, not an enum, so
   those two are what the panel uses rather than what it merely permits. The
   Studio offers both.
3. Yiddish on the **workspace** pages (dashboard, calls, voicemail, chat, SMS).
   Their text lives in shared components rather than the page files, so it is a
   component-library pass, not a page pass. The older `/pbx` screens (IVR
   Builder, queues, ring-groups, MOH scheduling) are deliberately NOT in scope:
   they are ops screens full of PBX jargon and superseded for customers by the
   Studio.
4. The A Plus Center **go-live flip on 8457823064** is still pending Izzy.
5. A **test card transaction** through the new payment gate — Izzy's to do; an
   agent must never enter card details.

---

# Session 3 — number↔menu scheduling + pre-menu announcements (2026-08-04, later)

## What shipped (commit 0322728b)

**The Studio's top step is now the DID control.** Pick which number rings the
menu (each row states what the number does RIGHT NOW), or "No phone number"
for sub-menus. Timing is exactly two options on Izzy's instruction — start
right now, or a date and time — with an end of "never" or "on a date".

**Key architecture — the scheduler does NOT reimplement the flip.**
`didSwitchSchedule.ts` mints a short-lived SUPER_ADMIN service JWT
(`app.jwt.sign`, sub `scheduler:<id>`) and drives the EXISTING
`/voice/did/:id/switch-to-connect` / `switch-to-pbx` routes via `app.inject`
— an in-process request, no network. One code path for manual and scheduled
flips. "Right now" is held client-side and executes inside publish() right
after `/voice/ivr/publish` succeeds; the button reads "Publish and switch
(845) …". Dated switches are booked server-side (`DidSwitchSchedule` table)
and executed by a 60s tick; failures alert ADMIN_ALERT_EMAIL and retry for 30
minutes, then mark failed. A failed HAND-BACK leaves the number on Connect
(the direction that keeps answering calls) — deliberate.

**Announcements** (`IvrAnnouncementSchedule`): a recording played before the
menu, bookable start/stop. Runtime = one AstDB key
`connect/t_<slug>/pre_announce` set/cleared via `publishToAstDb`. ⛔ **The
dialplan does not read that key yet.** The patch is committed at
`scripts/pbx/patch-connect-ivr-pre-announce.sh` (backup + idempotence +
verify + reload, plays via Playback once per call before the `(prompt)`
label) and MUST NOT be run without Izzy's explicit go — PBX hard guardrail.
Until then announcements are booked and keys written but callers hear
nothing: the intended rollout order.

## Traps

- The deploy queue REFUSES deploy-direct while another job runs
  (`runningCount=1`). A parallel server session deploys the same branch;
  wait on `curl 127.0.0.1:3910/ops/deploy/status`, never `--skip-queue-check`.
- `pgrep`/`pkill -f` waiters self-match when the SAME compound command also
  contains the literal pattern later in the line. Poll the queue endpoint or a
  container label instead. (Cost three dead SSH sessions tonight.)
- New page files verify with `next build`, tests with the runner in
  package.json (`node --experimental-test-module-mocks --import tsx --test`),
  and every new `t()` phrase must be in that file's PHRASES list —
  `scratchpad/checkphrases.py` pattern.

## Open

1. ~~Dialplan patch for pre_announce.~~ **APPLIED 2026-08-04 under Izzy's
   one-time mandate.** Verified in the compiled dialplan (priorities 27-33 of
   connect-tenant-ivr: DB read → empty-skip → STAT checks → Playback), whole
   dialplan intact (1538 contexts), 4 live calls unharmed. Backup:
   `/etc/asterisk/extensions__60_custom.conf.bak.pre-announce.20260804T150419Z`.
   Announcements are now END-TO-END live.
2. Queue callback recording (still pinned).
3. A Plus Center go-live flip on 8457823064 (still held).
