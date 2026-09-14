# ⛔ AGENT HANDOFF — Store → Orders status tabs (Needs review / Sent / Failed to send / Dismissed / All orders) rendered with the browser's default grey button face in dark mode; fixed in `supermarket.css` as a themed segmented control for dark + light (2026-09-08) — READ FIRST before adding any `<button>` to the Orders Desk or another `.sm-root` page

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Izzy's screenshot: the four inactive tabs were light-grey blocks on the dark toolbar. Fix in
`apps/portal/app/(platform)/orders/supermarket.css` (`.sm-root .sm-tab*` rules); no TSX change.
Detail appended to **`docs/ai-context/AGENT_HANDOFF_ORDERS_DESK_FILTERS_2026-09-08.md` §6**.

- ⛔ **CAUSE: this portal runs Tailwind with `preflight: false`, so a `<button>` keeps the UA
  defaults (`background: buttonface`, system font, 2px border).** The tab strip has been real
  `<button>`s since before the filters commit, but `.sm-tab` only set colour/size/padding —
  never `background`/`border`/`font`. Every OTHER desk button class (`.sm-btn.*`, `button.sm-filter`,
  `.sm-pg`, `.sm-iconbtn`, `.sm-play`, `.sm-asschip`) sets its own background, which is why only
  the tabs leaked. **Rule: any new `<button>` under `.sm-root` must reset `appearance/background/
  border/font` itself — nothing global does it.**
- ✅ **THE FIX:** `.sm-tab` = `appearance:none; background:transparent; border:0; font:inherit;
  cursor:pointer` + hover (`--sm-row-hover`) + `:focus-visible` accent ring. Dark: track `--panel`,
  active pill `--panel-2` with the inset `--border` (as the mockup). Light (`:root[data-theme="light"]`):
  track `--panel-2` (#f8fafc), active pill **white** with inset border + a 1px shadow, hover
  `rgba(15,23,42,.05)` — otherwise the light active tab was #f8fafc on white, invisible.
- ✅ **Verified on the dev box** by rendering the real `supermarket.css` + the portal's theme tokens in a
  static page in the in-app browser, dark and light (no `tsc`/pnpm here — memory `devbox-toolchain-blocker`).
- ✅ **DEPLOYED + container-verified 2026-09-08 ~21:30Z:** commit `68e17c90` (CSS + docs), `deploy-direct.sh
  portal --commit 68e17c90` (dry-run first). `app-portal-1` `.build-commit` = `68e17c90`, the built
  `.next/static/css/8522e9002ae5ad04.css` carries the new `.sm-root .sm-tab{appearance:none;background:transparent;…}`
  rule, `/ready` 200, no candidate container left. ⏳ NOT PROVEN: a logged-in look at `/orders` in both themes.
- ⛔ **Trap seen on the way:** the first run died at `stage=build` with `HEAVY JOB ALREADY RUNNING:
  deploy-queue:portal:compose-build-portal-candidate` — another session was deploying `04b23b11` (screen-pop
  removal). `deploy-direct.sh` does NOT lock the `git-sync` stage, only the heavy build: my run had already
  moved the shared clone's HEAD to `68e17c90` under their in-flight build (their Docker context was already
  transferred, and their image is stamped `04b23b11`, but their log's final `done` line printed `68e17c90`
  because it reads the clone HEAD). Poll `ps -eo cmd | grep -E "[d]eploy-(direct|portal|api)"` before deploying.
