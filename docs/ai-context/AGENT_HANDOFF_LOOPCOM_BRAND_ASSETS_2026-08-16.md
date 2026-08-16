# AGENT HANDOFF — the LoopCom logo existed for a month and was in no repo (2026-08-16)

**Status: brand assets COMMITTED AND PUSHED (93 files, inside commit `c0fd007b`).
⏳ Nothing is wired up — no code references them, nothing deployed, the login
page is untouched.**

Read this before: any LoopCom branding work, any "put the logo on X" task, or
before believing a logo someone hands you is the current one.

---

## 1. The finding

Izzy asked for login-page mockups "with the LoopCom logo." A search of the repo
found **no LoopCom asset of any kind** — the only brand file was
`apps/portal/public/connect-logo.svg` (blue signal arcs, "Connect
Communications"), and "Loopcom" appeared only as the iOS app name
(`CFBundleName: 'Loopcom'` in `apps/mobile/app.config.ts:102`) and the
TestFlight group name.

⛔ **The correct move was to say so and stop, not to draw one.** The first pass
of this task produced three invented marks. Izzy's answer: the logos already
existed, as production files, on his machine — *"There is a logo for
everything."* They were never in git.

They were in **four** places, and they conflict:

| Set | Location | Date | Format |
|---|---|---|---|
| **Signal Core** (blue chrome) ✅ | `Downloads\loopcom-signal-core-assets.zip` | Aug 14, re-pulled 15:50 | 79 PNG |
| Aurora (teal chrome) | `Downloads\loopcom-brand-assets.zip` + `loopcom-official-logo-aurora.png` + `loopcom-web-assets.zip` | Aug 14 | PNG |
| Trio lockups (blue wireframe) | `Downloads\loopcom-trio-lockups.zip` | Aug 13 | 6 PNG |
| July vector kit (flat indigo) | `Documents\Codex\2026-07-21\loopcom-rebranding-kit` | Jul 21 | 21 SVG + PNG |

⛔ **Do not trust a filename or a README to tell you which is canonical.** The
rejected aurora set is the one literally named `loopcom-official-logo-aurora.png`
and the one whose README calls itself *"final masters."* Izzy chose **Signal
Core** on 2026-08-16. Ask him, don't infer.

## 2. Where they are now

- **`docs/brand/loopcom/`** — the whole kit, 79 files + a repo-specific
  `README.md`, ~12 MB. Archive of record. Under `docs/`, which
  `.easignore:66` excludes, so it costs mobile EAS builds nothing.
  ⛔ Don't move the bulk out from under `docs/`.
- **`apps/portal/public/brand/loopcom/`** — 13 files, ~1.1 MB: tight lockup, nav
  lockups (incl. the light-surface one), square icons 32–256, favicons.
  ⛔ `apps/portal/public/` is **not** in `.easignore`, so every file there is
  uploaded on every mobile build. Keep it lean.

`docs/brand/loopcom/README.md` carries the full per-file guidance and the
rejected-set table. Read it before using any file.

## 3. Facts about the kit that will cost time if you don't know them

- ⛔ **The tagline is baked into the artwork.** Every lockup carries "THE AI
  COMMUNICATIONS PLATFORM" as pixels. It cannot be removed, restyled or
  translated without a re-render. A screen using the lockup must not add its own
  tagline — it would be the second one on screen.
- ⛔ **There is no vector anywhere in Signal Core.** All PNG, largest 1672×941.
  Large print, an SVG favicon, or any arbitrary-resolution render is not
  possible from this kit. The *July indigo kit* is the only set with real SVGs,
  and it is a completely different logo.
- ⛔ **`masters/loopcom-icon-mark.png` is OPAQUE** even though the kit's own
  `README.txt` says everything but the two store icons is transparent. It has a
  baked dark background and cannot sit on a light surface. Proven by reading the
  PNG IHDR colour-type byte (`06` = RGBA, `02` = RGB), not by eye —
  `xxd -p -s 25 -l 1 <file>`. For small marks use `webapp/loopcom-icon-*.png`
  or `favicon/*`, which are genuinely RGBA.
- ✅ **The colours were already ours.** Signal Core specifies
  `#22A8FF → #4F7BFF on #0C1218` — exactly the portal's live `--accent`,
  `--accent-2` and `--bg` in `apps/portal/app/globals.css:3409`. Coincidence,
  not planning, but it means adopting this logo needs **no new colour token**.
  Deep-ink variants for light backgrounds: `#052758` / `#053874`.
- **Light surfaces have their own file** — `webapp/loopcom-nav-h64@2x-light.png`,
  `masters/loopcom-logo-light.png`, and full `ios-light-*` / `android-light-*`
  icon sets. ⛔ Never CSS-filter the dark artwork to fake a light version; chrome
  gradients turn to mud.
- **Store icons must be opaque.** `app-icons/store-{dark,light}-1024-opaque.png`
  exist because the App Store and Play both reject transparent icons.
- Minimum sizes from the kit: lockup **180 px** wide, mark alone **24 px**.
  Clear space = the infinity's height on all sides.

## 4. ⛔ The commit went in under someone else's message

The brand files are in commit **`c0fd007b` — "docs: the PBX already ships a
queue wallboard, and Gesheft is already in it."** That message has nothing to do
with them. `git log` will never lead anyone here.

**What happened:** another session running in this same working tree ran a
blanket `git add` and committed **between** this session's `git status` check
and its `git add <explicit paths>`. The 93 brand files were untracked in the
shared tree at that moment, so they were swept into that session's commit along
with its two files. Unstaging afterwards was useless — the commit had already
landed.

⛔ **Following the "stage explicit paths, never `git add -A`" rule does NOT
protect you from this.** The rule protects against *your own* over-staging. It
cannot protect your untracked files from *another* session's blanket add. The
window is however long you leave new files sitting untracked.

**The mitigation, for next time:** when working in this tree alongside other
sessions, `git add` new files the moment you create them rather than at the end,
and re-run `git diff --cached --name-only` *immediately* before `git commit` —
not merely before `git add`. History was deliberately **not** rewritten; another
session was live in the tree, and a rebase there would have been far worse than
a misleading commit message.

**Verified after the fact, not assumed:** all 93 files are byte-identical to
source (`sha256sum` of the working file vs `git show HEAD:<path> | sha256sum`,
spot-checked across masters, webapp, favicon, app-icons and splash), 93 files
present on `origin/feat/ivr-migration-takeover`, remote tip `c0fd007b`. The
PNGs did **not** get CRLF-mangled — only the two `.md`/`.txt` files drew line-
ending warnings.

## 5. ⏳ NOT DONE — nothing is wired up

Committing these files changed no behaviour. As of 2026-08-16:

- `apps/portal/app/login/page.tsx` is **untouched** — still a bare `.panel` form
  headed "Connect Communications" with no logo at all.
- **The favicon is unchanged.** The files sit under
  `apps/portal/public/brand/loopcom/favicon/`, deliberately **not** at the
  `public/` root — a file at that root is served as `/favicon.ico` and would
  silently rebrand every page the moment it deployed. That is its own decision.
- Mobile/desktop app icons, invoice templates, welcome and invite emails all
  still carry Connect branding. The kit has files for every one of them.
- **Nothing was deployed.** No queue job, no container change.

## 6. The open question, which is bigger than the login page

⛔ **The rebrand is half a decision and it is currently visible to customers.**
The portal says "Connect Communications", the iOS app is named "Loopcom", and
this logo says "LoopCom — the AI communications platform". A customer who
installs Loopcom signs in to a company they have never heard of.

Three mockup directions for the login screen (split "Signal", centred "Dial
Tone", "Console") were built against the real lockup and shown to Izzy on
2026-08-16 as an artifact. He has not picked one. **Do not build the login page
until he does**, and do not wire the favicon, app icons, invoices or emails
until the naming is settled — those reach customers.
