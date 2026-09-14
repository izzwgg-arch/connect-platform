# ⛔⛔ AGENT HANDOFF — the sidebar rebuilt itself on every toggle, and ANY DOM change in the portal costs 70ms (2026-08-17) — READ FIRST before touching the sidebar, before adding a `:has()` rule to globals.css, before animating anything in the portal, or for ANY "the app feels slow / laggy / jittery" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SIDEBAR_SMOOTHNESS_2026-08-17.md`**
(portal source only — six files + one new test. No api, no worker, no PBX, no
migration, no data change, no flag.)
Memory: [[sidebar-must-not-swap-markup]], [[move-layers-never-repaint-surfaces]].

- ⛔⛔ **THE FINDING THAT OUTRANKS THE SIDEBAR: any DOM mutation inside
  `.console-shell` costs ~70 ms of style recalculation, and the cost does NOT
  scale with the size of the mutation.** Measured against the real stylesheet:
  rebuilding the **481-node** nav list = **78–90 ms**; rebuilding a **6-node**
  profile block = **68–79 ms** — the same; the identical mutation **outside**
  `.console-shell` = **3–9 ms**; and with every `:has()` rule deleted at runtime,
  **3.5–4.0 ms**. `globals.css` carries **73 `:has()` rules**, and Chrome pays
  their invalidation per mutation, not per node.
  ⛔ **There is no single bad rule** — deleting them one at a time shows no
  improvement until nearly all are gone. It is the aggregate.
  ⛔ **So every React render anywhere in the portal that actually changes DOM
  pays ~70 ms.** This is the app-wide cause of "everything feels sluggish", and it
  is **NOT FIXED** — fixing it means replacing those 73 rules with classes the
  components set themselves (`PageShell` already stamps route classes onto
  `.console-shell` and could carry most of them). Its own engagement.
  ✅ **A class change is not a DOM mutation and does not pay this: 0.1–0.2 ms.**
  That is the entire basis of the sidebar fix. **Prefer a class over a conditional
  render anywhere in the portal shell.**
- ⛔⛔ **THE SIDEBAR MUST NEVER SWAP MARKUP.** `SidebarNav` rendered two
  completely different trees — `nav-rail-stack` icon links vs
  `CollapsibleNavSection` labelled links, two profile blocks, two avatars — and
  `TenantSwitcher` did the same in miniature. One click unmounted ~490 nodes and
  mounted ~490 others **and** paid the 70 ms tax, **right at the start of the
  220 ms width transition**: measured **81.7 ms median (74.7–126)**. That stall
  IS the jitter; the easing and the duration were never the problem (layout while
  the width eases is **0.2 ms per frame**). Now one tree, rail = a class on the
  `<aside>`: **~10–16 ms**, inside a single frame.
- ⛔ **DO NOT ADD A PER-LINK TRANSITION** (label opacity, icon-well size,
  anything). Chrome builds one transition object per element; across 72 links that
  measured **11 ms of pure setup** on the exact frame the slide begins — it alone
  took the toggle from ~10 ms back up to ~28 ms. Labels need no fade: the rail
  leaves the label column zero pixels wide and the aside clips it, so the slide
  draws the text away by itself. The icon well is **one size in both modes**;
  centring in the rail is a padding change on the **one** scroll container.
- ⛔⛔ **THE SIDEBAR FIX ALONE WAS NOT ENOUGH, AND THE SECOND CAUSE IS THE ONE TO
  REMEMBER: `CallVolumeChart` on the DASHBOARD rebuilt itself on every frame of
  the slide.** It runs a `ResizeObserver` on its own container and feeds the width
  into a `useMemo` that rebuilds every path, grid line and tick — so each frame
  mutated dozens of SVG attributes and paid the ~70 ms tax above. **Measured on
  the live dashboard: one rebuild = 23.2 ms, × 12 frames = ~278 ms of work inside
  a 200 ms animation**, against a 16.7 ms budget. The animation could not have
  been smooth on the landing page whatever the sidebar did. ✅ Fixed by committing
  the observer on the **trailing edge** (120 ms idle; first measurement still
  immediate). ⛔ **The re-render was nearly pointless anyway** — the `<svg>` is
  `width="100%"` + `viewBox` + `preserveAspectRatio="none"`, so the browser
  already scales it for free; the recompute only restores true proportions, once.
  ⛔ **THE RULE: any component that recomputes on its own width recomputes on
  every frame the sidebar moves.** It is also why the first fix was reported too
  early — **the harness did not contain the chart.** `CallVolumeChart` is the only
  `ResizeObserver` in apps/portal; the three `resize` listeners are window-level
  and the sidebar never fires them.
- ⛔⛔ **AND THE ANIMATION WAS NEVER THE CAUSE — TWO FIXES MISSED BEFORE THIS WAS
  MEASURED PROPERLY. THE FIVE-MINUTE TEST TO RUN FIRST: delete the animation
  entirely.** With no transition at all, an instant collapse **still dropped 5-6
  frames per toggle** (worst 180-280 ms). Chrome's counters over 4 toggles:
  animating `width` = **23 layouts / 109.8 ms of layout**; animating `transform`
  = **0 layouts, 0 dropped frames**; idle control = 0.
  ⛔ **The machine matters and explains years of "everything is slow":
  Intel HD Graphics 4000 (2012) driving a 3440x1440 ultrawide** (2752 CSS px @
  DPR 1.25). A full-viewport repaint really is 100-250 ms there. **But do NOT
  file that as "can't be fixed"** — on that same machine a `transform` animation
  measured **0 dropped frames every run**. Moving a layer is nearly free;
  repainting 4.2 megapixels is not. **Move layers, never repaint surfaces.**
  ⛔ **Ruled out BY MEASUREMENT, so do not re-investigate:** removing the page
  content from the DOM, `contain`, `will-change`, shorter durations, not painting
  the sidebar contents, the workspace gradient, pinning inner widths **while in
  flow** — and **deleting all 73 `:has()` rules (4.2 -> 4.7 dropped frames).**
  ⛔⛔ **So the `:has()` tax above is real for DOM MUTATIONS but is NOT the
  cause of slow toggles** — that was attempt one's headline theory and it was
  wrong.
  ✅ **What fixed it (`5b2f0188`):** the sidebar's contents moved into
  **`.nav-sheet`, `position: absolute` at a fixed 280px**, taking ~500 nodes
  **out of the layout path** (⛔ pinning their width while leaving them IN FLOW
  had already been tried and did nothing — out-of-flow is the point); the width
  now changes **once per toggle** with no width transition; and the motion is a
  **`clip-path` over the sheet + a `translateX` on `.console-workspace`**,
  neither of which lays out. Rail is **68px** and the link gap **15px** so a
  label starts exactly at the rail edge — which is why the rail needs **no
  layout-changing rules at all**, it is just the expanded sidebar with a clip.
  **Measured: 5-6 -> 0-2 dropped frames per toggle, layout time down ~12x**,
  reproduced over three runs. ⛔ The forced `void workspace.offsetWidth` in
  `useSidebarGlide` is **load-bearing** — a double-rAF instead measured **5x
  worse**. ⏳ ~1 dropped frame per toggle remains: the one unavoidable layout
  when the content area resizes. Removing that needs an overlay sidebar (content
  never resizes), which is Izzy's product call, not a bug.
- ✅✅ **THE ANSWER, and it took five rounds to reach: THE SIDEBAR'S WIDTH IS NOT
  ANIMATED.** Measured on the owner's hardware against a page **the weight of the
  real dashboard** (⛔ the earlier harness had a 300-row table and was ~10x
  heavier than his actual page — that mis-sizing is what sent three rounds
  chasing the wrong thing): sliding = **5.5 dropped frames/toggle**; a 120ms
  slide = 4.67; snapping the panel while gliding the page = 2.25; **removing the
  animation entirely = 0.5, with half the toggles completely clean.** Idle
  control 0. **Not one pixel of his design changes** — only the motion goes, and
  an instant toggle has nothing left to stutter.
  ⛔ **Never re-add `transition: width` to `.console-nav`.** Every millisecond it
  runs re-lays-out and repaints a 3440x1440 shell on a 2012 GPU. Guarded by
  `sidebarSmoothness.test.ts`.
  ⛔ **AND SIZE THE HARNESS TO THE REAL PAGE FIRST.** On the real dashboard one
  toggle's layout measured **1.7ms**; the oversized harness said 32ms. Every
  conclusion drawn from the heavy harness about "the content relayout is the
  floor" was wrong.
- ⛔⛔ **REVERTED 2026-08-17, AND THIS IS THE RULE THAT MATTERS MOST HERE:
  IZZY'S SIDEBAR DESIGN IS NOT YOURS TO CHANGE.** The overlay below was measured
  at 0.07 dropped frames — the fastest thing in this whole engagement — and he
  rejected it outright: *"You change things around... The way it was was perfect
  if it worked efficiently. Now it closes better, but it's stupid. It's not nice.
  It's not my style."* **A performance win that alters the look is not a win.**
  The rail is **72px** with **36px icon wells on 40px rows**, the panel **pushes
  the content across** (it does not float over it), the icon-to-label gap is
  **6px**, and section headings are **hidden** in the rail with dividers between
  groups. All of that is restored and verified rule-by-rule against the pre-work
  file. ⛔ Keep only optimisations the eye cannot see; if a change is visible,
  ask first.
- ~~**FINAL (`5b2f0188` → the overlay): THE PANEL FLOATS OVER THE PAGE AND THE
  CONTENT AREA NEVER RESIZES.**~~ (measured 0.07 dropped frames/toggle, then
  REVERTED on his instruction — kept here only so nobody rebuilds it: `.console-nav` reserves **68px in BOTH states**;
  the 280px `.nav-sheet` overhangs it and a `clip-path` is the entire animation.
  Because nothing outside the sidebar changes width, a toggle lays out and
  repaints **nothing else on the page**. Measured on the owner's GPU: pushing the
  content = **2.1-2.4 dropped frames/toggle, ~300ms layout per 10 toggles**;
  floating over it = **0.1 dropped frames (nine of ten toggles perfectly clean),
  9.6ms**. ⛔ **Never give `.console-nav` a width per mode again** — that one
  layout is the whole remaining cost, ~30ms on this hardware. The trade Izzy
  accepted 2026-08-17: while open, the panel covers 212px of the page's left edge
  (6% of a 3440px screen), as Slack/VS Code/mobile drawers do.
- ⛔ **The mobile/narrow drawer animated `left`, a LAYOUT property** — relaying
  out the drawer and the page behind it every frame. It is `transform:
  translate3d(-100%,0,0)` now (compositor only). ⛔ **That created a trap and it
  is why `DesktopUpdateToast` + `DesktopShellBeacon` moved OUT of the sidebar into
  `PageShell`:** a transformed ancestor makes a `position: fixed` descendant
  position against *it*, not the viewport, so below 1081 px — which an Electron
  window can be — the toast would ride off-screen with the closed drawer.
  **Never put a fixed-position element inside `.console-nav`.**
- ✅ **The load-time snap nobody had named is gone too.** `useSidebarRail` reads
  localStorage in an effect, so the first paint is always the EXPANDED sidebar —
  anyone working in the collapsed rail watched it animate shut on **every page
  load**. New `settled` flag + `.console-nav.nav-no-anim` suppress the transition
  until the stored width has been painted.
- **Guard:** `apps/portal/components/sidebarSmoothness.test.ts`, 6 tests,
  **registered in the portal `test` script**. ⛔ They read the components' SOURCE
  on purpose — the defect is in what is RENDERED, so a unit test of a helper
  passes straight through it. ✅ **Proven real: 5 of the 6 fail against `HEAD`.**
  Typecheck 0 errors. ⛔ The portal suite has **2 pre-existing failures unrelated
  to this** (`webrtcSdpDiagnostics`, `campaignsIndexLayout`) — their inputs are
  untouched here; don't read them as regressions.
- ⏳ **NOT PROVEN: nobody has watched the sidebar move in a real browser.**
  Screenshots were unavailable in this session's browser pane, so it is proven by
  measurement and geometry against the real stylesheet — timings, all 72 icon
  centres at x=36.0 in a 72 px rail, zero elements overflowing, dividers, centred
  footer button — not by a human seeing it slide. ⛔ **The Windows app keeps the
  old bundle until it is fully closed and reopened** (it loads the hosted portal,
  so no desktop build is needed — but an open window shows the identical old
  behaviour).
