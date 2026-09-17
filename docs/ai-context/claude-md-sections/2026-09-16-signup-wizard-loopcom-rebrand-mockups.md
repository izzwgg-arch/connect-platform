# Sign-up wizard (/onboarding/[token]) in the Loopcom look — BUILT + DEPLOYED (portal f77a2468) — 2026-09-16

Izzy, 2026-09-16: *"rebrand the onboarding wizard with the loopcom theme and logo show me mockups"* → mockups (artifact **KHYzqfMVjWgnwE5Gbh5MmX**) → *"go"* (Option A). Mid-build: *"For light mode change the infinity to the one that is to light mode … On the you're all set page"*.

## What shipped (commit `f77a2468`, portal only)
- **Header** on both wizard renders (full + scoped port/texting links) AND the finish page: `/brand/loopcom/loopcom-wordmark-560.png` (`.ob-logo-img`, 22px) replaces the purple CSS square + "Connect". One wordmark file for both themes (login rule).
- **`onboarding.css` tokens** moved to the portal's Loopcom palette. Dark = `#0c1218` / `#141f2b` / `#22a8ff → #4f7bff`. Light accent is a deeper **`#1683d8`** (the portal's `#22a8ff` is ~2.6:1 on white — too faint for eyebrow/label text). New token `--accent-2`. ⛔ **Token NAMES are unchanged on purpose** — `success/page.tsx`'s inline `<style jsx>` reads `--surface-3`, `--accent-strong`, `--good`, `--good-ink`.
- All purple literals (`#6366f1`, `#818cf8`, `#5b6ef5`) gone. Continue button + active progress segment = accent → accent-2 gradient. `.ob-card::before` = the sign-in card's 2px gradient hairline (`position:relative` added). Radius 15 → 18.
- **Finish page infinity:** dark = `loopcom-icon-256.png` (glowing), light = **new `public/brand/loopcom/loopcom-mark-light-248.png`** (premultiplied 248px resize of `docs/brand/loopcom/derived/loopcom-mark-light.png`). Switched by `.ob-mark-dark/.ob-mark-light` rules that mirror the wizard's own theme logic (OS preference unless `data-ob-theme` is set). The FAILED state keeps its old neutral icon (a brand mark on an error looked wrong).
- **Copy:** "contact your Connect Communications contact" → "contact Loopcom"; "On launch, Connect builds your tenant" → "Loopcom builds your account".
- ⛔ **Deliberate deviation from the mockup: field labels are NOT uppercase** — several are full questions ("What will you send, and how do people sign up to receive it?", "This is a cell phone (wireless) number").
- Untouched: the payment receipt block (`.ob-pay-*` hardcoded light colours, pre-existing), Sola, autosave, step logic, tracking.

## Proof
- tsc clean; onboarding-related portal tests 49/50 — the 1 failure is `nativeSelectSweep` flagging native `<select>`s in **creative studio** pages (pre-existing, not this change).
- Deploy: `deploy-direct.sh portal --commit f77a2468` (was the origin tip; live `9a04bb2c` was its ancestor). Container `.build-commit` = `f77a2468`, 0 restarts; shipped CSS has `ob-card:before` hairline, `#22a8ff`, zero `#6366f1`; the new mark 200 / 45,689 b on BOTH hostnames; "Please contact Loopcom for a new link" in the page chunk.
- ✅ **Seen in real Chrome on app.loopcom.net:** finish page of the Telnyx test sign-up in light (solid blue infinity shown, glowing one `display:none`, both images loaded) and dark (glowing one); wizard Step 1 in light and dark via the in-page toggle.
- 🧹 Opening the reusable test link (`/onboarding/test/stress-…`) spawned ONE fresh test draft (token `MU0_8sXE…`), untouched, nothing entered.
- ⏳ NOT PROVEN: steps 2–7, the phone layout and the scoped port/texting links were not looked at after deploy; no real customer has seen it. An already-open wizard tab keeps the old CSS until reload.

## ⛔ Traps
- ⛔ Never add a light-mode WORDMARK or a `filter` on it (2026-08-16 rule). The light-mode swap is for the INFINITY on the finish page only, at Izzy's ask.
- ⛔ `/onboarding` renders client-side — `curl | grep` proves nothing; check the shipped CSS/chunks or a real browser.
