# Connect / Loopcom Portal — Design System Reference (extracted from code)

All paths are relative to `C:\dev\projects\Connect 2\apps\portal\` unless stated otherwise.
Read-only audit; nothing in the repo was modified.

---

## 0. How theming actually works (read this before section 1)

- CSS convention, stated in the file itself: **bare `:root` is DARK** —
  `app/globals.css:3410` is `:root, :root[data-theme="dark"] { ... }` (dark values
  attached to BOTH selectors). `app/globals.css:38178-38180` has an explicit code
  comment confirming this: *"Bare :root is DARK here, per Connect's convention —
  light is opt-in."*
- `:root[data-theme="light"] { ... }` blocks only ADD/OVERRIDE properties on top of
  whatever the dark/bare block set. Since `:root[data-theme="dark"]` simply stops
  matching once `data-theme="light"` is set (different attribute value, not a
  specificity contest), any token defined ONLY inside the dark block and never
  redefined in a light block is **unset in light mode** (see the `--crm-*` finding
  in section 1).
- Runtime authority: `hooks/useAppContext.tsx`. React state defaults to
  `useState<ThemeMode>("light")` (`hooks/useAppContext.tsx:120`), then a `useEffect`
  reads `localStorage["cc-theme"]` and calls `setThemeState` if it holds `"dark"`/`"light"`
  (`hooks/useAppContext.tsx:149-151`). Persistence + DOM write happen in a second
  effect: `document.documentElement.dataset.theme = theme` then
  `safeStorageSet("cc-theme", theme)` (`hooks/useAppContext.tsx:429-430`).
  **Practical effect: on first paint, before that effect runs, `<html>` has no
  `data-theme` attribute at all, so the bare-`:root` DARK rules apply; a moment
  later the effect fires and (for a fresh visitor) flips it to light.** This is a
  real, code-verifiable FOUC risk (dark flash → light), not a hypothetical.
- `components/LoginThemeToggle.tsx:1-24` (doc comment) confirms this is the single
  source of truth and that no other component may keep its own theme state.
- `components/ThemeToggle.tsx` (in-app toolbar button) and
  `components/LoginThemeToggle.tsx` (segmented control) both just call the same
  `setTheme` from `useAppContext`.

---

## 1. TOKENS

### 1.1 Where every global `:root` block lives (all 9, found by exact-match grep of
`^:root\[data-theme="light"\] {$` / `^:root\[data-theme="dark"\] {$` / `^:root {$`)

| Line | Selector | Size | Purpose |
|---|---|---|---|
| `app/globals.css:3410` | `:root, :root[data-theme="dark"]` | 32 lines | **Base dark palette + base `--crm-*`** |
| `app/globals.css:12223` | `:root[data-theme="light"]` | 39 lines | **Base light palette** (surfaces, text, shadows, radii) |
| `app/globals.css:13749` | `:root, :root[data-theme="dark"]` | 24 lines | `--topbar-height` + `--console-*` + `--dash-*` (dark) |
| `app/globals.css:13775` | `:root[data-theme="light"]` | 23 lines | `--console-*` + `--dash-*` (light, aliases back to §1.2 tokens) |
| `app/globals.css:13810` | `:root` (bare, both themes) | 3 lines | `--nav-ease`, `--nav-ease-dur` (sidebar animation curve) |
| `app/globals.css:19423` | `:root[data-theme="light"]` | 3 lines | `color-scheme: light` + scrollbar colour (not custom props) |
| `app/globals.css:20324` | `:root[data-theme="light"]` | 13 lines | `--light-premium-*` glow/shadow tokens (billing "premium" surfaces) |
| `app/globals.css:38180` | `:root` (bare) | 5 lines | `--qb-ink-*` text-ink tokens (dark) |
| `app/globals.css:38186` | `:root[data-theme="light"]` | 5 lines | `--qb-ink-*` text-ink tokens (light, WCAG-adjusted) |

**Which wins when a token is set more than once at `:root[data-theme=...]` level:**
CSS cascades on specificity first; `:root[data-theme="dark"]` and
`:root[data-theme="light"]` never both match the same live document (the attribute
only ever holds one value), so it isn't really a specificity fight — it's "does this
selector match the current `data-theme`". Within the SAME matching value (e.g. two
separate `:root[data-theme="light"] { }` blocks, both specificity `(0,2,0)`), **later
in the file wins** for any property both blocks set. Verified concretely for `.panel`,
`.btn`, `.input`, `.table`, `.chip` (not custom properties, but same rule) in section 4.

### 1.2 Base tokens — DARK (`app/globals.css:3410-3441`)

```
--bg: #0c1218          --bg-soft: #101923      --panel: #141f2b        --panel-2: #1a2635
--text: #e1e9f1         --text-dim: #8ea0b2     --accent: #22a8ff       --accent-2: #4f7bff
--border: #26374a       --success: #34c27b      --warning: #f0b655      --danger: #ea6068
--info: #4ab2ff          --shadow: 0 8px 30px rgba(0,0,0,0.24)
```
Plus, same block, `--crm-*` GLOBAL (dark only — see 1.4):
```
--crm-bg: var(--bg-soft)          --crm-surface: var(--panel)        --crm-surface-2: var(--panel-2)
--crm-border: var(--border)       --crm-text: var(--text)            --crm-text-muted: var(--text-dim)
--crm-accent: var(--accent)       --crm-accent-soft: color-mix(in srgb, var(--accent) 16%, transparent)
--crm-danger: var(--danger)       --crm-warning: var(--warning)      --crm-success: var(--success)
--crm-radius: 0.75rem             --crm-radius-lg: 1rem              --crm-shadow: 0 1px 2px rgba(0,0,0,0.28)
--crm-section-gap: 1rem
```

### 1.3 Base tokens — LIGHT (`app/globals.css:12223-12261`)

```
--bg-app: #f6f8fb              --bg-gradient-start: #f8fafc     --bg-gradient-end: #eef2f7
--surface-1: #ffffff           --surface-2: #f8fafc             --surface-3: #f1f5f9
--text-primary: #0f172a        --text-secondary: #475569        --text-muted: #94a3b8
--border-soft: rgba(15,23,42,0.08)
--accent: #3b82f6              --accent-soft: rgba(59,130,246,0.12)
--success: #22c55e             --danger: #ef4444                --warning: #f59e0b
--shadow-sm: 0 1px 2px rgba(0,0,0,0.04)
--shadow-md: 0 8px 24px rgba(0,0,0,0.06)
--shadow-lg: 0 12px 40px rgba(0,0,0,0.08)
--radius-lg: 16px              --radius-md: 12px

/* then aliased onto the shared names every component actually reads: */
--bg: var(--bg-app)            --bg-soft: var(--bg-gradient-start)
--panel: var(--surface-1)      --panel-2: var(--surface-2)
--text: var(--text-primary)    --text-dim: var(--text-secondary)
--accent-2: #2563eb
--border: color-mix(in srgb, var(--border-soft) 78%, var(--text-muted))
--info: var(--accent)          --shadow: var(--shadow-lg)
--light-surface / --light-surface-raised / --light-surface-soft / --light-border-strong / --light-ring
--light-shadow-sm/md/lg (= --shadow-sm/md/lg)
```
**`--radius-md`/`--radius-lg` are LIGHT-ONLY tokens with no dark equivalent**, and are
barely consumed platform-wide (only 4 usages of `var(--radius-md)`/`var(--radius-lg)`
in the whole 39k-line file) — most components hardcode radius values (10px/11px/12px/
14px/16px) directly rather than reading a shared radius scale. Do not assume a radius
token system exists for Works; there isn't a real one in Connect either.

### 1.4 `--crm-*` GLOBAL values — ⛔ IMPORTANT LIGHT-MODE GAP

Grepping every top-level (unscoped, i.e. not `.some-class { --crm-bg: ... }`) definition
of `--crm-bg` across the file: it is set **exactly once**, at `app/globals.css:3427`
inside the dark/bare block. The light global block (`app/globals.css:12223-12261`,
read in full) **does not define any `--crm-*` token**. Same is true for `--crm-radius`
(`:3438`) and `--crm-shadow` (`:3440`) — single occurrence, dark-only, confirmed by
grep of the literal declarations.

Consequence: `--crm-bg/-surface/-surface-2/-border/-text/-text-muted/-accent/-accent-soft/
-danger/-warning/-success/-radius/-radius-lg/-shadow/-section-gap` are **only defined
at the document root while `data-theme="dark"` (or unset).** In light mode, ANY markup
that reads one of these GLOBAL crm tokens **outside** of a page that re-scopes them
locally (dozens of feature pages do this — e.g. `.crm-queue-shell` at `:3155`,
`.crm-email-workspace` at `:4869`, etc. — but these are the FEATURE-SCOPED overrides
you told me to ignore) gets an **invalid/unset custom property**. For a non-inherited
CSS property (background-color, border-color) that resolves to fully transparent /
`initial`; for an inherited property (color) it silently falls through to whatever
ancestor `color` is in scope.

**This is not hypothetical — it hits real, currently-shipping markup.** Tailwind is
configured (`tailwind.config.js:14-29`) to expose `bg-crm-surface`, `border-crm-border`,
`text-crm-text`, `text-crm-muted`, `text-crm-accent`, `rounded-crm` as literal aliases
for `var(--crm-surface)`, `var(--crm-border)`, etc. (Tailwind `preflight` disabled at
`tailwind.config.js:9-11`, so it layers on top of `globals.css` rather than resetting
it.) `components/NotificationToast.tsx:73-99` uses exactly this Tailwind vocabulary
(`bg-crm-surface`, `border-crm-border`, `text-crm-text`, `text-crm-muted`, `text-crm-accent`)
for the toast that pops out of `components/NotificationPanel.tsx:218`, which is mounted
in the global `Topbar` (`components/Topbar.tsx`) — **not** inside any `.crm-*`-scoped
page wrapper. So as shipped, **the global toast notification's border/background tokens
are unset in light theme.** Treat this as a known, reproducible defect to fix in Works
rather than a pattern to copy — Works' equivalent of a global toast should read the
`console-*` or `panel`/`border` tokens (which ARE defined for both themes), not bare
`crm-*`.

### 1.5 Console / dashboard tokens (`app/globals.css:13749-13798`)

Dark (`:13749`):
```
--topbar-height: 56px
--console-bg: #0b1016      --console-bg-soft: #0e141d   --console-panel: #131b26
--console-panel-soft: #192434   --console-border: #253446   --console-text: #dbe6f2
--console-muted: #8ea2b8   --console-accent: #2ba5ff    --console-success: #33bf7a
--console-warning: #f0b34c --console-danger: #e85b6b
--dash-bg: #0e141d   --dash-card: #131b26   --dash-card-border: #253446
--dash-radius: 14px  --dash-shadow: 0 4px 20px rgba(0,0,0,0.2)
--dash-incoming: #33bf7a  --dash-outgoing: #2ba5ff  --dash-internal: #a78bfa
--dash-missed: #e85b6b    --dash-total-line: #5eead4
```
Light (`:13775`) — mostly ALIASES back to the light base tokens from §1.3, plus a few
own hex values for chart colours:
```
--console-bg: var(--bg-app)          --console-panel: var(--surface-1)
--console-border: var(--border-soft) --console-text: var(--text-primary)
--console-accent: var(--accent)      --console-success/-warning/-danger: var(--success/warning/danger)
--dash-bg: var(--bg-app)  --dash-card: var(--surface-1)  --dash-radius: var(--radius-lg)
--dash-shadow: var(--shadow-md)
--dash-outgoing: #14b8a6 (own)  --dash-internal: #8b5cf6 (own)  --dash-total-line: #0ea5e9 (own)
```
`--topbar-height: 56px` is set ONLY in the dark block, but since it's a plain literal
(not theme-dependent) and never redefined in the light block, it simply persists —
this is the one console token that is genuinely theme-agnostic. Confirmed 56px is the
value actually consumed by `.topbar { min-height: var(--topbar-height); }`
(`app/globals.css:14818`) and `.console-body { height: calc(100vh - var(--topbar-height)); }`
(`app/globals.css:13827`).

### 1.6 Misc global tokens
- `--nav-ease: cubic-bezier(0.22, 0.61, 0.24, 1)`, `--nav-ease-dur: 200ms`
  (`app/globals.css:13810-13813`) — the ONE curve/duration used for the whole sidebar
  (panel width is NOT animated at all — see §3 — but everything else that moves in the
  drawer uses this pair).
- `--qb-ink-ok/-warn/-crit/-info` (`app/globals.css:38180-38191`) — a deliberately
  SEPARATE "ink" token set for TEXT on the "quality board" surfaces, distinct from
  `--success/-warning/-danger/-accent`, because (per the code comment at
  `:38169-38177`) the display colours fail contrast as TEXT on a light panel
  (measured 2.15–3.76:1) even though they're fine as fills/borders. Light values are
  hand-picked for ≥5.3:1 contrast (`#0f7a4a`, `#8a5a00`, `#c0293a`, `#1a63c4`). This is
  a good pattern to copy into Works: don't reuse a display/fill colour as text colour
  without checking contrast per theme.
- `--light-premium-glow/-cyan/-violet/-amber/-card-shadow/-card-shadow-hover`
  (`app/globals.css:20324-20337`) — light-only decorative tokens used by billing's
  "premium SaaS" card treatment; no dark equivalent (dark billing pages use a
  different local scheme).

---

## 2. TYPOGRAPHY

- **No `next/font` usage anywhere.** `app/layout.tsx` is a plain 10-line file — no
  font import, no `<link>` for Google Fonts, no `@font-face` anywhere in
  `app/globals.css` or `public/`. Confirmed by `grep -rn 'fonts.googleapis|next/font|@font-face'`
  across `app/` and `components/` — zero hits.
- Body font stack: `app/globals.css:12301` —
  `font-family: Inter, "Segoe UI", Roboto, Arial, sans-serif;` on `html, body`
  (`app/globals.css:12293-12303`). **Because "Inter" is never actually loaded as a
  webfont, it only renders if the OS happens to have it installed; on a stock Windows
  box the effective rendered font is "Segoe UI".** Treat "Inter" as aspirational
  branding, not a proven rendering — if Works wants real Inter, it needs to self-host
  or link it; Connect never did.
- `--font-mono` / `--font-sans` custom properties are **referenced but never defined**:
  every usage is `font-family: var(--font-mono, monospace)` /
  `var(--font-sans, sans-serif)` (`app/globals.css:12903/12940/12946/12951/12958/15787/
  16043/16185-16296/16356/16714/16813`, etc.) with no `--font-mono:`/`--font-sans:`
  declaration anywhere in the file. So every "monospace" element in the product (call
  numbers, extension numbers, durations, code snippets) is just the browser's generic
  `monospace`, and every "sans" element is the generic `sans-serif` fallback — not a
  deliberate custom stack. A couple of places bypass the token and hardcode a real
  stack: `ui-monospace, SFMono-Regular, Menlo, monospace` (`app/globals.css:25279`) and
  `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (`app/globals.css:30458`).
- No root `font-size` override — base is the browser default 16px; all sizing below is
  relative px values set per-rule, not a modular type scale.
- Heading sizes (canonical = LAST one in file, see §1.1 rule):
  - `.page-header h2` base: `font-size: 22px; font-weight: 700;` (`app/globals.css:12521-12524`)
    — **overridden** later to `font-size: 19px;` at `app/globals.css:15569-15571` (console
    redesign pass). **19px/700 is what ships.**
  - `.panel h3` base `font-size: 15px;` (`app/globals.css:12484`), overridden to
    `font-size: 13px;` at `app/globals.css:15437-15440`. **13px is what ships** for card
    titles (`DetailCard.tsx`, `SettingsSectionCard.tsx` both render `<h3>{title}</h3>`
    inside `.panel`).
  - `SectionHeader.tsx` renders a bare `<h3>` inside `.section-header` — no dedicated
    font-size rule for `.section-header h3` found; it inherits the generic `h1,h2,h3,h4,p
    { margin: 0; }` reset (`app/globals.css:12310-12315`) and otherwise whatever size
    `h3` computes to in context (usually the `.panel h3` 13px rule above, since
    `SectionHeader` is normally used inside a `.panel`).
  - `.qb-title` (`app/globals.css:38200`, "quality board" pattern) — separate,
    special-purpose heading style, not the general page-title pattern; treat as a
    one-off, not a reusable convention.
  - Metric numbers: `.metric-value { font-size: 18px; }`
    (`app/globals.css:12938`-ish base, and `app/globals.css:15457-15459` console override
    keeps 18px — same value both times).
- Letter-spacing: no single convention. Most common values across the file (by
  frequency): `0.08em` (18×, mostly uppercase eyebrow/kicker labels e.g.
  `.drawer-section-label`, `.page-kicker`), `0.06em`/`0.04em`/`0.05em`/`0.02em`/`0.1em`
  (all used on uppercase micro-labels), and small NEGATIVE values (`-0.01em` to
  `-0.04em`) used on large headline text for tightening. Treat "uppercase 10-11px label
  → +0.04 to +0.1em tracking" and "large heading → slight negative tracking" as the two
  real conventions; there's no single global letter-spacing token.
- Monospace usage: call/extension numbers (`.crc-number`, `.cdp-number`,
  `.ch-item-ext`, `.ch-item-duration`, `.cdp-hero-number` — all
  `app/globals.css:16185-16813`) all use `var(--font-mono, monospace)`, i.e. plain
  browser monospace as established above.

---

## 3. SHELL

Composition chain: `app/(platform)/layout.tsx` → `AuthGate` → `UiLanguageProvider` →
`layout/AppShell.tsx` → `components/PageShell.tsx` (renders `Topbar` + `SidebarNav` +
`<main className="console-content">`) + `FloatingAssistant` + `OnboardingSetupNudge`
mounted as siblings of the page content (`layout/AppShell.tsx:9-14`).

**⛔ Dead code warning:** `components/AppSidebar.tsx` and `components/HeaderBar.tsx`
exist in the repo (older `.sidebar`/`.header`/`.nav-link` class family, e.g.
`components/AppSidebar.tsx:11` renders `<aside className="sidebar">`) but are **not
imported anywhere else in the codebase** (`grep -rln 'AppSidebar|HeaderBar'
--include='*.tsx' .` returns only the two files themselves). Do not use them as a
reference for Works — the live shell is `SidebarNav.tsx` + `Topbar.tsx` described below.
`components/SidebarNavGroup.tsx` is likewise only imported by the dead `AppSidebar.tsx`.

### 3.1 Topbar (`components/Topbar.tsx`, styled in `app/globals.css:14780-14993`)
- Fixed header, `position: fixed; top:0; left:0; right:0;`
  (`app/globals.css:14817-14819`), `min-height: var(--topbar-height)` = **56px**.
- Layout: CSS grid, `grid-template-columns: auto 1fr auto;` (left / center / right)
  (`app/globals.css:14822`), padding `0 16px 0 12px`.
- Left (`.topbar-brand`, `components/Topbar.tsx:19-30`): hamburger `icon-btn` (Menu
  icon, lucide, size 18) that toggles the sidebar (rail↔expanded on desktop, drawer
  open↔closed on mobile), then `<LoopComLogo>` — no text label beside it (the comment
  in `Topbar.tsx:26-28` explicitly says the old "Connect" text fallback was removed).
- Center (`.topbar-center`): `<GlobalSearch>`, `max-width: 720px`
  (`app/globals.css:14853`).
- Right (`.topbar-right`, in DOM order): `<LanguageToggle>` (renders nothing unless
  Yiddish is enabled for that account) → `<QRPairingModal>` → `<FloatingDialer>` →
  `<NotificationPanel>` → `<ProfileMenu>`.
- Background: `linear-gradient(180deg, color-mix(console-bg-soft +2% accent) 0%,
  console-bg 100%)`, `border-bottom: 1px solid var(--console-border)`, `z-index: 200`.

### 3.2 Sidebar (`components/SidebarNav.tsx`, styled `app/globals.css:13815-14330`ish)
- Outer shell `.console-shell` = flex column, `height: 100vh`
  (`app/globals.css:13815-13822`).
- `.console-body` = flex row below the fixed header:
  `height: calc(100vh - var(--topbar-height)); margin-top: var(--topbar-height);`
  (`app/globals.css:13826-13832`).
- `.console-nav` (the sidebar `<aside>`) — **desktop widths** (`@media (min-width:
  1081px)`, `app/globals.css:13847-13866`): **280px expanded**, **72px collapsed
  ("rail")**. Class toggling only (`nav-rail` / `nav-expanded`) — the two states share
  ONE tree (see next bullet).
- ⛔⛔ **The width is deliberately NOT animated** — `app/globals.css:13853-13862`
  code comment: animating the width cost 5.5 dropped frames/toggle on the owner's
  Intel HD 4000 machine because the whole shell re-lays-out every frame; only
  `border-color` transitions (0.2s ease). **Do not animate the sidebar's width in
  Works.** What DOES animate uses `--nav-ease` / `--nav-ease-dur` (200ms,
  cubic-bezier(0.22,0.61,0.24,1)) — see `.console-nav.nav-no-anim` guard
  (`app/globals.css:13879-13888`) that disables all child transitions until the
  stored rail choice has painted once (`useSidebarRail`), so a returning visitor's
  collapsed sidebar never "unfurls" on load.
- Nav item anatomy (`.drawer-nav-link`, `app/globals.css:14034-14054`): CSS grid
  `34px 1fr auto` (icon well / label / trailing badge), `min-height: 36px`,
  `border-radius: 10px`, `border-left: 3px solid transparent`, `font-size: 13px;
  font-weight: 500;`, `color: var(--console-muted)`. Hover
  (`app/globals.css:14057-14060`): text → `--console-text`, background →
  `color-mix(console-panel-soft 88%, console-accent 4%)`. Active
  (`app/globals.css:14062-14067`): `font-weight: 600`, background
  `color-mix(console-accent 12%, console-panel-soft)`, **left border becomes
  `--console-accent`** (the primary active-state signal), subtle inset box-shadow.
  Icon well `.drawer-nav-icon` (`app/globals.css:14069-14078`): 30×30px, radius 8px,
  background `color-mix(console-panel-soft 70%, transparent)`; active state tints
  icon + well with `--console-accent` (`app/globals.css:14086-14090`).
  Icons are **lucide-react, size 18, strokeWidth 1.85** consistently
  (`components/SidebarNav.tsx:245, 302` and `components/CollapsibleNavSection.tsx:33`
  for the chevron at size 16/strokeWidth 2).
- Collapsed rail (`app/globals.css:14100-14140`): same markup, restyled — icon well
  grows to 36×36, label `display:none`, section headings removed from layout (not
  just hidden — the rail keeps sections permanently expanded since there's no
  heading to click), update-chip becomes a small dot.
- Section headers: `.drawer-section-label` — 10px, weight 700, uppercase, tracking
  `0.1em`, colour `--console-muted` (`app/globals.css:14030`ish, near `:14026`), driven
  by `components/CollapsibleNavSection.tsx` (a chevron-button that expands/collapses a
  `grid-template-rows` panel — `app/globals.css` `.nav-collapsible-panel`).
- Profile block at top of drawer (`components/SidebarNav.tsx:196-215`,
  `.drawer-profile` `app/globals.css:13906-13911`): `UserAvatarUpload` (38px, editable)
  + display name, then `TenantSwitcher` below it.
- Rail toggle button lives at the BOTTOM of the sidebar (`.drawer-footer`,
  `components/SidebarNav.tsx:280-291`) — `PanelLeftOpen`/`PanelLeftClose` lucide icons,
  size 18/strokeWidth 1.85.
- **Logo placement**: only in the topbar (`components/Topbar.tsx:30`), never a
  second time in the sidebar. See §3.5.

### 3.3 Theme toggle location
Two entry points, same state (`useAppContext().theme`/`setTheme`):
1. `components/ProfileMenu.tsx:439-440` — Sun/Moon icon buttons inside the
   `pm-appearance`/`pm-theme` segmented control in the profile dropdown (see §4 for
   that component's full CSS) — this is the **in-app** toggle location, not the
   topbar itself.
2. `components/LoginThemeToggle.tsx` — segmented control, top-right of the sign-in
   card (`.lc-login-theme`, `position: absolute; top: 20px; right: 22px;`,
   `app/globals.css:38099-38108`), **only exists pre-login**.
There is **no toggle directly in the topbar** — `components/ThemeToggle.tsx` (a plain
`.btn.ghost` button) exists as a component but was not found mounted in `Topbar.tsx`;
the live in-app toggle is inside `ProfileMenu`.

### 3.4 Theme persistence — see §0. `data-theme` on `<html>`, key `cc-theme` in
`localStorage`, single writer = `hooks/useAppContext.tsx`.

### 3.5 Logo
- **One asset for both themes, deliberately** — `components/LoopComLogo.tsx:1-13`
  doc comment: *"ONE file serves BOTH themes... The wordmark is a transparent PNG
  that reads on light and dark alike... Izzy rejected [a light variant] (2026-08-16,
  'I never approved any other colors')."*
- Asset: `/brand/loopcom/loopcom-wordmark-560.png`, native 560×99, used via
  `<img>` at native intrinsic size then CSS-scaled per context
  (`components/LoopComLogo.tsx:16-25`).
- Same exact file is reused on the login screen (`app/login/page.tsx:471/521/572/628`)
  "so the browser reuses one cached file" (comment at `app/login/page.tsx:625-626`).
  On the login card it's constrained to `width: 252px` via `.lc-login-logo`
  (`app/globals.css:37887-37894`).
- Other brand assets that exist in `public/brand/loopcom/` but are **effectively
  unused** (only `loopcom-icon-64.png` has a live reference, in
  `components/coworker/CoworkerChatView.tsx:45` as the Coworker avatar): favicons
  (`favicon-32/180/192/512.png`, `favicon.ico`), `loopcom-icon-32/128/256.png`,
  `loopcom-logo-clear-tight.png`, `loopcom-nav-h64@2x.png`,
  `loopcom-nav-h64@2x-light.png` (an orphaned light-mode nav variant — never
  referenced anywhere in `.tsx`/`.css`), `loopcom-nav-h80@2x.png` (also orphaned),
  `loopcom-wordmark-email-336.png` (used only in transactional email templates, not
  the portal UI). **For Works, use `loopcom-wordmark-560.png` as the one true
  cross-theme wordmark and `loopcom-icon-64.png` as the square avatar/mark — the
  `-light` nav variant is dead and should not be resurrected as "the light asset"
  without checking why it was abandoned.**

### 3.6 Mobile behaviour
- Single global breakpoint for the shell itself: **1080px**
  (`components/PageShell.tsx:15` — `useMediaQuery("(max-width: 1080px)")` — and
  `app/globals.css:15832` / `:17761` — `@media (max-width: 1080px)`).
- Below 1080px the sidebar becomes a fixed-position overlay drawer
  (`app/globals.css:15832-15865`): `position: fixed`, slides via
  `transform: translate3d(-100%,0,0)` → `translate3d(0,0,0)` (compositor-only,
  explicitly NOT animating `left` — code comment at `app/globals.css:15840-15843`
  explains why), 280px wide, `z-index: 120`, `box-shadow: 4px 0 40px rgba(0,0,0,.4)`
  when open. A separate `.nav-backdrop` (`app/globals.css:15828-15869`) dims the page
  (`rgba(2,7,14,.55)`, `z-index: 115`) and closes the drawer on click.
- Individual pages/components use a much wider, uncoordinated set of their own
  breakpoints (760/900/720/1024/640/1280/1180/1120/768/620px all appear repeatedly) —
  there is **no shared breakpoint scale/token**; 1080px is the only one that matters
  for the shell chrome itself.
- `GlobalSearch` results panel goes `position: fixed` full-width below 1080px
  (`components/GlobalSearch.module.css` last line).
- Touch targets: `@media (pointer: coarse)` rules bump several controls (profile
  menu close button, theme buttons, footer buttons) to `min-height: 44px`
  (`components/profile-menu.css`, near the bottom).

### 3.7 Floating assistant + floating dialer placement
- Both are fixed-position, bottom-right, and BOTH ship their CSS embedded inside
  their own component file (a `<style>{cssString}</style>` tag) rather than in
  `globals.css` — see §4 and §8 for why this matters.
- `FloatingAssistant`: `.fa-fab-wrap { position: fixed; right: 22px; bottom: 22px;
  z-index: 1200; }` (`components/FloatingAssistant.tsx:1307`), panel opens directly
  above it: `.fa-panel { position: fixed; right: 22px; bottom: 92px; z-index: 1199;
  width: 372px; height: 560px; }` (`components/FloatingAssistant.tsx:1348-1353`).
  Mounted globally in `layout/AppShell.tsx:12` (every signed-in page).
  Mobile: `right/bottom` shrink to 14px (`components/FloatingAssistant.tsx:1526`).
- `FloatingDialer`: despite the name, its **trigger** is not a separate floating fab
  — it's an ordinary `.icon-btn` (32×32, Phone icon) sitting inline in the topbar's
  right cluster (`components/Topbar.tsx` renders `<FloatingDialer />` there;
  `components/FloatingDialer.tsx:1002-1012` — the button itself). Clicking it opens
  a portal-rendered `.fd-shell` overlay panel (own embedded `DIALER_CSS`), which is
  where the "floating" part lives.
- Z-index note from `components/ViewportDropdown.tsx:150-155` code comment: dropdown
  panels sit at `z-index: 1250`, deliberately ABOVE the assistant panel (1199) and its
  fab (1200) "so the assistant doesn't draw over the account and notification menus",
  but below modal/screen-pop dialogs (9999/10000).

---

## 4. COMPONENTS

### 4.1 Two coexisting styling strategies (important for Works)
1. **Global utility classes in `app/globals.css`** (39,230 lines) — used by simple
   presentational components: `DataTable`, `MetricCard`, `EmptyState`, `ErrorState`,
   `LoadingSkeleton`, `DetailCard`, `SettingsSectionCard`, `SettingsNav`,
   `FilterBar`, `SearchInput`, `ActionDropdown`, `PermissionGate` (no styling of its
   own — pure conditional render).
2. **Self-contained components with CSS embedded in a JS template string, injected
   via a runtime `<style>{cssString}</style>` tag**, each with its own hardcoded
   fallback values in every `var(--token, #hexfallback)` call: `ConnectSelect.tsx`
   (`const CSS = \`...\`` around line 560, `<style>{CSS}</style>` at lines 196/433),
   `FloatingAssistant.tsx` (`const faCss = \`...\`` at line 1306, injected inline at
   render), `FloatingDialer.tsx` (`DIALER_CSS`). `profile-menu.css` and
   `GlobalSearch.module.css` are a third, smaller pattern — real CSS/CSS-module files
   imported alongside their component, with their own local custom-property
   namespace (`--pm-*`) re-themed via `:root[data-theme="light"] .extension-control-
   panel.profile-menu { ... }` (`components/profile-menu.css:24-34`). **Works should
   pick ONE of these strategies consistently rather than inheriting all three** —
   Connect's split is organic growth, not a deliberate architecture.

### 4.2 Per-component findings

**`ConnectSelect.tsx`** (686 lines) — the platform-wide MANDATED replacement for
native `<select>` (enforced by `lib/nativeSelectSweep.test.ts`, per the comment at
`app/globals.css:12611-12617`: *"the whole portal uses ConnectSelect/
ConnectMultiSelect... Izzy's platform-wide mandate"*). Props: `value/onChange`,
`options`/`groups`, `placeholder`, `disabled`, `searchThreshold` (auto-search above 8
options, default), `searchable`, `size: "sm"|"md"`, `dropdownWidth`, `name` (hidden
input for native form submission), `theme?: "light"|"dark"` (explicit override for
surfaces outside the `data-theme`-driven shell, since the dropdown portals to
`<body>` and can't inherit ancestor theme — `components/ConnectSelect.tsx:49-56`).
Renders `.cs-wrap > .cs-trigger (+ .cs-chevron)` and a `ViewportDropdown`-based
`.cs-panel > .cs-panel-inner > (.cs-search-wrap?) > .cs-list > .cs-option`.
Trigger: `border-radius: 10px`, `min-height: 36px` (md) / `29px` (sm), border
`var(--border)`, bg `var(--panel-2)`. Hover: border + bg tint toward `--accent` via
`color-mix`. Focus-visible: `box-shadow: 0 0 0 3px color-mix(accent 22%, transparent)`.
Open state: same accent ring persists while `aria-expanded="true"`. Disabled:
`opacity: .5; pointer-events: none`. Panel: `border-radius: 12px`,
`box-shadow: 0 16px 48px rgba(0,0,0,.45)`, `backdrop-filter: blur(16px)`.

**`DataTable.tsx`** — thin wrapper, `<div className="table-wrap"><table
className="table">`. All styling from global `.table`/`.table-wrap` (see §4.3).

**`StatusChip.tsx`** — ⛔ does **not** use the global `.chip` class at all; it's a
fully inline-`style` pill (`display:inline-flex; padding:2px 9px; border-radius:20px;
font-size:11px; font-weight:600; letter-spacing:.3px;`) with a hardcoded 6-colour map
(`default/neutral/success/warning/danger/info`) of raw `rgba()` backgrounds + CSS-var
text/border colours (`components/StatusChip.tsx:11-18`). This directly conflicts with
`LiveBadge.tsx` (`components/LiveBadge.tsx:39`), which renders `<span className={\`chip
${classes[status]}\`}>` — i.e. **the SAME visual concept ("small status pill") has two
independent, non-interchangeable implementations** (`StatusChip`'s inline-style pill vs.
the global `.chip` class family in `app/globals.css:12542-12568` / winning override at
`:15587-15610`). Pick one for Works.

**`EmptyState.tsx` / `ErrorState.tsx`** — both render `.state-box` (`ErrorState` adds
`.state-box.danger`). `.state-box`: border `var(--border)`, radius 12px, padding 14px,
bg `var(--panel)` (`app/globals.css:13657-13665`); `.danger` variant just recolors the
border toward `--danger`. Console override (`app/globals.css:15423-15429`) flattens
background to `var(--console-panel)` and drops the shadow.

**`LoadingSkeleton.tsx`** — `.skeleton-wrap` (grid, gap 9px) of N `.skeleton-row`
placeholders (`app/globals.css:13667-13678`ish).

**`MetricCard.tsx`** — `.metric-card > .metric-label / .metric-value / .metric-meta`.
Console override sets `padding: 10px` (`app/globals.css:15448`), value `font-size: 18px`.

**`FilterBar.tsx`** — trivial `<div className="filter-bar">`, flex row, gap 8, wraps
(`app/globals.css:13488-13491`ish).

**`SearchInput.tsx`** — `<input className="input global-search-input">`, i.e. it
deliberately reuses the topbar search's visual class rather than having its own —
another cross-component class-sharing pattern to note.

**`DateRangeFilter.tsx`** — self-contained preset pills (`Today/Last 7 days/Last 30
days`) + a "Custom" toggle pill that reveals two `<input type="date">` fields + Apply.
Classes: `.dash-filter`, `.dash-filter-pills` (`role="tablist"`), `.dash-filter-pill`
(`.active` state), `.dash-filter-custom`, `.dash-filter-apply`. Icons: `Calendar`
(14px) + `ChevronDown` (14px, rotates 180° when open, 0.15s transition).

**`DetailCard.tsx` / `SettingsSectionCard.tsx`** — both are thin `<section
className="panel">` wrappers (`DetailCard` adds a `.panel-head` row for title+actions
+ optional `data-testid`; `SettingsSectionCard` wraps children in `.stack`, 16px gap
— see the panel/card canonical rule in §4.3).

**`SettingsNav.tsx`** — static hardcoded list of 13 category labels
(`components/SettingsNav.tsx:3-16`), renders `.settings-nav > .settings-nav-item`
buttons. **Not currently wired to any real personal-settings routing** in this file
(it's a standalone list, categories are hardcoded strings, not driven by nav config) —
treat as a legacy/incomplete component, not a live pattern; the ACTUAL personal
settings surface Connect ships today is the `ProfileMenu` dropdown (§3.3 / §4.2 below),
not this component.

**`NotificationToast.tsx`** — see the light-mode `--crm-*` gap in §1.4. Structure:
`NotificationToastStack` (`fixed right-4 top:72px z-[500]`, flex column, gap 2) of
`ToastItem`s. Each toast: icon (Phone/Mail/MessageSquare/Bell by `kind`), title,
optional body (`line-clamp-2`), optional "View →" affordance, dismiss `X` button.
Auto-dismiss after 5000ms (paused on hover), slide-in via `translate-x-full →
translate-x-0` + opacity, 300ms.

**`ActionDropdown.tsx`** — `.btn.ghost` trigger + `ViewportDropdown` panel of
`.dropdown-action` buttons. Thin, generic — a good minimal reference for "menu
trigger + portaled panel" in Works.

**`ViewportDropdown.tsx`** — the shared positioning/portal primitive underneath
`ConnectSelect`, `ProfileMenu`, `ActionDropdown`, `NotificationPanel`,
`TenantSwitcher`. Portals to `document.body`, clamps to viewport with 16px
`collisionPadding`, flips above the trigger if it would clip the bottom AND there's
more room above (`components/ViewportDropdown.tsx:80-86`), closes on outside
pointerdown / Escape, and has a special exemption (`isInsideViewportDropdown`,
`components/ViewportDropdown.tsx:30-42`) so a NESTED ViewportDropdown (e.g. a
ConnectSelect inside a popover) doesn't get closed by its parent's outside-click
handler before its own click registers — documented as a fix for a real "dropdown
closes before selection registers" bug. Panel class: `dropdown-panel
viewport-dropdown`, `z-index: 1250` (see §3.7 z-index note).

**`PermissionGate.tsx`** — no styling; `if (!can(permission)) return fallback; return
children`. Pure conditional render.

**`FloatingAssistant.tsx` / `FloatingDialer.tsx`** — see §3.7 and §8.

**`LiveBadge.tsx`** — WebSocket connection-status pill using the global `.chip`
class + status→tone map (`idle→neutral, connecting→info, connected→success,
disconnected/error/failed→warning/danger`). "Live/connected" state adds an animated
7px pulsing dot (`animation: pulse 1.5s infinite`).

**`PresenceBadge.tsx`** — 6-line wrapper around `StatusChip` (so it inherits
`StatusChip`'s inline-style implementation, not `.chip`), maps
`AVAILABLE→success, ON_CALL→info, DND→warning, else→neutral`.

**`UserAvatarUpload.tsx`** — square-with-rounded-corners avatar (`.uau-wrap`, radius
10px — NOT circular, unlike most chat-avatar conventions), sized via a `--uau-size`
inline CSS custom property (default 36px), gradient fallback
`linear-gradient(145deg, var(--console-accent), #4568f0)` with initials when no
photo, hover camera overlay + remove button when `editable`, drag-drop free (plain
file input), 2MB / jpeg-png-webp validation client-side
(`components/UserAvatarUpload.tsx:56-63`). CSS at `app/globals.css:21239-21290`.

### 4.3 Global conventions (button / input / table / tab / chip / modal / dropdown)

For every one of these, **two rules exist — a generic base rule (earlier) and a
"console redesign" override (later, same specificity, wins per §1.1)**. Reporting
the WINNING (later) values, with the base noted for contrast:

- **`.btn` / `.input` / `.select`** — base at `app/globals.css:12573-12611`: radius
  10px, border `var(--border)`, bg `var(--panel-2)`, padding `8px 12px`, font-size
  13px. **Winning override** at `app/globals.css:15466-15490`: radius **9px**, border
  `var(--console-border)`, bg `var(--console-panel-soft)`, padding **7px 10px**,
  font-size **12px**; `.input { width: 100%; }` (overrides base's `width: 250px`).
  `.btn:hover` → border tints toward `--console-accent`. `.btn.ghost` → transparent
  background. `.btn.danger` → text colour `--console-danger` only (base version also
  recoloured the border; the winning version does not). `.btn:disabled` /
  `.input:disabled` / `.select:disabled` → `opacity: .55; cursor: not-allowed;` (base
  rule only, never overridden — `app/globals.css:12591-12595`). `.btn.ghost.active` →
  filled accent background, white text (`app/globals.css:15819-15823`).
- **`.table`** — base `app/globals.css:13499-13514`: `width:100%; border-collapse:
  collapse; font-size:13px;` th/td padding `10px 8px`, th colour `--text-dim` weight
  600. **Winning override** `app/globals.css:15498-15512`: font-size **12px**, th/td
  padding **8px 7px**, border-bottom `1px solid var(--console-border)`, th colour
  `--console-muted`, font-size **11px**, uppercase, letter-spacing `.04em`.
- **`.chip`** — base `app/globals.css:12542-12568`: pill (radius 999px), border
  `var(--border)`, padding `4px 9px`, font-size 12px, bg
  `color-mix(panel-2 80%, transparent)`; colour variants set BOTH border-color and
  text colour. **Winning override** `app/globals.css:15587-15610`: font-size **11px**,
  padding **4px 8px**, border `--console-border`, bg
  `color-mix(console-panel-soft 85%, transparent)`; colour variants set **text colour
  only** (border stays neutral `--console-border` for all variants in the winning
  version — a real visual simplification versus the base rule). Adds a `.chip.neutral`
  variant (`color: var(--console-muted)`) not present in the base rule.
- **`.tabs` / `.tab`** — only ONE definition, `app/globals.css:15791-15815`: flex row,
  gap 2px, horizontal scroll; each `.tab`: no border, transparent bg, `color:
  var(--text-dim)` (⛔ note: **not** `--console-muted` — inconsistent with the rest of
  the console-redesign pass), padding `6px 14px`, 2px bottom border (transparent →
  `--accent` when `.active`, with `color: var(--accent)` + weight 600).
- **`.panel`** (the generic "card" — used by `DetailCard`, `SettingsSectionCard`,
  `MetricCard` via its own `.metric-card`, `StatusChip`-adjacent surfaces) — base
  `app/globals.css:12476-12482`: bg `var(--panel)`, border `var(--border)`, radius
  12px, padding 14px, `box-shadow: var(--shadow)`. **Winning override**
  `app/globals.css:15423-15436` (applies to `.panel, .metric-card, .state-box,
  .settings-nav` together): bg `var(--console-panel)`, border-color
  `var(--console-border)`, **`box-shadow: none`** (flat design wins — the base
  drop-shadow is dropped platform-wide), then `.panel` specifically: radius **11px**,
  padding **12px**.
- **`.modal-backdrop` / `.modal`** (`app/globals.css:13680-13695`, no later override
  found) — backdrop `rgba(3,8,15,.62)` full-screen grid-center, `z-index: 50` (⛔ far
  below the 1250 dropdown / 1199-1200 assistant / 9999-10000 screen-pop layers noted
  in §3.7 — a real modal is LOWER z-index than a dropdown menu in this codebase,
  worth deciding deliberately for Works rather than copying blind). Modal card:
  `width: min(520px, 100vw-20px)`, border `var(--border)`, radius 14px, bg
  `var(--panel)`, padding 14px. No dedicated `.dialog` class exists.
- **`.dropdown-panel`** — base `app/globals.css:13618-13629`: width 280px, `z-index:
  200`, border `var(--border)`, bg `var(--panel)`, radius 10px, padding 8px, shadow
  `var(--shadow)`. **Winning override** `app/globals.css:15545-15549`: width **260px**,
  bg `var(--console-panel)`, border `var(--console-border)`. (`ViewportDropdown`
  itself hardcodes `z-index: 1250` inline, overriding the CSS value entirely for any
  panel routed through it — see §3.7.)
- **No dedicated `.switch`/`.toggle` global class** — the only real toggle-switch
  implementation found is component-local: `.pm-switch` inside
  `components/profile-menu.css` (38×22px pill, 16px thumb, `.on` state slides
  `translateX(16px)` and fills with `--pm-blue`).
- **No dedicated `.tooltip`, `.badge`, `.pill`, `.toast` global class** — "badge" is
  covered by `.chip` (see above) or, on nav links, a bespoke `.drawer-nav-badge`; the
  toast is `NotificationToast.tsx`'s own Tailwind-class markup (§1.4); no tooltip
  primitive exists anywhere in `globals.css` (tooltips, where present, are native
  `title=` attributes, e.g. `components/SidebarNav.tsx` nav-link `title=` for the
  collapsed rail).
- **Focus-visible convention**: not fully uniform, but the dominant pattern is a 2px
  solid `var(--accent)` outline with 1-2px offset (e.g. `.lc-login-input:focus-visible`
  `app/globals.css:37923-37927`, `.lc-login-submit/-ghost/-forgot:focus-visible`
  `app/globals.css:38015-38021`, `.uau-wrap.uau-editable:focus-visible`
  `app/globals.css:21257-21260`). `ConnectSelect`'s trigger instead uses a `box-shadow`
  glow ring (`0 0 0 3px color-mix(accent 22%, transparent)`) rather than an outline —
  two different focus treatments coexist; pick one for Works.
- **Transition durations**: no single token; observed values cluster at **0.12s–0.2s**
  for hover/press micro-interactions (`.fa-fab:hover` 0.12s, `.cs-trigger` 0.14s,
  `.drawer-nav-link` 0.18s, sidebar `--nav-ease-dur` 200ms) and **0.15s–0.3s** for
  reveal/dismiss (dropdown chevron rotate 0.15s, toast slide 300ms). Treat "~150-200ms
  ease" as the de facto standard for Works.

---

## 5. LOGIN PAGE

`app/login/page.tsx` (694 lines, multiple screens: password, OTP-choice, OTP-code,
recovery-code — all share the same `.lc-login`/`.lc-login-card` shell). CSS entirely
in `app/globals.css:37849-38145` (no separate stylesheet).

- **Layout**: single centered card, not split-panel. `.lc-login`: `min-height: 100vh;
  display:flex; align-items:center; justify-content:center; padding:24px;`
  (`app/globals.css:37849-37864`).
- **Background treatment**: solid `var(--bg)` plus a soft radial accent glow —
  `background-image: radial-gradient(58% 42% at 50% 0%, color-mix(accent 12%,
  transparent), transparent 70%);` (`app/globals.css:37856-37860`) — i.e. a subtle
  glow emanating from top-center, not a full gradient wash or illustration.
- **Card**: `width: min(392px, 92vw)`, bg `var(--panel)`, border `var(--border)`,
  radius 18px, padding `30px 32px 32px`, `box-shadow: var(--shadow)`
  (`app/globals.css:37866-37877`). Has a decorative **1px accent gradient hairline**
  across the top edge via a `::before` pseudo-element:
  `linear-gradient(90deg, transparent, var(--accent), var(--accent-2), transparent)`,
  height 2px (`app/globals.css:37878-37886`).
- **Logo**: same single cross-theme wordmark as the topbar (`loopcom-wordmark-560.png`,
  §3.5), constrained to `width: 252px; margin: 2px auto 26px;` centered
  (`app/globals.css:37887-37894`).
- **Inputs**: `.lc-login-input` — height 44px, radius 10px, border `var(--border)`,
  bg `var(--bg-soft)` (i.e. slightly recessed relative to the card's `--panel`),
  padding `0 14px`, font-size 15px. Focus-visible: 2px solid `--accent` outline,
  border becomes transparent (`app/globals.css:37909-37927`). Label above each field:
  11px, uppercase, `letter-spacing: 0.1em`, `color: var(--text-dim)`
  (`app/globals.css:37901-37907`).
- **Buttons**: `.lc-login-submit` — height 46px, radius 10px, `font-weight:600`,
  background `linear-gradient(135deg, var(--accent), var(--accent-2))`, white text
  (`app/globals.css:37940-37955`). `.lc-login-ghost` (secondary / "Local dev sign-in"
  / resend actions) — same height/radius, transparent bg, border `var(--border)`,
  text `var(--text-dim)`, `margin-top: 10px`. Both `opacity:.6` when disabled.
- **Google SSO**: a plain `<a>` (top-level navigation, no Google script/CSP change —
  comment at `app/login/page.tsx:660-663`) styled as `.lc-login-google`
  (`app/globals.css:38048-38067`) with a full-colour Google "G" mark SVG inline,
  separated from the primary form by an `.lc-login-or` divider (`—— or ——`,
  `app/globals.css:38036-38047`).
- **Theme toggle placement**: absolutely positioned top-right of the card,
  `top: 20px; right: 22px` (`app/globals.css:38099-38108`) — a pill-shaped segmented
  control (`.lc-login-theme`) with Light/Dark buttons, active state gets `--panel`
  background + subtle shadow (`app/globals.css:38129-38133`). See §3.3/§0 for the
  state logic; `components/LoginThemeToggle.tsx` renders inline sun/moon SVG icons
  (not lucide) sized via the parent `svg { width:14px; height:14px; }` rule.
- **Footer text**: no marketing footer / copyright line on the card itself. The only
  "footer" affordance is `.lc-login-forgot` ("Forgot password?" link,
  `app/globals.css:38022-38030`, colour `--text-dim` → `--accent` on hover).
- **Error style**: `.lc-login-error` — border `color-mix(danger 42%, transparent)`,
  bg `color-mix(danger 12%, transparent)`, text `var(--text)` (not `--danger` — the
  error is signalled by the border/background tint, body text stays neutral), radius
  10px, padding `10px 13px`, font-size 13.5px (`app/globals.css:37929-37939`).

---

## 6. SHARED LIBRARY

- Root workspace is a pnpm monorepo (`pnpm-workspace.yaml` at repo root); `packages/`
  contains `db`, `integrations`, `security`, **`shared`**.
- `packages/shared` (`@connect/shared`, imported by the portal e.g.
  `components/FloatingAssistant.tsx:38` — `import { SUPPORT_REPORT_AREAS, ... } from
  "@connect/shared"`) is **business logic and types only — zero UI**. Its `src/`
  contains **140 `.ts` files and 0 `.tsx` files** (confirmed by `find src -iname
  '*.tsx'` → empty). Exports (per `packages/shared/package.json`'s `exports` map)
  cover things like `queues`, `chatSignedUrl`, `chatAttachmentStorage`,
  `portalPermissions`, `onboardingPricing`, `phoneE164`, `ivrPlainLanguage`,
  `mohCatalog` — permission maps, formatting helpers, pricing math, queue configs.
  **No design tokens, no component exports, nothing Works can import for styling.**
- `apps/portal/theme/` is **confirmed empty** — contains only a `.gitkeep`
  (`apps/portal/theme/.gitkeep`, the sole file in that directory).
- **No Storybook** anywhere in the repo (`find . -iname '.storybook' -o -iname
  'storybook*'` → no hits outside `node_modules`).
- **No design-token JSON/TS file** anywhere (`find . -iname '*design-token*' -o
  -iname 'tokens.json' -o -iname 'tokens.ts'` → no hits). The tokens documented in
  §1 exist ONLY as CSS custom properties inside `app/globals.css` — there is no
  machine-readable token source to hand to Works; someone will have to transcribe
  from this document or from the CSS directly.

---

## 7. ICONS

- **lucide-react** exclusively (`apps/portal/package.json` dependency
  `"lucide-react": "^0.577.0"`). No other icon library present
  (`react-icons`/`@heroicons`/`@radix-ui/react-icons` all return zero hits across
  `.tsx` files).
- No global default size/stroke is enforced by a wrapper component — every call site
  passes its own `size=`/`strokeWidth=` prop. Observed distribution across
  `components/*.tsx` (`size=` prop, all files): most common **16px** (34 uses), then
  15px (32), 14px (23), **18px** (20 — this is the sidebar/nav-icon standard, see
  §3.2), 17px (13), 22px (10), 13px (13), 12px (8), down to rare 10/20/26/28/44/48/200px
  for special cases (large empty-state icons, avatars, etc.).
- `strokeWidth`: default lucide stroke is 2 if unset. Explicit overrides found:
  `strokeWidth={2}` (10×, i.e. re-asserting the default), and **`strokeWidth={1.85}`**
  used consistently for the sidebar nav icons + rail toggle (`components/SidebarNav.tsx`)
  and `SidebarNavGroup.tsx` — a deliberately slightly-thinner stroke for nav iconography
  specifically, vs. the lucide default 2 used everywhere else.
- The only non-lucide icon usage found is the **inline hand-drawn SVGs** in
  `LoginThemeToggle.tsx` (sun/dark-mode glyphs, custom paths, not from a library) and
  the **Google "G" mark** in `app/login/page.tsx` (multi-colour brand SVG, obviously
  can't come from a generic icon set).

---

## 8. AI ASSISTANT UI PATTERN

Two distinct, independently-built assistant surfaces exist in the portal. For "Works"
the **FloatingAssistant** pattern is the one to reproduce (it's the universal, portal-
wide, theme-aware pattern); **Coworker** is a separate, desktop-app-only surface with
its own visual language — described second, for completeness since the task named it.

### 8.1 `components/FloatingAssistant.tsx` (1528 lines) — the reproducible pattern

**Entry point**: a circular floating action button, bottom-right of every signed-in
page, mounted globally in `layout/AppShell.tsx:12` (sibling of page content, so it
persists across navigation). `.fa-fab-wrap { position: fixed; right: 22px; bottom:
22px; z-index: 1200; }`. The button itself: 58×58px circle, no border,
`background: var(--accent, #2f6df6)`, white icon, drop shadow
(`components/FloatingAssistant.tsx:1308-1314`). Icon swaps between `Bot` (26px,
closed) and `X` (24px, open) (`components/FloatingAssistant.tsx:1294-1295`). An
unread-count badge (`.fa-badge`) or a plain presence dot (`.fa-dot`, green,
`#22c55e`) overlays the button when closed and there's something new
(`components/FloatingAssistant.tsx:1296-1300`). Before first interaction, a
speech-bubble-shaped hint (`.fa-hint`, "Need help? I'm right here 👋") can appear
beside the button (`components/FloatingAssistant.tsx:1288-1291`); a message from a
human support agent takes priority and shows as a more prominent `.fa-nudge` card
instead (`components/FloatingAssistant.tsx:1280-1289`).

**Panel**: opens directly above the button, `.fa-panel { position: fixed; right:
22px; bottom: 92px; width: 372px; height: 560px; border-radius: 16px; background:
var(--panel); box-shadow: 0 24px 60px rgba(0,0,0,.35); }`
(`components/FloatingAssistant.tsx:1348-1353`). Structure top→bottom:
- **Header** (`.fa-head`): 32×32 gradient avatar badge (`--accent`→`--accent-2`),
  title + status line, back button (when in a sub-view like "report a problem"),
  header action icons (close, etc.).
- **Body** (`.fa-msgs`, flex column, gap 10px, scrollable) — either the **opening
  screen** (`.fa-open`: greeting heading + a stack of tappable rows `.fa-row`
  offering "Report a problem" / "Suggest a feature" / prior conversation entries,
  each with a 28×28 tinted icon well `.fa-ico` and a chevron) or the live
  **message thread** once a conversation has started.
- **Message bubbles** (`.fa-m`, `components/FloatingAssistant.tsx:1485-1489`):
  max-width 84%, radius 13px, padding `9px 12px`. Assistant (`.fa-bot`): bg
  `var(--panel-2)`, border `var(--border)`, left-aligned, `border-bottom-left-radius:
  4px` (chat-bubble "tail" corner). User (`.fa-user`): filled `var(--accent)`, white
  text, right-aligned, `border-bottom-right-radius: 4px`. A Yiddish reply gets a
  larger font (`.fa-yi { font-size: 15px; }`). **Streaming/pending state is NOT a
  typing-dots animation** — it's simply `.fa-pending { opacity: .8; font-style:
  italic; }` applied to the bubble while the real answer streams in (an instant
  "typewriter reveal" acknowledgment shows first per the file's own top comment,
  `components/FloatingAssistant.tsx:8-10`).
- **Attachments**: a file chip (`.fa-file`) with filename, progress bar
  (`.fa-file-bar`, animates `width`), percent text, and a remove button; error state
  recolors the chip toward danger (`components/FloatingAssistant.tsx:1495-1501`).
- **Composer** (`.fa-input`, sticky bottom bar, `border-top: 1px solid var(--border)`,
  bg `var(--bg)`): pill-shaped textarea (radius 18px growing from a 999px input,
  `max-height: 96px`, auto-resize, no visible resize handle), a `Paperclip` attach
  icon button, a `Mic` record button (`.fa-icon-on` pulses red while recording), and
  a circular 36×36 accent-filled `Send` button, disabled/dimmed when empty
  (`components/FloatingAssistant.tsx:1502-1514`).
- **Suggested prompts**: not a distinct chip row — offered via the opening-screen
  `.fa-row` list described above (Report a problem / Suggest a feature / resume a
  past thread), not a horizontally-scrolling suggestion-chip pattern.
- **Sub-panels** ("Report a problem", "Suggest a feature", their "sent" confirmation
  screens) reuse the exact same `.fa-panel`/`.fa-head`/`.fa-body` shell but swap the
  body content for a form (`components/FloatingAssistant.tsx:811-919`), always
  closing with a trust line: *"A person from Loopcom is always behind this"*
  (`.fa-foot`).

**Theming**: every colour in `faCss` is `var(--token, #hexFallback)` — reads the
same `--bg/--panel/--panel-2/--text/--text-dim/--border/--accent/--accent-2`
tokens as the rest of the shell, confirmed by the component's own top-of-file
comment (`components/FloatingAssistant.tsx:12-13`: *"Theming: uses the Connect CSS
variables... so it looks native in BOTH light and dark mode. No model or vendor
names appear anywhere."*) — the last clause is a real product rule: nowhere in the
UI does it say which LLM/vendor powers it.

### 8.2 Coworker (`components/coworker/*`) — secondary pattern, desktop-app only

Different visual language, own `cw-*` class family (`components/coworker/
coworkerStyles.ts`), NOT theme-token-driven in the same way — it renders a
step-by-step "plain-English tool log" rather than a plain chat transcript. Each
assistant turn shows a list of `StepRow`s (`components/coworker/CoworkerChatView.tsx:
70-77`), one per tool call, each tagged with an icon+label for its kind (Files,
Browser, Spreadsheet, Phone system, Command, This computer, Code project, Connected
app, Question, Account, Thinking — `KIND` map at
`components/coworker/CoworkerChatView.tsx:29-40`) and a live state indicator
(`StateLead`: spinner while running, a hand icon while waiting for approval, a
checkmark when done, an X when cancelled/failed —
`components/coworker/CoworkerChatView.tsx:52-59`). Its entry point
(`CoworkerPopover.tsx`) is a **desktop-app-only** popover window (route
`/desktop/coworker`), not available in the plain web portal, with its own mark
(`CoworkerMark`, `components/coworker/CoworkerChatView.tsx:43-48`) using
`loopcom-icon-64.png` as a 28px avatar. Mention this pattern to Works only if Works
needs an agent-with-visible-tool-steps surface; for a general "chat with the
assistant" bubble, model it on FloatingAssistant (§8.1) instead.

---

## Citation index (file → what's covered)

- `app/globals.css` — all tokens (§1), shell chrome (§3), global component classes (§4.3), login CSS (§5)
- `hooks/useAppContext.tsx` — theme state machine (§0)
- `app/layout.tsx`, `app/providers.tsx`, `app/(platform)/layout.tsx`, `layout/AppShell.tsx` — shell composition (§3)
- `components/Topbar.tsx`, `SidebarNav.tsx`, `CollapsibleNavSection.tsx`, `PageShell.tsx` — live shell (§3)
- `components/AppSidebar.tsx`, `HeaderBar.tsx`, `SidebarNavGroup.tsx` — confirmed DEAD CODE, not used
- `components/LoopComLogo.tsx`, `LoginThemeToggle.tsx`, `ThemeToggle.tsx` — branding/theme controls (§3.3/§3.5)
- `components/ConnectSelect.tsx`, `ViewportDropdown.tsx`, `ProfileMenu.tsx` + `profile-menu.css`, `GlobalSearch.tsx` + `.module.css`, `TenantSwitcher.tsx`, `NotificationPanel.tsx`, `NotificationToast.tsx` — components (§4)
- `components/DataTable/StatusChip/EmptyState/ErrorState/LoadingSkeleton/MetricCard/FilterBar/SearchInput/DateRangeFilter/DetailCard/SettingsSectionCard/SettingsNav/ActionDropdown/PermissionGate/LiveBadge/PresenceBadge/UserAvatarUpload.tsx` — components (§4.2)
- `app/login/page.tsx` — login page (§5)
- `tailwind.config.js` — crm-* Tailwind mapping (§1.4)
- `packages/shared/package.json`, `apps/portal/theme/.gitkeep` — shared lib / theme dir (§6)
- `apps/portal/package.json` — lucide-react dependency (§7)
- `components/FloatingAssistant.tsx`, `components/coworker/*` — assistant UI (§8)
