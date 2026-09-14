# ⛔ AGENT HANDOFF — the Team Directory could not scroll unless the window was maximised (2026-08-12) — READ FIRST before adding a screen to the `.console-content:has(> …)` full-height list, or for ANY "this page cuts off / won't scroll" report

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_TEAM_DIRECTORY_SCROLL_2026-08-12.md`**
(commit `504ec6ed` on `feat/ivr-migration-takeover`, shipped in portal tip
`5330620d` — **DEPLOYED, container-verified AND verified over public HTTPS**.
Portal CSS only, one screen; nothing touching call routing, the PBX or billing.)

- ⛔ **A screen listed in `.console-content:has(> …)` has had its outer
  scrolling turned OFF and MUST supply its own inner scroller.** Three parts,
  as `.ch-shell` does it: root `height:100%; min-height:0; overflow:hidden` +
  flex column; header/footer bands `flex-shrink:0`; **middle band
  `flex:1; min-height:0; overflow-y:auto`**. The Team Directory had only the
  footer part, so **no element on the page was a scroller** and everything
  below the window edge was unreachable. ⛔ **`min-height: 0` is the piece that
  does the work and the piece everyone omits** — without it a `flex:1` child
  still grows to fit its content and never scrolls.
- ⛔ **A maximised window PROVES NOTHING here.** Nothing about the bug is
  size-dependent — only the symptom is. Maximised, the list happened to fit and
  the screen looked perfect; shrink the window and 1,425 px of people were cut
  off with **zero** scrollable containers anywhere on the page. **Test every
  screen on that list at a short window.**
- ⛔ **One scrollport per page.** `overflow-x: auto` computes `overflow-y` to
  `auto` too, so a nested wrapper becomes its own scrollport and captures any
  `position: sticky` header inside it. Making the page scroll would have slid
  the list view's column headings away (measured: header at **y = −523**);
  moving the sideways scroll up onto `.td-content` pinned them correctly
  (**y = 77** vs content top 61). Fixing the scroll is what *exposed* this —
  check for it whenever you add a scroller.
- **Safe to clip only because the overlays are `position: fixed`** — the detail
  panel, its backdrop and the toasts all are, so `overflow: hidden` on the root
  never reaches them. Verify that before adding clipping to any other screen.
- ⛔ **The desktop app keeps the OLD bundle until the window is fully closed and
  reopened** — a portal deploy reaches every install with no new build, but
  "it's deployed" without "now restart it" leaves the customer looking at the
  identical bug.
- ⏳ **NOT PROVEN: nobody has opened the real screen since the deploy.** Proven
  by measurement against the actual shipped stylesheet (5,412 rules parsed) plus
  the live CSS fetched over HTTPS — not by a human scrolling it.
- ✅ **The other three screens were checked (2026-08-12) and are HEALTHY** — the
  Team Directory was the only one. Measured at a 640 px window, not read:
  Voicemail's feed scrolls 1,490 px and its detail panel another 742 px; Billing's
  `.billing-ws-main-scroll` scrolls 1,430 px; all parents clip with 0 px stranded.
  ⛔ **The contract list is exactly four screens** — the other
  `.console-content:has(…)` rules (wallboard, checklist, scripts, voicemail-drops,
  forms) set **background only** and never touch `overflow`, so those pages keep
  normal scrolling and are not affected.
- ✅ **Billing hardened same day (`33d08426` — committed + pushed, ⛔ NOT yet
  deployed; behavior-identical, rides the next portal deploy).** Its `flex: 1`
  used to arrive only through the
  `.billing-ws-shell--context-wide .billing-ws-main--wide` pair, so a page
  rendering `.billing-ws-main` bare would silently lose the scroll chain — the
  `.td-page` failure shape one refactor away. The layout now lives on
  `.billing-ws-main` itself and both modifier classes are DELETED from CSS and
  `AdminBillingShell` (nothing else referenced them; `--all-tenants` stays,
  conditional and pre-existing). Proven by measuring shell markup and bare
  markup side by side: identical 1,569 px scroll, toolbar pinned, 0 px stranded.
- ⛔ **The rebuilt/non-rebuilt billing scroll split is DELIBERATE — never "fix"
  one side to match the other.** Pages on the `REBUILT` list in
  `apps/portal/app/(platform)/admin/billing/layout.tsx` render no
  `.billing-ws-shell` at all (bare `<Suspense>` renders no DOM node), so the
  `:has()` never matches and they scroll as ordinary pages; shell-wrapped pages
  scroll inside `.billing-ws-main-scroll` with the toolbar pinned. The full
  explanation now sits ON the `REBUILT` list itself — read it before adding any
  screen under `/admin/billing`.
