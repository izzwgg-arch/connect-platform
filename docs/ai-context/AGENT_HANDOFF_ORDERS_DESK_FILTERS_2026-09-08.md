# AGENT HANDOFF — Store → Orders (Supermarket mode) filters: received range, status tabs, source, search, paging (2026-09-08)

Izzy: *"On the orders page I should have filters to look up orders as far back as it goes.
Right now it's only showing me 24 hours back."* This is the **Orders Desk**
(`/orders`, sidebar STORE → Orders, `OrdersDesk.tsx`), NOT Tracking → Orders. An earlier
handoff the same day (`AGENT_HANDOFF_ORDERS_DATE_RANGE_PAGING_2026-09-08.md`) built the same
treatment on the delivery dispatcher page by mistake; that work stands but was not the ask.
Filters were proposed as a list, four were approved ("Recommended"), then a mockup
(https://claude.ai/code/artifact/cf7ce2bb-68b5-46a9-a75d-8a3307db1e68, dark + light + custom
range) was approved: *"Go, build it as drawn and deploy."* Commit **`65225b5e`**.

## 1. What was wrong — and the workspace trap that looked like data loss

- `GET /supermarket/drafts` did `findMany({ where: {tenantId, status?}, orderBy createdAt desc,
  take: 100 })`. Gesheft receives ~60–120 drafts a day, so "Needs review" showed roughly one
  day and nothing older was reachable. ⛔ There was never a 24-hour rule.
- ⛔ **"All the orders are gone, only two are left"** (Izzy, mid-afternoon) was the header
  workspace switcher on **All workspaces**: the portal then sends no `x-tenant-context`, and
  `resolveEffectiveTenantBillingContext` (`billing/billingAuth.ts`) falls back to the Support
  user's own tenant, **Connect Communications**, which owns exactly two drafts (calls on
  08-26 03:07 and 03:45 → "329 hr ago" / "328 hr ago"). Gesheft had 932 NEEDS_REVIEW + 431
  DISMISSED rows the whole time. Check the switcher before suspecting a deploy.

## 2. API — `apps/api/src/supermarket/`

- **`draftListQuery.ts`** (new, pure). `parseDraftListQuery(req.query)` → `{ status?, sourceType?,
  from?, to?, q?, page, pageSize }`: `status` whitelisted to the six draft statuses (anything
  else = all); `source` ∈ call|voicemail|text; `from`/`to` ISO instants (inverted pair swapped,
  garbage ignored); `q` trimmed, ≤ 80 chars; `page` ≥ 1; `pageSize` 1..200, default 50.
  `draftSearchWhere(q)` builds the Prisma `OR`: letters or < 3 digits → `customerName contains
  (insensitive)`; ≥ 3 digits → `customerPhone contains <digits>` (+ the raw text in case the
  phone is stored formatted); `posOrderId contains <raw>` always. **`draftListQuery.test.ts`:
  7 cases, green on the dev box**; `src/supermarket/*.test.ts` IS in the package test glob.
- **`supermarketRoutes.ts`** `GET /supermarket/drafts`: same guard (`requireSupermarketMode`) and
  tenant (`tenantOf` → honours `x-tenant-context` for super-admins), now `findMany` with
  `skip/take` **+ `count`** in parallel; same `select` block. Response **keeps the `drafts`
  key** and adds `total, page, pageSize`, so any older client reading `.drafts` still works
  (it just gets 50 instead of 100 by default).
- No migration: `SupermarketOrderDraft` already has `@@index([tenantId, status, createdAt])`
  and `@@index([tenantId, createdAt])`.

## 3. Portal — `apps/portal/app/(platform)/orders/`

- **`OrdersDesk.tsx` → `OrdersList()`** rewritten (the review screen below it is untouched).
  Filters live in the URL: `tab` (`review` default | `sent` | `failed` | `dismissed` | `all`),
  `range` (`30d` default | `today` | `7d` | `90d` | `all` | `custom`), `from`/`to` (`YYYY-MM-DD`,
  custom only), `src` (call|voicemail|text), `q`, `page` (omitted when 1), `size`
  (25/50/100/200, default 50). Defaults are omitted; any filter change drops `page`.
  `?draft=<id>` still opens the review screen (the parent decides; untouched).
- **Status = the tab strip**, extended with *Failed to send* (SUBMIT_FAILED) and *Dismissed*
  (DISMISSED); *All orders* sends no status. Approved-but-not-sent and SUBMITTING drafts only
  appear under *All orders* (not a tab of their own — nobody asked).
- Filter bar (`.sm-filterbar`): *Received* presets as `.sm-filter` chips (the existing dashed
  pill; `.sm-on` = solid accent tint), *Custom…* seeds the current range → two
  `<input type="date">` + **Apply** (disabled until valid and changed); divider; *Source*
  chips; range summary; **Clear filters** (only when something is non-default, incl. tab).
- Search box in the toolbar is a real input (`.sm-search-live`), debounced 350 ms into `?q=`,
  searched **server-side across the whole history** with the other filters applied.
- **One table for every tab** (the separate "Sent today — tracked by Loopcom" block is gone):
  icon (check when SUBMITTED) · Customer (`#posOrderId · phone · acct`) · **Received**
  (`Tue 8 Sep · 19:35`, year added when not the current one; sub-line shows Call/Voicemail/
  Text and `· sent <day>` for SUBMITTED) · Draft/Total · Flags (Pickup/Delivery pill on sent,
  *failed to send*, *dismissed*, *card declined*, WIC, note) · **Review** (primary) or
  **Open** (quiet, for sent/dismissed). Count line above (`932 orders match · newest first`,
  `Showing 1–50 of 932`), pager + Rows per page below. While refetching the rows dim.
- Presets are the **browser's local day boundaries** sent as ISO instants; `Today` = local
  midnight → now; `Last 7 days` = today + 6 back. Custom `to` is end-of-day inclusive.
- Light/dark: all through the desk's `--panel/--border/--accent` vars; the two date inputs and
  the rows-per-page `<select>` get `color-scheme: dark`, `light` under `:root[data-theme="light"]`.
- New phrases appended to `SM_ORDERS_PHRASES` so Yiddish Labs can translate them; `t()` falls
  back to English until then. The old `ago()` helper was dead after this and removed.
- 30-second auto-refresh kept (re-runs the current filter).

## 4. Verification state

- ✅ `draftListQuery.test.ts` 7/7 on the dev box (Node 26 type-strip harness).
- ⛔ No `tsc` on this box (memory `devbox-toolchain-blocker`); the Docker builds are the type gate.
- ✅ **API DEPLOYED** — `deploy-direct.sh api --commit 65225b5e` (dry-run first), blue/green
  clean, `[deploy-api] done 65225b5e`, 235 s. `app-api-1` carries
  `supermarketRoutes.ts:622 parseDraftListQuery(req.query)` and `src/supermarket/draftListQuery.ts`;
  `/health` and `/ready` 200.
- ✅ **PORTAL DEPLOYED** — `[deploy-portal] done 65225b5e`, 29 s (image cached from a first
  attempt that was cancelled at the build stage — see §5 — and never cut over), nginx back on
  `:3000`, `/ready` 200. `app-portal-1` build carries `sm-filterbar` in
  `.next/static/chunks/2255-*.js`, `.next/server/chunks/2063.js` and `.next/static/css/9477733f*.css`.
- Izzy confirmed in the same session that Gesheft's orders were all present once the workspace
  was switched ("Never mind, all the orders are here").
- ⏳ **NOT PROVEN: a logged-in look at the filters in light + dark** (no MCP tab group in Izzy's
  Chrome, no portal session in the in-app browser). First person on `/orders`: pick Custom…,
  check the two date fields in both themes, type a phone fragment in the search box.

## 5. Traps

- ⛔ **This deploy also shipped another session's commit `39b9eb4f` "feat(auth): sign-in code
  v2"** (login page, `mfaLogin.ts`, `trustedDevice.ts` removed, API side) — it was pushed to the
  live branch but had NOT been deployed by its author when this deploy ran (no api/portal deploy
  log between 21:42 and 22:40). Api and portal were deployed together on purpose so the login
  flow's two halves match. If sign-in misbehaves, that commit is the first suspect, not this one.
- The worktree is CRLF on disk; exact-anchor patch scripts must normalise (memory
  `takeover-worktree-crlf-patching`). The first patch attempt anchored on a guessed import line
  and failed before writing — anchors must be copied from the file, never typed from memory.
- The `total` counts the whole filter server-side; the tiles still count NEEDS_REVIEW / today
  independently of the filters (by design — they are the "right now" numbers).

## 6. Follow-up (2026-09-08, evening) — the status tabs showed the browser's grey button face

Izzy's screenshot after the deploy: *Sent / Failed to send / Dismissed / All orders* sat as
light-grey blocks on the dark toolbar. *"Fix this to stay consistent with Connect theme, dark
mode, and light mode."*

- **Cause.** `apps/portal/tailwind.config` has `preflight: false`, so a `<button>` keeps the UA
  stylesheet (`background-color: buttonface`, system font, 2px outset border). The tab strip
  has been `<button>`s since the desk was first ported; `.sm-root .sm-tab` only set colour,
  size, weight, radius and padding, so the grey face showed through on every inactive tab
  (the active one was covered by `.sm-on`'s `--panel-2`). The chips already had
  `button.sm-filter { background: transparent; font: inherit }`, the pager buttons and
  `.sm-btn` variants set their own backgrounds — only the tabs were missing the reset.
- **Fix** (CSS only, `supermarket.css` "toolbar + tabs" block): `.sm-tab` resets
  `appearance`, `background`, `border`, `margin`, `font` and gets `cursor: pointer`,
  `white-space: nowrap`, a hover state on `--sm-row-hover` and an accent `:focus-visible`
  ring (the active tab keeps its inset border under the ring). `.sm-tabs` gains `gap: 2px`.
  Light theme: the track becomes `--panel-2` and the active pill is white with the inset
  border plus `0 1px 2px rgba(15,23,42,.08)`; hover is `rgba(15,23,42,.05)`. Without that,
  the light active tab (`#f8fafc` on a `#ffffff` track) was invisible.
- **Verified** by rendering the real stylesheet plus the portal's `:root` / `[data-theme="light"]`
  tokens into a static page served on localhost and screenshotting it in the in-app browser in
  both themes (dark: dim tabs on the panel track, lighter active pill; light: grey track, white
  raised pill). No `tsc` on this box; the portal Docker build is the gate.
- **Rule going forward:** any new `<button>` under `.sm-root` (or any portal page, since
  preflight is off) must reset its own background/border/font. Nothing global does it.
