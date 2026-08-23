# AGENT HANDOFF — every dropdown platform-wide is ConnectSelect now (2026-08-23)

Commit `f6c61735` on `feat/ivr-migration-takeover` (51 files, +1408/−788).
Izzy's mandate, verbatim intent: *"Across the whole platform … change the dropdowns
to the modern connect theme dropdown that is in the upper pages. Go through each and
every single page from top to bottom: every wizard, every little corner, everything …
Every single dropdown and connect platform, present and future, should only be the
modern one we have in the upper pages, the Loopcom theme won."* Then re-emphasised:
*"onboarding wizard provisioning everything, everything, everything."*

## What changed

**~115 native `<select>` elements across 45 files** were converted to
`ConnectSelect` / `ConnectMultiSelect` (`apps/portal/components/ConnectSelect.tsx`),
which was already the modern dropdown on the "upper pages" (voicemail, team,
settings, extensions, queues, DID routing …). Zero native selects remain in portal
TSX. Converted surfaces:

- **IVR Studio family**: page.tsx (menu picker, timeout/retries, timezone,
  open/closed/holiday menus), JewishCalendar (8), MakeRecording (Polly + ElevenLabs
  pickers), MakeTeam, NumberStep, FirstRunSetup, MOH scheduling, DID routing.
- **PBX console**: page.tsx (11 incl. the ExtensionForm customer picker with its
  `tenantId` number bridging) and **PanelForm.tsx** — the dynamically-parsed
  VitalPBX panel form. Posted values stay byte-identical (see traps below).
- **Admin billing, all of it**: settings, invoice, month, customer page, and the 7
  `_components` files (taxes/fees, ops panels, Sola imports, profiles, invoice
  editor, manual invoice drawer, tenant config forms).
- **Public onboarding wizard** (`app/onboarding/[token]/page.tsx`) — with the
  `theme` prop (see trap #2).
- **Desk-phone wizard**, tracking (settings/runs/orders), agent-permissions,
  admin users/tenants/device-registration/deploy-center/remote-support, assistant
  (model picker with optgroups → `groups`), SignalWire (8), VoIP.ms (incl. the
  multi-select), Polly, CRM settings, script sidebar, email-builder canvas,
  meetings schedule, calls, recordings, dashboard voice phone, queues dialog,
  **FloatingDialer** and **DesktopMiniDialer** (device pickers, size="sm").
- **CardknoxIFieldsForm** (the standard Sola payment surface) — expiry month/year.

## ConnectSelect gained four things (all in `components/ConnectSelect.tsx`)

1. **`name` prop → hidden input bridge.** Forms that read values via
   FormData / `form.elements` (Cardknox, tenantBillingConfigForms,
   billing/settings dunning) keep working: ConnectSelect renders
   `<input type="hidden" name value>`.
   ⛔⛔ **Hidden inputs are EXEMPT from browser constraint validation** — a form
   that relied on the native select's `required` MUST validate the field itself.
   CardknoxIFieldsForm now checks expMonth/expYear explicitly and renders its own
   `expiryError` line; `validateRequiredBillingFields` no longer lists them.
   **Any future `name`-using ConnectSelect in a `required` form needs the same.**
2. **`theme?: "light" | "dark"` explicit override.** ⛔ The onboarding wizard
   themes itself via `data-ob-theme` on `.ob-shell`, NOT `<html data-theme>` —
   and the dropdown panel PORTALS TO `<body>` (ViewportDropdown), so ancestor
   scoping can never reach it. The `theme` prop stamps `cs-light`/`cs-dark` on
   both the trigger wrap and the portaled panel. The wizard passes its live
   `themeLabel` state (synced from the shell attribute + OS preference, updated
   by the in-wizard toggle). **Any future self-themed surface (not `<html
   data-theme>`) must pass this prop or the panel renders the wrong theme.**
   Cardknox passes `resolvedFieldTheme` (customer = light pay pages, admin = dark).
3. **`ariaLabel` / `title` passthrough** onto the trigger button.
4. **`ConnectMultiSelect`** — the one replacement for `<select multiple>`
   (checkbox rows, stays open on toggle, "N selected" trigger, same search).
   Two call sites: VoIP.ms number-assignment user list, PBX-console PanelForm.

## The guard — "present and future"

`apps/portal/lib/nativeSelectSweep.test.ts` (registered in the portal `test`
list, which names files explicitly). Walks app/, components/, lib/, navigation/,
hooks/, services/ for `.tsx` and fails on any `<select` in executable code.
- Comment-shaped LINES are dropped (trimmed start `//`, `*`, `/*`, `{/*`) —
  ⛔ deliberately NOT a block-comment stripper: for a NEGATIVE assertion, a
  stripper that opens a fake comment at a regex literal produces a false PASS
  (the inverse of the usual repo trap).
- ✅ Proven non-vacuous: it was run against the mid-conversion tree and listed
  every remaining native select.
- Also pins that ConnectSelect exports ConnectMultiSelect and keeps the
  hidden-input bridge.

`globals.css`'s native-select normalisation block (~line 12616) is relabelled
**SAFETY NET ONLY** — kept so a stray/third-party select still roughly matches
the theme, never licence to add one. Also added: `.billing-form .cs-trigger`
(42px/12px radius) so the payment-form dropdowns sit flush with card fields.

## Traps paid for / conversion contract (for the next dropdown anyone adds)

- **onChange receives the plain string**, not an event. Number state bridges via
  `String(x)` / `Number(v)`; union casts move onto `v`.
- **Selectable empty option stays a real option**; a DISABLED placeholder first
  option becomes the `placeholder` prop.
- **Never pass legacy input classNames** (`pc-ctl`, `sel`, `sw-input`,
  `cbill-select`, `input`, …) — the trigger is self-styled; carry only layout
  (width/flex) via `style`. Dense toolbars use `size="sm"`.
- **PanelForm** (pbx-console): the parsed panel options' `o.t || " "` fallback
  contains a NON-ASCII space and the file is CRLF — preserved byte-for-byte.
  Multi values stay `string[]`; untouched fields never enter `changed`, so
  posted panel values are byte-identical. One cosmetic note: a stored `""` value
  with no `""` option now shows the "Select…" placeholder where the native
  select showed the first option's text — display only.
- **Yiddish**: option label source strings moved byte-identically (still through
  `t()` where they were), so UI_PHRASES keys keep matching.
- The pbx-console ExtensionForm error-border (`bad` class) was dropped from the
  customer picker — the error MESSAGE still renders via `Field`.
- dashboard/voice/phone's speaker picker lost its legacy borderless-purple
  styling and now renders as the standard trigger (deliberate).

## Proven / NOT proven

- ✅ Portal typecheck **0 errors**; suite **322/324** (the two documented
  pre-existing failures: webrtcSdpDiagnostics, campaignsIndexLayout — inputs
  untouched); sweep guard green; spot-checked by hand: Cardknox validation flow,
  controlled-state syncing in tenantBillingConfigForms + billing/settings
  (defaultValue → useState + post-load sync), onboarding theme wiring,
  VoIP.ms ConnectMultiSelect, SignalWire fire-and-reset pattern (`value=""`,
  action in onChange, self-resets), mini-dialer device pickers.
- Deploy state: see CLAUDE.md section (this doc may predate the verify step).
- ⏳ **NOT PROVEN: no human has opened a converted dropdown in a browser.**
  ~115 dropdowns were converted mechanically; the acceptance test is opening a
  few of the heaviest screens (IVR Studio, admin billing customer page,
  PBX console team dialog, onboarding wizard number search in BOTH ob themes,
  mini dialer settings) and picking a value in each. ⛔ The negatives that
  matter most: a **payment** through the pay page with the new expiry
  dropdowns (validate the empty-expiry refusal shows the inline error), and a
  **PBX-console panel save** confirming posted values didn't drift.
- ⏳ An already-open portal tab / desktop window keeps the OLD bundle until
  reloaded; the desktop app needs a full close + reopen.

## Process notes

- The conversion ran as 4 parallel subagents over disjoint file lists with a
  strict written contract; two agents' completion reports were lost to a
  process restart but their edits were complete on disk — verified by the
  sweep + typecheck + targeted diff review, not by trusting the reports.
- Committed with `git commit -F - -- <51 explicit paths>` (pathspec); the
  other sessions' in-flight files (api billing emails/pdf, mobile brand,
  invoice-print, regulatory docs) were verified DIRTY-BUT-EXCLUDED, and each
  committed file's diff was checked to contain only dropdown work.
  `tsconfig.tsbuildinfo` backed up to scratchpad and restored to HEAD.
