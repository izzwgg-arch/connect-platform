# Handoff — IVR migration, Studio rebuild, Yiddish interface (2026-08-03/04)

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
