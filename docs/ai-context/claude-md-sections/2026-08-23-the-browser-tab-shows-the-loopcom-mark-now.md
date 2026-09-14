# ⛔ AGENT HANDOFF — the browser tab shows the Loopcom mark now (2026-08-23) — READ FIRST before touching the portal favicon, before adding ANY icon `<link>` to `app/layout.tsx`, before putting an icon file in `apps/portal/public/`, or for "the tab still shows the old icon"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


(`scripts/portal-favicon-assets.py` + `apps/portal/app/favicon.ico` +
`apps/portal/app/apple-icon.png`, portal-only — no api, no worker, no migration,
no PBX write, no env change. Deploy state at the end of this section.)
Izzy, 2026-08-23: *"there is a local file in the connect2 folder called icon
refinement options. There is a favicon there to put in the browser on top."*

- ⛔⛔ **UPDATED 2026-08-23 (second pass, Izzy): THE FAVICON IS THE MARK WITH THE
  BACKGROUND CUT AWAY — no blue plate, transparent outside AND inside both eyes,
  scaled EDGE TO EDGE.** *"take away the background colour from inside those two
  peep holes, like eyes, and around it … I didn't want you to change anything."*
  The band keeps exactly what the designer drew — blue fill, white outline, every
  tick mark. Nothing is recoloured, nothing redrawn.
  ⛔ **The kit ships that artwork ONLY as a flattened tile**, so the three regions
  are recovered in `scripts/portal-favicon-assets.py`: the plate is a pure
  vertical gradient (34,167,255 → 30,79,214), horizontally uniform, and the mark
  never touches the left edge — **so column 0 IS the plate, row by row**. Every
  pixel is `C = a*White + (1-a)*Plate`, solved by least squares over **R and G
  only** (the plate's blue is pinned at 255 down the top half and carries no
  signal). Then flood fill the non-ink from the border → OUTSIDE, from each loop
  centre → the two EYES; what is left is the band. **Verified by re-compositing:
  mean error 2.3/255**, and the two eyes come out at **1.31% each, equal to 3
  decimals** — which a symmetric mark gives and a sloppy cut does not.
  ⛔⛔ **`Image.fromarray()` RETURNS A READ-ONLY IMAGE AND `ImageDraw.floodfill()`
  WRITES INTO IT DOING NOTHING, SILENTLY.** The first run reported `outside 0.00%`
  and looked like a segmentation failure. `.copy()` is load-bearing.
  ⛔ **Resize PREMULTIPLIED** — the plate blue still sitting in the fully
  transparent area otherwise bleeds into every edge and prints a halo.
  ⛔ **Edge to edge, `MARGIN = 0.0`** (*"make it as big as you possibly can"*).
  The mark is **2.22:1**, so filling the width is as large as it goes without
  distorting it; at 16px that is 16 wide and 7 tall. Do not squash the aspect.
- ⛔⛔ **THE FLARE AT THE CENTRE STAYS, AND IT IS NOT A STYLE CHOICE — IT IS THE
  JOIN.** Izzy asked for it out. **The two loops do not touch**; the flare bridges
  them. Measured by trimming its four points 1px at a time and re-running the
  segmentation: past **76px of their ~105px** the background floods through into
  the band's blue fill and the infinity comes apart. The safe trim is a **28%
  shortening — 2.1px → 1.5px at a 16px favicon**, i.e. invisible. Not worth
  touching the designer's artwork, so it is left alone.
  ⛔ **THE LESSON IS THE TEST, NOT THE ANSWER: my first trim test checked that the
  two EYES stayed equal, and they stay equal long after the mark has been breached
  somewhere else** — it reported "closed down to 65px" while the background had
  already flooded the band. **The invariant that actually catches it is the BLUE
  FILL between the ticks surviving (12.22%).** Both guards are now in the script
  and it exits rather than write a broken mark.
- ⛔⛔ **THE 16px FRAME SHIPPED 0.55px HIGH AND ONLY THE TAB STRIP COULD SHOW IT
  (2026-08-23, Izzy: *"center align level the favicon with the URL text"*).**
  `render()` resized the mark and then composited at **`((side - nh) // 2)`** —
  a floor that is only exact when the leftover gap is EVEN. The mark is 2.22:1,
  so at 16px it renders **7 tall in a 16 box → a gap of 9 → 4 above / 5 below**.
  **32 and 48 happened to land on even gaps and were pixel-perfect, which is why
  the defect was invisible in every frame except the one Chrome actually uses.**
  Measured: alpha-weighted centroid **y=7.50 vs a box centre of 8.00**.
  ✅ **Fix: centre by PADDING AT SOURCE RESOLUTION (794px) and resizing ONCE**, so
  the residual error is a fraction of a *source* pixel (~0.02px at 16px) instead
  of half a rendered one. All three frames now measure **0.00px off centre**;
  16px is 4-above/4-below. ⛔ **It is NOT softer — that was my eyeball and the
  metrics overturned it:** still a single Lanczos pass, and hard-edge pixels went
  **40% → 50%**, fully-opaque **40 → 44**, edge contrast unchanged.
  ⛔ **Two fixes were measured and REJECTED — do not retry them:** shifting down
  1px lands **0.45px LOW** (the same error mirrored), and forcing an 8px-tall
  frame centres perfectly but **stretches the mark 11%**, against the
  edge-to-edge/aspect rule above.
  ⛔ **`--check` now carries a CENTRING guard (`MAX_CENTRE_OFFSET_PX = 0.06`),
  and it is a SEPARATE failure from "does not match the kit"** — a frame can be
  pixel-correct artwork and still be pasted a pixel high, which is exactly how
  this shipped. **Proven non-vacuous:** replayed against the previous favicon it
  reports *"the 16px frame sits -0.50px off centre (-3.1% of the icon)"*.
- ⛔ **The general lesson, and it is why this hid for a day: a rounding bug in a
  multi-size asset can be correct at most sizes and wrong at the ONE that
  ships.** Judge every frame independently against the size it is actually used
  at — do not infer 16 from 32.
- ⛔⛔ **AND CENTRING IT IN THE BOX WAS STILL NOT LEVEL WITH THE TEXT — Izzy
  reported it a SECOND time, and the first measurement was of my own mock.**
  I measured Chrome's tab-title centroid on a canvas with
  **`textBaseline='middle'`**, got 8.05, and concluded box-centre was the
  target. **That is a construction I invented, not Chrome's layout.** Measured
  the way Chrome actually lays a tab out: **Segoe UI 12px has fontBoundingBox
  ascent 13 / descent 3 — exactly a 16px line box — so the baseline sits at
  y=13 and a lowercase string's ink runs rows 4..16, optical centre y=10.0**
  (agreed three ways: ink bbox, x-height band, mass centroid). **So a
  box-centred mark sits 2px HIGH against the word.**
  ⛔ **It bites THIS mark especially because it is only ~7px tall** — a thin
  band floating in the upper half of the text's ink instead of straddling it.
  A conventional favicon fills its 16px box (rows 0..15), brackets the text's
  ink, and reads level, which is why the whole web is not visibly misaligned.
  ✅ **`OPTICAL_DROP_FRAC = 1.5/16`**, applied at source resolution.
  ⛔⛔ **A FULL 2/16 puts the centroid exactly on the measured 10.0 AND IZZY
  CALLED IT "a tiny bit too much" — measured-centre and LOOKS-centred are not
  the same thing here.** The eye compares the mark against the x-height BODIES
  of the word, and a form reads as centred sitting a touch ABOVE the arithmetic
  middle. Picked by rendering **1.0 / 1.25 / 1.5 / 1.75 / 2.0** against text
  rasterised by Chrome itself and looking: 1.75 and 2.0 hang low, 1.0 reads
  high, **1.5 sits level**. Sharpness is flat across all five (hard-edge pixels
  50-53%), so a fractional position costs nothing.
  ⛔ **Do not "correct" it back to 2/16 to match the measurement.** It is a
  FRACTION so every frame agrees — **Chrome uses the 32px frame on a HiDPI
  display**, so a pixel count would only be right at one DPR.
  ⛔ **COST, stated plainly: any surface showing the icon with NO text beside
  it — a pinned tab, or a Windows pinned-site shortcut, which reads this same
  .ico — now shows the mark low in its box.** Deliberate trade: the favicon's
  job is overwhelmingly tab strip and bookmarks bar, both of which pair it
  with text. **The desktop app has its OWN icon set and is unaffected**, and
  `apple-icon.png` is generated from a different source and is untouched.
  ⛔ The guard now targets **box-middle + OPTICAL_DROP_FRAC**; replayed against
  the box-centred build it reports **-2.00 / -4.00 / -6.00px, all -12.5%**.
- ⛔⛔ **THE RULE THIS COST TWO ROUNDS: when you measure a thing to align
  against, measure THE REAL LAYOUT, not a canvas you built to stand in for it.**
  `textBaseline='middle'` centres the em box; CSS centres the LINE box, and for
  a font with asymmetric ascent/descent those differ by 2px at 12px. Both of my
  first two answers were confidently wrong in the same direction, and Izzy's eye
  was right both times.
- ✅ **`apple-icon.png` DELIBERATELY KEEPS ITS PLATE** — iOS composites a
  transparent touch icon onto **BLACK**, so the Add-to-Home-Screen icon would
  come out as a mark on a black square. A `--check` guard fails if it ever loses
  its opacity.
- ✅ **What ships:** `apps/portal/app/favicon.ico` (**16 + 32 + 48**) and
  `apps/portal/app/apple-icon.png` (180, the "Add to Home Screen" icon). Both are
  **Next.js App Router FILE CONVENTIONS**, so Next injects
  `<link rel="icon">` and `<link rel="apple-touch-icon">` into every page's
  `<head>` by itself — **`app/layout.tsx` is UNCHANGED and must stay that way.**
  ⛔ Do not also hand-write an icon `<link>`: two mechanisms for one tag is how
  they drift, and Next already puts favicon.ico **first** in the icon list
  (`resolve-metadata.js:537`, it special-cases exactly that filename).
- ⛔⛔ **DO NOT PUT IT IN `apps/portal/public/`.** A file there is served at
  `/favicon.ico` too, so it *looks* equivalent — but it bypasses Next's metadata
  layer entirely, ships with **no `<link>` tag** and **no content hash**, and a
  browser's favicon cache is one of the stickiest caches there is. That path is
  what the 2026-08-16 rebrand section correctly refused; the file convention is
  the answer it was waiting for.
- ⛔ **The artwork is BLUE 2B, and the other two favicons in the kit are traps.**
  `docs/brand/loopcom/icon-refinement-2026-08/new-apps-icons/` carries **three**
  favicon pairs: `blue-2b/` (Izzy's pick, the same mark the Android launcher and
  the Windows app ship), `navy-2a/` (the DARK-THEME app icon) and a **top-level**
  `favicon-16/32.png` which is the **pre-refinement design** — looking right by
  filename is exactly how the wrong one gets shipped.
- ⛔ **A `prefers-color-scheme` favicon pair was considered and REFUSED.** It
  follows the **operating system**, which routinely disagrees with the portal's
  own light/dark toggle — the same mismatch that rendered billing as a white slab
  inside a dark app ([[billing-must-use-connect-theme-tokens]]). One blue mark,
  and it was **measured on both tab strips** (light `#f2f2f4` and dark `#212124`)
  before shipping, not eyeballed.
- ⛔⛔ **THE .ico IS ASSEMBLED BY HAND, AND `Image.save(..., format="ICO",
  sizes=[...])` IS THE TRAP:** Pillow downsamples **ONE** source for every entry,
  so the 16px frame comes out of the biggest render and the thin strokes average
  into the plate. ⛔ **All three frames now come from the 1024 master** — the
  kit's hand-drawn 16 and 32 favicons are flattened composites with the plate
  painted into the pixels, so they cannot be keyed at that size. That is the one
  thing cutting the background out costs: slightly less hand-hinting at 16px.
- ⛔ **Every entry is BMP/DIB, not PNG, and the DIB height is DOUBLED.** PNG
  entries are fine in every modern browser, but Windows reads this same file for
  a pinned site / desktop shortcut and several shell surfaces render a small PNG
  entry **BLANK** — an all-PNG .ico opens perfectly in a viewer and ships an empty
  shortcut. The doubled `biHeight` is mandatory (the format reserves the lower
  half for the AND mask) or every frame renders squashed into the top half.
  Writer copied from the proven one in `scripts/desktop-loopcom-windows-assets.py`.
- ✅ **`python scripts/portal-favicon-assets.py --check` verifies the CONTENT, not
  just that a file exists** — it decodes each frame out of the shipped .ico and
  compares it byte-for-byte against a freshly re-derived master. ⛔ **Proven
  non-vacuous:** planting the previous PLATED favicon fails all three frames, as
  does a Pillow-downsampled .ico and the **navy** variant. Re-run after any
  brand-kit change.
- ✅ **Proven in a REAL browser and a REAL Next render, not by reading code:**
  Chrome decoded the exact shipped bytes (`image/x-icon`, 14,510 b, largest frame
  48 — so it parses every entry); a running dev server emitted
  `<link rel="icon" href="/favicon.ico" type="image/x-icon" sizes="16x16"/>` **and**
  the apple-touch tag; `/favicon.ico` served **200 byte-identical** to the
  committed file; and the tag is present on `/`, `/login` and `/meet/...`, i.e.
  every page under the single root layout — which includes the public pay and
  onboarding pages. ⚠️ The `sizes="16x16"` is Next reading only the first entry and
  is cosmetic: it is the only declared icon, so the browser uses the .ico and
  picks the best frame inside it.
- ✅✅ **DEPLOYED AND PROVEN IN A REAL CHROME TAB ON PRODUCTION, ON BOTH
  HOSTNAMES (2026-08-23).** `app-portal-1` `.build-commit` = **`4972f0c8`** (the
  background-cut-away commit). Measured from real Chrome, not curl: on
  **`app.loopcom.net`** the head carries
  `<link rel="icon" href="/favicon.ico" type="image/x-icon">` plus the
  apple-touch tag, `/favicon.ico` answers **200 `image/x-icon`, 14,510 bytes**,
  the ICO parses to **all three frames (16/32/48)**, and **Chrome
  `createImageBitmap` DECODED it (48×48)** — then rendered the mark correctly
  against both the light (`#f2f2f4`) and dark (`#212124`) tab-strip colours.
  **`app.connectcomunications.com` returns the byte-identical file** (same
  14,510 bytes, same rolling hash `3554451152`), which is expected: the two
  hostnames are two nginx vhosts in front of **one portal container**.
  `python scripts/portal-favicon-assets.py --check` → `favicon assets OK`.
- ⛔⛔ **THE THING THAT WILL BE MISREPORTED AS A BUG, AND IT WAS ON 2026-08-23:
  "the favicon is on connectcomunications.com but NOT on loopcom.net" IS
  IMPOSSIBLE AS A SERVER FACT — one container serves both, and the bytes were
  proven identical from Chrome itself.** What differs is the **browser's favicon
  cache, which is keyed PER ORIGIN**: a tab that visited `app.loopcom.net`
  before this shipped has "no favicon" cached for *that origin* and keeps
  showing the blank/default one long after the other hostname updated. **Fix is
  on the viewer, not the server** — hard reload the loopcom tab
  (Ctrl+Shift+R), or fully close and reopen the desktop app. ⛔ **Do NOT
  redeploy, re-cut the artwork, or add a `<link>` to `layout.tsx` on this
  report — verify the served bytes on the hostname that "doesn't work" first**
  (recipe above: fetch `/favicon.ico` in that origin and compare size + hash).
  ⛔⛔ **AND LATER ON 2026-08-31 IZZY REVERSED THAT REVERT — THE CUT-AWAY IS
  THE ONE HE WANTS, ON EVERY SURFACE.** The morning's `83474789` swapped the tab
  icon from the cut-away mark to the designer's plated tile; he watched it change
  under him — *"before there was the right one, then it started flip-flopping, and
  now there's only the wrong one"* — then, flatly: *"That was the wrong one. It's
  supposed to be the other one … use that same file for all of them."*
  ✅ **`83474789` IS REVERTED and the same file ships everywhere:**
  `apps/portal/app/favicon.ico` and `scripts/portal-favicon-assets.py` are back to
  their pre-`83474789` state (favicon sha256 `5c19a952…`), and
  `website/public/favicon.ico` + `website/public/assets/img/favicon.ico` are
  **byte-identical to the portal's**. The website had never carried this artwork at
  all — it was still the pre-rebrand glowing infinity on transparent, a single 16px
  frame.
  ⛔ **So the PLATED tile is the rejected one now. Do not restore it, and do not
  read the 100%-opaque measurement as an argument for it** — that measured
  COVERAGE, not legibility. A solid blue tile with a faint mark inside reads as a
  blue square; the cut-away reads as a clean infinity in both light and dark tab
  strips. Mistaking coverage for legibility is exactly what made the 08-31 morning
  session revert the wrong way.
  ⛔⛔ **THE FLIP-FLOP WAS REAL AND IT WAS NOT TWO FILES.** The portal serves ONE
  favicon URL (one `<link rel="icon">`, no manifest) and both hostnames serve
  identical bytes — what changed under him was Chrome resolving between his cached
  copy and the freshly deployed one across the 07:42 swap. ⛔ **A tab icon at DPR
  1.25 renders at 20 device px**, so a 16px frame is UPSCALED and reads mushiest of
  all; judge any favicon at 20px, never at 16, and never from the .ico's own frames
  viewed large.
  ⛔ **THE LESSON: identical bytes prove the two hostnames agree; they do NOT prove
  the shipped artwork is right, and neither does an opacity number.** When someone
  says one side looks better and both sides serve the same file, the thing they like
  is an OLDER BUILD — get it out of git and compare the RENDERS at real tab size.
  ⏳ **Gap, deliberately not built:** the website icons are a hand copy of the
  portal's, so there is no `--check` guard on them the way
  `scripts/portal-favicon-assets.py --check` guards the portal's. If they drift,
  nothing fails.
- ⚠️ **Noticed in passing, NOT touched:** `apps/desktop/assets/_f.ico` is
  untracked, 1,086 bytes and **not a valid image** — a stray from another
  session's desktop-icon work, unrelated to the portal.
