# AGENT HANDOFF — Tracking → Orders: date-range filter, store filter, server-side paging (2026-09-08)

Izzy: *"On the orders page I should have filters to look up orders as far back as it goes.
Right now it's only showing me 24 hours back and I have no way to look it up. Show me a
mockup before you build anything."* → mockup approved → *"go, build it as drawn. Light mode
and dark mode."*

Commit **`790ecf22`** on `feat/ivr-migration-takeover` (9 files, +660/−80). Mockup canvas:
https://claude.ai/code/artifact/acd624fa-73f1-4e02-b6da-0df7ffcbb2dc (two artboards: preset
range, custom range + paging; both built as drawn).

## 1. What was actually wrong — there was never a "24 hours" rule

`listOrders()` in `apps/api/src/delivery/orderService.ts` did `findMany({ orderBy: createdAt
desc, take: min(opts.take ?? 100, 200) })` with **no date filter and no paging**, and the
portal page rendered whatever came back. A store that receives ~100 orders a day therefore
saw about one day, and everything older was unreachable from the UI. ⛔ Do not go looking
for a 24 h constant when someone reports "it only shows today" — the cap is the row count.

## 2. API (`apps/api/src/delivery/`)

- **`orderQuery.ts`** (new, pure): `parseOrdersQuery(req.query)` →
  `{ status?, storeId?, from?: Date, to?: Date, page, pageSize }`. Clamps `page` to ≥1,
  `pageSize` to 1..200 (default 50), swaps an inverted `from > to`, ignores unparsable
  dates and non-string values (array injection). **`orderQuery.test.ts`: 7 node:test cases,
  green on the dev box** via the Node 26 type-strip harness (see memory
  `devbox-verification-harness`).
  ⛔ `apps/api/package.json` `test` is an explicit glob list that does **not** include
  `src/delivery/*.test.ts` — none of the delivery tests (this one, `permissions.test.ts`,
  `customerView.test.ts`) run under `pnpm --filter @connect/api test`. Left as-is on purpose
  (adding the glob would pull in two never-run suites); run them directly when needed.
- **`orderService.ts`**: `ordersWhere()` + `ORDER_LIST_SELECT` + `mapOrderListRow()` shared
  by the kept `listOrders()` ("latest N", unpaged) and the new **`searchOrders()`**
  (`skip/take` + `count` in parallel → `{ items, total, page, pageSize }`). `createdAt`
  bounds are inclusive (`gte`/`lte`). New **`listStores(tenantId)`** → `DeliveryStore`
  rows ordered active-first, name asc.
- **`routes.ts`**: `GET /delivery/orders` now returns the **envelope**
  `{ items, total, page, pageSize }` (was a bare array) — the portal orders page was the
  only consumer (grep across `apps/` and `packages/` on 2026-09-08: no mobile/desktop use).
  New `GET /delivery/stores` behind the same `requireDeliveryDispatch` guard.
- **Prisma**: `@@index([tenantId, createdAt])` on `DeliveryOrder` + migration
  `20260908160000_delivery_order_created_at_index` (single `CREATE INDEX`, additive).
  `deploy-api.sh` runs `prisma migrate deploy` because `packages/db/prisma/**` changed.

## 3. Portal (`apps/portal/app/(platform)/tracking/orders/page.tsx`, rewritten)

- **Filters live in the URL** via `useSearchParams` + `router.replace(…, {scroll:false})`
  (page wrapped in `<Suspense>` as the app router requires): `range` (`today|7d|30d|90d|
  all|custom`, default `30d` = omitted), `from`/`to` (`YYYY-MM-DD`, custom only), `status`,
  `store`, `page` (omitted when 1), `size` (25/50/100/200, default 50 = omitted). Changing
  any filter drops `page`. Bookmarkable, survives Back, shareable.
- **Range → instants**: presets are *local* day boundaries (`Last 7 days` = today + 6 back,
  `Today` = local midnight → now) sent as full ISO strings, so the dispatcher's browser
  timezone decides the day. Custom `to` is end-of-day inclusive. `All time` sends no bounds.
- **Custom**: clicking `Custom…` seeds the draft with the range currently shown and today,
  commits it; the From/To inputs then edit a draft and **Apply** (disabled until valid and
  changed) commits. Inputs are `<input type="date">` with `min`/`max` guards.
- Header keeps the search box (client-side over the loaded page, as before) and gains a
  **store `ConnectSelect`** — rendered only when `GET /delivery/stores` returns >1 store.
- New filter `CRMCard`: Status pills (unchanged set) / divider / Received pills + custom
  form + range summary + **Clear filters** (only when something is non-default).
- Results card: count line ("1,284 orders match · newest first" / "Showing 1–50 of 1,284"),
  new **Received** column (`Tue 8 Sep · 09:42`, year added when not the current year),
  footer pager (prev/next, numbers with ellipses, `aria-current`), **Rows per page**
  `ConnectSelect`. While refetching the table dims (`opacity-60`) instead of unmounting.
- Empty states distinguish "no orders in this range → try a wider range or All time" from
  "nothing on this page matches your search".
- **Light + dark**: everything uses the `crm-*` tokens, which already switch with
  `data-theme`. The one exception was the native date picker — `crm.input` hard-codes
  `[color-scheme:dark]`, so the two date inputs use `crm.selectCompact` plus a new
  `.tracking-orders-date` rule at the end of `globals.css` (`color-scheme: dark`, and
  `light` under `:root[data-theme="light"]`).
- `services/deliveryApi.ts`: `orders()` takes `from/to/page/pageSize`, returns
  `DeliveryOrdersPage`; new `stores()` → `DeliveryStoreRow[]`.

## 4. Verification state

- ✅ `orderQuery.test.ts` 7/7 on the dev box.
- ⛔ **No `tsc` on this box** (pnpm store unreadable — memory `devbox-toolchain-blocker`);
  the Docker build in `deploy-api.sh` / `deploy-portal.sh` is the type gate.
- ✅ **API DEPLOYED** — `scripts/release/deploy-direct.sh api --commit 790ecf22` (dry-run
  first), blue/green clean, `[deploy-api] done 790ecf22`, total 428 s. `prisma migrate
  deploy` applied `20260908160000_delivery_order_created_at_index`; `pg_indexes` on the
  production Postgres (`connectcomms-postgres`) lists
  `DeliveryOrder_tenantId_createdAt_idx (tenantId, createdAt)`. `app-api-1` carries
  `routes.ts:68 searchOrders(user.tenantId, parseOrdersQuery(req.query))` and
  `src/delivery/orderQuery.ts`. (An unauthenticated curl returns 401 for every path,
  including nonsense ones — it proves nothing about a route; the container grep does.)
- ✅ **PORTAL DEPLOYED** — `deploy-direct.sh portal --commit 790ecf22` resolved to the
  branch head **`cfc17107`** (another session's `fix(telephony): never seed Asterisk's
  Message/ast_msg_queue pseudo-channel…` landed on top of 790ecf22 between the two
  deploys; 790ecf22 is its ancestor). `[deploy-portal] done cfc17107`, `/ready` 200.
  `app-portal-1`'s built `.next/server/app/(platform)/tracking/orders/page.js` contains the
  new copy ("No orders received in this range. Try a wider range or All time.").
  ⛔ Note for that other session: the **api** container is at 790ecf22 — their telephony
  fix is built into the portal image only and is NOT deployed to the api.
- ⏳ **NOT PROVEN: a logged-in look at the page in light and dark mode.** Ezra's Chrome had
  no MCP tab group (rule: never spawn a separate window — memory
  `browser-use-ezras-window`) and the in-app browser has no portal session. Everything
  theme-related is `crm-*` tokens plus the one `color-scheme` rule, so the risk is the
  native date picker chrome only. First person on the page: open Tracking → Orders, click
  `Custom…`, check the two date fields in both themes.

## 5. Traps for the next agent

- The worktree `C:\dev\projects\connect2-takeover` is **CRLF on disk** (`core.autocrlf=true`,
  index LF). An exact-string patch written with `\n` anchors silently fails; normalise
  `\r\n`→`\n` on read and back on write. The first patch attempt here half-applied one file
  before the second anchor missed — restore with `git checkout HEAD -- <file>` and re-run.
- `git push` was rejected once because another session pushed between fetch and push
  (Trust 1730 dialplan work). `git fetch && git rebase origin/<branch>` then push — the
  rebase was clean because this commit touches no shared doc.
- If a tenant reports "the total is wrong", remember `total` counts the whole filter, while
  the search box narrows only the loaded page — that is by design and the copy says so.
