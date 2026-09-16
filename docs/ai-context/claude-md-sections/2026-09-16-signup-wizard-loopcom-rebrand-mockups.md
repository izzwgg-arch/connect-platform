# Sign-up wizard (/onboarding/[token]) Loopcom rebrand — MOCKUPS ONLY, awaiting Izzy — 2026-09-16

Izzy, 2026-09-16: *"rebrand the onboarding wizard with the loopcom theme and logo show me mockups"*

Mockup artifact: **https://claude.ai/artifact/KHYzqfMVjWgnwE5Gbh5MmX** (source in the session scratchpad, logos embedded as data URIs). **Nothing built, nothing committed to the portal.**

## What the live wizard looks like today (read from source)
- `apps/portal/app/onboarding/[token]/page.tsx` header (two copies, ~L970 and ~L1074): a CSS gradient square `.ob-logo-mark` (`#2f6bff → #6366f1`, purple) + the text **"Connect"** in `.ob-logo-text`. No Loopcom logo at all.
- `apps/portal/app/onboarding/onboarding.css` has its OWN palette (`--accent:#3b82f6`, indigo glows, `#818cf8` progress gradient), NOT the portal's Loopcom tokens (`--bg:#0c1218`, `--accent:#22a8ff`, `--accent-2:#4f7bff`, `--panel:#141f2b`, `--border:#26374a`).
- The invalid-link screen still says *"contact your Connect Communications contact"* (page.tsx ~L940) — customer text, violates the Loopcom brand rule.
- Mobile layout lives in `mobileWizard.tsx`; finish screen in `success/page.tsx` ("Your phone system is ready" / "Set up what callers hear →").

## What the mockups propose
- **Option A (recommended):** same one-column layout, sign-in-page skin — wordmark `/brand/loopcom/loopcom-wordmark-560.png` in the header (ONE file both themes, per the login rule), accent glow, 2px gradient hairline atop the card (`.lc-login-card::before`), gradient progress + buttons, uppercase letter-spaced labels. Shown: Step 1 dark, Step 3 light, Review dark, finish light, phone Step 2 dark + Step 7 light.
- **Option B:** desktop left brand rail (wordmark + vertical step list + support line), form on the right; rail hidden on phones → same as A.
- Scope when built: `onboarding.css` tokens + header markup + the Connect Communications string. Sola payment, autosave, step logic and tracking untouched.

## ⛔ Traps for whoever builds it
- ⛔ Never add a light-mode logo variant or a `filter` on the wordmark — the 2026-08-16 rebrand rejected both (see `2026-08-16-the-brand-is-loopcom-lowercase-c-and-it-is-live.md`).
- ⛔ The wizard follows the OS theme + its own `ob-theme` localStorage toggle, NOT the portal's in-app theme — keep that behaviour unless Izzy asks otherwise.
- ⛔ `/onboarding` renders client-side: `curl | grep` proves nothing — verify from the shipped chunk (same trap as `/login`).
- ⛔ The mockups' prices ($35) and numbers are EXAMPLES; the page is marked so.
- ⏳ Waiting on Izzy: pick A or B (or changes), then build + deploy portal.
