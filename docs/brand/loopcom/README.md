# LoopCom brand assets — Signal Core

This is the canonical LoopCom logo kit. Izzy chose it on 2026-08-16 from four
competing sets that existed only on his machine and in no repo at all.

`README.txt` beside this file is the kit's OWN spec sheet, written by whoever
produced it. Read it for clear-space, minimum sizes and per-folder guidance.
This file records only the decisions Connect made about it.

## ⛔ Which set won, and why the other three are not here

Four LoopCom logo families were on Izzy's machine on 2026-08-16. Only Signal
Core is in git. If someone hands you a LoopCom logo that does not look like the
files here, it is one of the rejected three — check before using it.

| Set | Where it was | Why not |
|---|---|---|
| **Signal Core** (blue chrome) | `Downloads\loopcom-signal-core-assets.zip` | ✅ **CHOSEN.** 79 files, the only set with light-surface masters, a full favicon set incl. `.ico`, and iOS + Android app icons in both polarities. |
| Aurora (teal chrome) | `Downloads\loopcom-brand-assets.zip`, `loopcom-official-logo-aurora.png` | Same artwork, teal instead of blue. Fewer files. Its filename says "official" and its README says "final masters" — ⛔ both are wrong now, don't be misled by them. |
| Trio lockups (blue wireframe) | `Downloads\loopcom-trio-lockups.zip` | 6 dark-only PNGs. No icon set, no favicon, no light variant. |
| July vector kit (flat indigo) | `Documents\Codex\2026-07-21\loopcom-rebranding-kit` | A completely different look — flat vector wordmark, indigo/Poppins. The **only** set with real SVGs. Kept in mind if we ever need vector; not the brand. |

## ⛔ Facts that will cost you time if you don't know them

- **The tagline is baked into the artwork.** Every lockup carries "THE AI
  COMMUNICATIONS PLATFORM" as pixels. It cannot be removed, restyled or
  translated without a re-render by whoever made the kit. A screen using this
  lockup must not add a tagline of its own — it would be the second one.
- **There is no vector. Every file here is PNG.** Sizes stop at 1672×941, so
  anything needing a larger or arbitrary-resolution render (large print, a
  billboard, an SVG favicon) is not possible from this kit as it stands.
- **`masters/loopcom-icon-mark.png` is OPAQUE**, despite `README.txt` claiming
  everything except the two store icons is transparent. It carries a baked dark
  background and cannot sit on a light surface. Verified by reading the PNG
  colour-type byte, not by eye. For small marks use `webapp/loopcom-icon-*.png`
  or `favicon/*` — those are genuinely RGBA.
- **The colours were already ours.** Signal Core specifies
  `#22A8FF → #4F7BFF on #0C1218`. Those are exactly the portal's live
  `--accent`, `--accent-2` and `--bg` in `apps/portal/app/globals.css`. This is
  a coincidence, not a plan — but it means adopting this logo needs **no new
  colour token anywhere**. Deep-ink variants for light backgrounds are
  `#052758` / `#053874`.
- **Store icons must be the opaque ones.** The App Store and Play both reject
  transparent icons. `app-icons/store-{dark,light}-1024-opaque.png` exist for
  exactly this; the transparent ones are for in-app use.

## Where the files live

- **`docs/brand/loopcom/`** (here) — the whole kit, 79 files, ~12 MB. This
  directory is the archive of record. ⛔ It is under `docs/`, which
  `.easignore:66` excludes, so it costs mobile EAS builds nothing. Do not move
  the bulk of it out from under `docs/`.
- **`apps/portal/public/brand/loopcom/`** — the 13 files the portal would serve
  (tight lockup, nav lockups incl. light, square icons, favicons), ~1.1 MB.
  ⛔ `apps/portal/public/` is **not** excluded from EAS, so every file added
  there is uploaded on every mobile build. Keep that folder lean.

## ⏳ What is NOT wired up

Committing these files changed no behaviour anywhere. As of 2026-08-16 nothing
in the product references them:

- The login page still reads "Connect Communications" with no logo at all.
- The favicon is unchanged — the files sit under
  `apps/portal/public/brand/loopcom/favicon/`, deliberately **not** at the
  `public/` root, because a file at that root is served as `/favicon.ico` and
  would silently rebrand every page the moment it deployed.
- Mobile and desktop app icons, invoice templates, welcome and invite emails all
  still carry the old Connect branding.

⛔ The rebrand is therefore **half a decision**: the app is named "Loopcom" on
iOS, the portal says "Connect Communications", and this logo says "LoopCom". A
customer who installs Loopcom currently signs in to a company they have never
heard of. Settle the naming before wiring any of this in — the file placement
above is the easy part.
