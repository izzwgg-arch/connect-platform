# ⛔ AGENT HANDOFF — the LoopCom logo is in the repo and LIVE on the sign-in page (2026-08-16) — READ FIRST before any LoopCom branding work, before putting a logo on any screen, or before believing a logo handed to you is the current one

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_LOOPCOM_BRAND_ASSETS_2026-08-16.md`**
(brand kit + the rebuilt `/login` — portal **DEPLOYED and verified over public
HTTPS**, job `8e6a3525`, commit `140dec3e`. Everything else still unwired.)

- ⛔ **THE RULE: when a brand asset is missing, say so and ask — do not draw
  one.** A search for a LoopCom logo found none in the repo, and this session
  invented three marks. They already existed as **production files** on Izzy's
  machine, in four conflicting sets, in no repo at all. *"There is a logo for
  everything."* An asset absent from git is not an asset that doesn't exist.
- ⛔ **Four LoopCom sets exist and the filenames LIE about which is canonical.**
  The rejected teal set is the one named `loopcom-official-logo-aurora.png`
  whose README says *"final masters."* Izzy chose **Signal Core** (blue chrome)
  on 2026-08-16 — the only set with light-surface masters, a full favicon set
  incl. `.ico`, and iOS + Android icons in both polarities. The others (aurora,
  trio wireframe, and a July flat-indigo *vector* kit) are **not** in git. Ask,
  never infer.
- **Where:** whole kit in **`docs/brand/loopcom/`** (~12 MB — under `docs/`,
  which `.easignore:66` excludes, so mobile builds pay nothing); the 13 files
  the portal would serve in **`apps/portal/public/brand/loopcom/`** (~1.1 MB).
  ⛔ `apps/portal/public/` is **NOT** easignored — keep it lean.
  `docs/brand/loopcom/README.md` has the per-file guidance.
- ⛔ **The tagline is baked into the artwork** — "THE AI COMMUNICATIONS
  PLATFORM" is pixels in every lockup, unremovable without a re-render, so a
  screen using it must not add a second tagline. ⛔ **No vector exists** (all
  PNG, max 1672×941). ⛔ **`masters/loopcom-icon-mark.png` is OPAQUE** despite
  the kit README claiming otherwise — proven from the PNG colour-type byte
  (`xxd -p -s 25 -l 1`), not by eye; use `webapp/loopcom-icon-*` or `favicon/*`
  for small marks. ⛔ **Never CSS-filter the dark art to fake light** — a real
  `-light` file ships for every placement.
- ✅ **Adopting it needs NO new colour token.** Signal Core specifies
  `#22A8FF → #4F7BFF on #0C1218` — exactly the portal's live `--accent`,
  `--accent-2`, `--bg` (`globals.css:3409`). Coincidence, but it holds.
- ⛔ **The commit landed under ANOTHER session's message** (`c0fd007b`, "docs:
  the PBX already ships a queue wallboard") because that session ran a blanket
  `git add` **between** this one's `git status` and its explicit-path `git add`.
  **Staging explicit paths does NOT protect your untracked files from another
  session's blanket add** — the exposure window is however long you leave new
  files untracked. Fix: `git add` new files the moment you create them, and
  re-check `git diff --cached --name-only` **immediately before commit**, not
  just before add. History deliberately NOT rewritten (another session was
  live). Files verified byte-identical by sha256 against source, 93 on origin.
- ✅ **`/login` IS LIVE with the logo.** `apps/portal/app/login/page.tsx` +
  a `.lc-login-*` block appended to `globals.css`. The wordmark sits INSIDE the
  card above Email; page styled from `--bg`/`--panel`/`--text`/`--border`/
  `--accent`, so it follows the **in-app** theme switch, not the OS. ⛔ **ONE
  transparent PNG serves both themes on purpose — Izzy explicitly rejected the
  kit's deep-ink light variant ("I never approved any other colors"). Do NOT add
  a light-mode logo file, a dark plate behind it, or any tagline.** Asset is
  `/brand/loopcom/loopcom-wordmark-560.png` (560×99, 81 KB).
  **Tagline removed by CROPPING** the source at y=253 — the two ink bands are
  y13–238 (wordmark) and y266–303 (tagline) with a clean gap — never by an edit
  or a background remover; recipe in `docs/brand/loopcom/derived/README.md`.
  No sign-in LOGIC changed.
- ⛔ **`/login` renders CLIENT-SIDE, so `curl https://…/login | grep` PROVES
  NOTHING** — you get a 4.8 KB cached shell (`x-nextjs-cache: HIT`) with no
  markup, and a grep for the OLD copy also comes back "gone", which reads as a
  successful verification and is a **false positive**. Verify from the built
  bundles instead: the live stylesheet
  (`/_next/static/css/<hash>.css` → `.lc-login-logo{width:252px…}`) and the page
  chunk (`/_next/static/chunks/app/login/page-<hash>.js` → the asset path and
  `lc-login-card`). Both were checked over public HTTPS on 2026-08-16.
- ✅ **SUPERSEDED 2026-08-23 — the favicon IS wired now (Izzy asked for it):
  see the dedicated favicon section near the top of this file.** It went to
  `apps/portal/app/favicon.ico`, the Next FILE CONVENTION, **not** `public/` —
  the warning below was about `public/`, and it still stands for that path.
  ⚠️ App icons, invoices and invite emails were the rest of this bullet and the
  invoice/receipt half has since moved too (see the invoice section). ⏳ **Nobody has opened the new page in a real browser** — it is
  proven from the shipped bundles, not by a human signing in.
- ⛔ **The rebrand is half a decision and customers can see it.** Portal says
  "Connect Communications", the iOS app is named "Loopcom", the logo says
  "LoopCom". Three login mockups were shown to Izzy 2026-08-16; he has not
  picked one. **Don't build the login page until he does, and don't wire the
  favicon / app icons / invoices / emails until the naming is settled** — those
  reach customers.
