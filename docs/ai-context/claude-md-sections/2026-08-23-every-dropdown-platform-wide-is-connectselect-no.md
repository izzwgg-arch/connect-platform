# ⛔ AGENT HANDOFF — every dropdown platform-wide is ConnectSelect now (2026-08-23) — READ FIRST before adding ANY dropdown to the portal, before touching ConnectSelect.tsx, or before "fixing" a form that stopped enforcing `required` on a select

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_CONNECTSELECT_PLATFORM_WIDE_2026-08-23.md`**
(`f6c61735` on `feat/ivr-migration-takeover`, portal-only — 51 files. Deploy state
recorded at the end of that doc / in the session that shipped it.)
Izzy, 2026-08-23: *"Every single dropdown … present and future, should only be the
modern one we have in the upper pages, the Loopcom theme won."* Memory:
[[connectselect-is-the-only-dropdown]].

- ⛔⛔ **THE RULE: a native `<select>` may not exist in portal TSX.** ~115 across 45
  files (IVR Studio + Jewish calendar, PBX console + PanelForm, all admin billing,
  the public onboarding wizard, desk-phone wizard, SignalWire/VoIP.ms/Polly,
  assistant, tracking, calls, mini/floating dialer, Cardknox payment form …) were
  converted to `ConnectSelect` / `ConnectMultiSelect`
  (`apps/portal/components/ConnectSelect.tsx`). **Enforced by
  `apps/portal/lib/nativeSelectSweep.test.ts`** (registered; proven non-vacuous —
  it listed every offender mid-conversion). The globals.css select rules are a
  SAFETY NET only, never licence to add one.
- ⛔⛔ **The `name` prop renders a HIDDEN input for FormData-read forms — and
  hidden inputs are EXEMPT from browser `required` validation.** A form that
  relied on a native select's `required` must validate the field itself.
  `CardknoxIFieldsForm` (the Sola payment surface) does exactly that for expiry
  month/year (`expiryError` inline); its `validateRequiredBillingFields` no longer
  lists expMonth/expYear. **Copy that shape for any future `name`-using site.**
- ⛔ **A surface that themes OUTSIDE `<html data-theme>` must pass
  `theme="light"|"dark"`** — the dropdown panel PORTALS to `<body>`, so ancestor
  theming can never reach it. Live examples: the onboarding wizard (data-ob-theme,
  passes its live `themeLabel`) and Cardknox (passes `resolvedFieldTheme`). Inside
  the platform shell, omit the prop.
- ⛔⛔ **THE PORTAL-TO-BODY ALSO DEFEATS EVERY ANCESTOR "click outside closes me"
  HANDLER — this sweep BROKE the mini dialer's device pickers, found 2026-08-27**
  (Izzy + Trust Bookkeeping 105: "selecting a Headset/Speaker/Ringer device just
  closes the settings without saving"). A press on a dropdown OPTION lands in the
  portaled panel on `<body>`, so an ancestor popover closing on document
  mousedown/pointerdown sees it as OUTSIDE, closes at mouse-DOWN, and unmounts
  the dropdown before the option's click (mouse-UP) fires — **the popover closes
  AND the selection is never saved.** The native `<select>` it replaced rendered
  options in an OS popup that produced no document mousedown, which is why this
  only broke with the sweep. ✅ Fixed `e8793977` (**portal DEPLOYED and
  container-verified 2026-08-27** — `.build-commit` = `e8793977`, the
  `closest(".viewport-dropdown")` literal grepped in the shipped chunk, 0
  restarts, both hostnames 200): `isInsideViewportDropdown()` exported from
  `ViewportDropdown.tsx`; the outside-close handlers in `DesktopMiniDialer.tsx`
  (settings/notifications) and `FloatingDialer.tsx` (whole-shell capture-phase
  pointerdown — a device pick there closed the ENTIRE dialer) early-return on it.
  ⛔ **Any NEW popover that contains a ConnectSelect and closes on a document
  outside-click must call this check first.** Sweep recipe: intersect files
  importing ConnectSelect with files adding a document mousedown/pointerdown
  listener — `calls/page.tsx` and `team/page.tsx` also match but their
  outside-closed containers are bare kebab menus with no ConnectSelect inside,
  checked and left alone. Guard: `lib/dropdownOutsideClose.test.ts` (registered;
  all 3 fail replayed against pre-fix HEAD). ⛔ An already-open mini dialer keeps
  the OLD bundle until the desktop app is fully closed and reopened. ⏳ NOT
  PROVEN: nobody has re-picked a device since the deploy — acceptance is one
  device pick on the mini dialer settings: the popover STAYS open and the
  selection sticks after closing/reopening it.
- ⛔ **Conversion contract for the next dropdown** (details in the handoff):
  onChange gets the plain string (never an event); number state bridges
  `String(x)`/`Number(v)`; a selectable empty option stays a real option while a
  DISABLED placeholder option becomes the `placeholder` prop; never pass legacy
  input classNames (trigger is self-styled) — carry only layout via `style`;
  `size="sm"` in dense toolbars; `<select multiple>` → `ConnectMultiSelect`.
- ⛔ **PanelForm (pbx-console) posted values were kept byte-identical** — the
  parsed panel option fallback label contains a non-ASCII space and the file is
  CRLF; multi values stay `string[]`; untouched fields never enter `changed`.
  Do not "clean up" any of that.
- ✅ Proven: portal typecheck 0, suite 322/324 (the two documented pre-existing
  failures), Yiddish option strings moved byte-identically so phrase keys match.
- ⏳ **NOT PROVEN: no human has opened a converted dropdown in a browser.**
  Acceptance: pick a value on IVR Studio, admin billing, the PBX-console team
  dialog, the onboarding number search (both ob themes), and the mini dialer —
  and the negatives that matter most: one real payment through the pay page
  (empty expiry must show the inline error, a filled one must tokenize), and one
  PBX-console panel save proving posted values didn't drift. ⛔ Open tabs and the
  desktop app keep the OLD bundle until fully reloaded/restarted.
