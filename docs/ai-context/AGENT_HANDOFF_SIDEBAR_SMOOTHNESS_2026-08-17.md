# AGENT HANDOFF — the sidebar stuttered because it rebuilt itself, and the whole app pays 70ms for any DOM change (2026-08-17)

**Scope of change:** `apps/portal` only. Six source files + one new test. No API,
no worker, no PBX, no migration, no data change, no flag.

**Reported by Izzy, 2026-08-17:** *"Sidebar opening and closing is very jittery.
It's not smooth, not in the web app, not in the Windows app. It needs to go in and
out as smoothly as possible: no jitters, no laziness, nothing."*

---

## 1. The measurement that settled it

The animation was never the problem. Everything below was measured in a browser
against **this repo's real `globals.css`** (5,722 rules) with the real sidebar
markup, 72 nav links and a 400-row Call History table as page content, at a
1440px viewport. The harness lives in the session scratchpad, not in the repo.

| What | Before | After |
|---|---|---|
| Cost of one rail toggle | **81.7 ms** median (74.7–126) | **~10–16 ms** median |
| Layout per frame while the width eases | 0.2 ms | 0.2–0.5 ms |
| Section open/close, per frame | 0.1 ms | 0.1 ms |

**81.7 ms is five dropped frames, spent at the exact moment the 220 ms width
transition starts.** You click, nothing moves for a twelfth of a second, and the
panel is already a quarter of the way across when it finally paints. That is the
"jitter" and the "laziness" — not the easing, not the duration, not the GPU.

---

## 2. ⛔⛔ THE FINDING THAT IS BIGGER THAN THE SIDEBAR

**Any DOM mutation inside `.console-shell` costs ~70 ms of style recalculation,
and the cost does not scale with the size of the mutation.**

Proven, not inferred:

- Rebuilding the 481-node nav list: **78–90 ms**.
- Rebuilding a **6-node** profile block: **68–79 ms**. Same cost.
- The same mutation performed **outside** `.console-shell`: **3–9 ms**.
- Deleting every `:has()` rule from the stylesheet at runtime and repeating the
  6-node mutation: **3.5–4.0 ms**. A **20× drop.**

`globals.css` carries **73 `:has()` rules** (134 occurrences of `:has(`). Chrome
must re-evaluate their invalidation on every DOM change in the subtree, and the
work is paid per *mutation*, not per *node*. ⛔ **Removing any single one changes
nothing** — bisecting one rule at a time shows no improvement until nearly all of
them are gone, so there is no one bad rule to delete. It is the aggregate.

⛔ **This is an app-wide tax, not a sidebar bug.** Every React render anywhere in
the portal that actually changes DOM pays ~70 ms. Fixing it means replacing those
73 rules with classes the components set themselves — `PageShell` already computes
route classes onto `.console-shell` and could carry most of them. **That work is
NOT done and is not in scope here.** It is the single highest-value follow-up for
general portal responsiveness.

⛔ A **class change** on an element is not a DOM mutation and does not pay this:
measured at **0.1–0.2 ms**. That is the whole basis of the fix below.

---

## 3. What was actually wrong with the sidebar

`SidebarNav` rendered **two entirely different DOM trees** and swapped between
them on the rail toggle:

- expanded → `CollapsibleNavSection` per section, each link with a label
- rail → `nav-rail-stack` / `nav-rail-group`, icon-only links, different badge
  markup, a different profile block, a different avatar element

`TenantSwitcher` did the same in miniature (a conditional between the full name
and a two-letter label, with the chevron rendered only when expanded).

So one click unmounted ~490 nodes and mounted ~490 different ones, and paid the
70 ms style-recalculation tax on top. React was doing exactly what it was told.

---

## 4. The fix

**One tree. The rail is a class on the `<aside>` and nothing else.**

| File | Change |
|---|---|
| `components/SidebarNav.tsx` | One nav list, always `CollapsibleNavSection`. One profile block. One avatar. Badge and update chip became classes (`drawer-nav-badge`, `drawer-nav-chip`) instead of two sets of inline styles. `title` is the only per-mode attribute. |
| `components/CollapsibleNavSection.tsx` | The rail branch is deleted — there is no second markup to return. |
| `components/TenantSwitcher.tsx` | Full name and two-letter label both always rendered; CSS shows one. |
| `components/PageShell.tsx` | `DesktopUpdateToast` + `DesktopShellBeacon` moved out of the sidebar (see §5). Passes the new `settled` flag. |
| `hooks/useSidebarRail.ts` | New `settled` flag (see §6). |
| `app/globals.css` | Rail styling keyed off `.console-nav.nav-rail`; mobile drawer moved to `transform`; one shared curve; reduced-motion block. |

### Things that were tried, measured, and then removed

⛔ **Do not add a per-link transition.** Fading the 72 labels and easing the 72
icon wells from 30→36 px cost **11 ms of pure transition setup** on the frame the
slide begins — Chrome builds one transition object per element. Both were removed:

- Labels need no fade. In the rail the label's `1fr` column is zero pixels wide
  and the aside clips it, so the slide itself draws the text away.
- The icon well is **one size (30 px) in both modes** now. Centring in the rail is
  a padding change on the **one** scroll container (`.drawer-nav`, 10 → 12 px),
  which eases, so the icons glide to dead centre (verified: all 72 at x = 36.0 in
  a 72 px rail) instead of jumping.

That single change took the toggle from ~28 ms to ~10–16 ms.

### Mobile / narrow window

The drawer animated **`left: -300px → 0`**. `left` is a layout property — every
frame relaid out the drawer *and* the page behind it. It now sits at `left: 0`
with `transform: translate3d(-100%,0,0)` and transitions `transform`, which runs
on the compositor and touches neither layout nor paint. Verified: closed at
x = −280, open at x = 0, `transitionProperty` is exactly `transform`.

---

## 5. ⛔ The trap the mobile change created, and why the toasts moved

`DesktopUpdateToast` is `position: fixed` and used to render **inside** the
`<aside>`. A transformed ancestor makes a fixed descendant position against *that
ancestor* instead of the viewport — so at any width below 1081 px (which an
Electron window can absolutely be) the toast would have been dragged off-screen
with the closed drawer. Both it and `DesktopShellBeacon` now render from
`PageShell`, mounted exactly as often as before. A guard test asserts they stay
out of the sidebar.

---

## 6. The load-time snap nobody had named

`useSidebarRail` starts `false` and reads `localStorage` in an effect, so the
first paint is always the expanded sidebar. For anyone who works in the collapsed
rail, **every page load animated the sidebar shut** — which reads as the app
stuttering, not as a preference being restored. A new `settled` flag stays false
across the frame that applies the stored width (two `requestAnimationFrame`s: one
to paint it, one to re-arm), and `.console-nav.nav-no-anim` suppresses every
sidebar transition until it flips.

---

## 7. Tests

`apps/portal/components/sidebarSmoothness.test.ts` — 6 tests, **registered in the
portal `test` script** (⛔ that script names each file; an unregistered test never
runs — this repo has shipped three of those).

They are **source-level guards on purpose**: the defect was in what the component
*renders*, so a unit test of a helper passes straight through it. They assert one
nav-link renderer, one avatar, one switcher, no `nav-rail-stack`, no rail-mode
conditional in the switcher, `transform` (not `left`) on the mobile drawer, no
per-icon resize rule, and the toasts living outside the sidebar.

✅ **Proven real:** replayed against `HEAD`'s versions of the same files, **5 of
the 6 fail.** (The sixth — "no per-icon resize rule" — passes before the change
because the rule never existed; it exists to stop it being re-added.)

Portal suite: **2 pre-existing failures, both unrelated and both untouched by this
work** — `webrtcSdpDiagnostics.test.ts` ("no acceptable codec") and
`campaignsIndexLayout.test.ts`. Their inputs (`lib/webrtcSdpDiagnostics.ts`, the
campaigns page) are not modified by this commit; confirmed with `git status`.
Typecheck: **0 errors.**

---

## 8. ⏳ NOT PROVEN

- ⛔ **Nobody has watched the sidebar move in a real browser on the new build.**
  Screenshots were unavailable in this session's browser pane, so the result is
  proven by **measurement and geometry** against the real stylesheet — timings,
  every one of the 72 icon centres, zero elements overflowing the 72 px rail, the
  dividers, the centred footer button — not by a human seeing it slide.
  **That is the acceptance test: collapse and expand it, in the web app and in
  the Windows app.**
- ⛔ **The Windows app keeps the old bundle until it is fully closed and
  reopened.** The desktop shell loads the hosted portal, so no new desktop build
  is needed — but an open window will show the identical old behaviour.
- The React reconciliation cost of the toggle (re-rendering 72 `<Link>`s to
  change one attribute) was **not** measured — the harness is plain DOM. It is
  expected to be small, but it is not proven.
- Nobody has tested at a mobile/narrow width in a real browser; the drawer's
  transform is proven by computed style and rectangles only.

## 9. Deliberately not changed

- The 73 `:has()` rules (§2). Real work, wide blast radius, its own engagement.
- The sidebar still animates `width`, because the layout genuinely is a push
  layout — and measured, that costs **0.2–0.5 ms per frame**, so there is nothing
  to win by faking it with a transform.
- `AppSidebar.tsx` / `SidebarNavGroup.tsx` — a second, unused sidebar
  implementation with no callers. Left alone.
