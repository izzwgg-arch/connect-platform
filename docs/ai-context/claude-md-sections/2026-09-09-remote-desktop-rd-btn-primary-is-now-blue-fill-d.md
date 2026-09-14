# ⛔ AGENT HANDOFF — Remote Desktop `rd-btn--primary` is now BLUE FILL + DARK BOLD TEXT (the Meetings "Start meeting" look), not white-on-blue and not the neutral grey (2026-09-09) — READ FIRST before restyling any button on `/remote-desktop`, the connect modal, `this-computer` or `session/[id]`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(**Two commits the same afternoon. No API change, portal-only deploys.** Izzy, 2026-09-09, with a
screenshot of the "Connect to someone else's computer" card: *"match the color of the button to
the other buttons"* → I made it the neutral `rd-btn` (`635da8ff`). He came back: *"Why is it
black on white? Make it Blue and black like the other main buttons"* and sent the Meetings
**+ Start meeting** button (`.mtg-primary`: `--accent` fill, `#04121d` text, 700 weight).)

- **Final state:** `.rd-btn--primary` in `apps/portal/app/globals.css` (~L39051) = `background:
  var(--accent); border-color: var(--accent); color: #04121d; font-weight: 700`, hover =
  `filter: brightness(1.08)`. It used to be `color: #fff` with an `--accent-2` hover. The
  Connect-by-ID button in `apps/portal/app/(platform)/remote-desktop/page.tsx` has
  `rd-btn rd-btn--primary rd-btn--block` again.
- ⛔ Because the change is on the modifier, EVERY `rd-btn--primary` got the new look: per-machine
  **Connect** in the machine cards, **Continue** in the connect modal, the primaries on
  `this-computer` and `session/[id]`. That is intended — Izzy's ask was "like the other main
  buttons", i.e. the portal's blue+dark-text primary. Do not put white text back on it.
- The portal has no global `.btn.primary` rule; the shared `.btn` is dark-navy in dark mode and
  `--accent` fill + white text in light (`:root[data-theme="light"] .btn:not(.ghost):not(.danger)`).
  The Meetings `.mtg-primary` is the reference Izzy pointed at; `.rd-btn--primary` now mirrors it
  in both themes (same rule, `--accent` is #22a8ff dark / #3b82f6 light).
- Verified in his own Chrome (Support login, `app.loopcom.net/remote-desktop`, `data-theme` toggled
  by script): the injected `rd-btn rd-btn--primary rd-btn--block` rendered identical to the Start
  meeting screenshot. ⏳ Deploy status: see the bullet appended below once the portal is out.
- ✅ **DEPLOYED + container-verified 2026-09-09:** commit `c54ae95f`, `ssh connect … bash scripts/deploy-direct.sh
  portal --commit c54ae95f` (dry-run first, no other deploy running; blue/green, nginx back on 3000).
  `app-portal-1` `/app/.build-commit` = `c54ae95f`, `curl 127.0.0.1:3000/login` → 200 in 15 ms; the built
  CSS (`static/css/465dd88a….css`, `dd47d032….css`) contains `color:#04121d;font-weight:700` and the route
  chunk `static/chunks/app/(platform)/remote-desktop/page-082ddeca….js` contains
  `rd-btn rd-btn--primary rd-btn--block`. The interim neutral look (`635da8ff`) was live for ~1 h only.
  ⏳ NOT PROVEN: Izzy's own eyes on the deployed page.
