# ⛔ AGENT HANDOFF — Tracking → Orders now has a Received date-range filter, store filter and real paging; the "only 24 hours" complaint was the newest-100 row cap, not a time rule (2026-09-08) — READ FIRST before touching `GET /delivery/orders`, `orderService.listOrders/searchOrders`, or the orders page filters

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ORDERS_DATE_RANGE_PAGING_2026-09-08.md`**
(commit **`790ecf22`**, 9 files; mockup approved first at
https://claude.ai/code/artifact/acd624fa-73f1-4e02-b6da-0df7ffcbb2dc).
Izzy: *"filters to look up orders as far back as it goes … right now it's only showing me
24 hours back"* → *"go, build it as drawn. Light mode and dark mode."*

- ⛔ **There was never a 24 h rule.** `listOrders()` returned the newest 100 rows (cap 200),
  no date filter, no paging; a busy day filled the list. Do not hunt for a time constant.
- ✅ **API:** `GET /delivery/orders` → **`{ items, total, page, pageSize }`** (was a bare
  array; the portal page was the only consumer). Query `status, storeId, from, to` (ISO
  instants, inclusive on `createdAt`), `page` (1-based), `pageSize` (default 50, max 200),
  parsed by pure **`orderQuery.ts`** (7 tests green on the dev box — ⛔ the package `test`
  glob list omits `src/delivery/*.test.ts`, so nothing there runs under `pnpm test`).
  New `GET /delivery/stores`. `@@index([tenantId, createdAt])` on `DeliveryOrder` +
  migration `20260908160000_delivery_order_created_at_index`.
- ✅ **Portal:** filters live in the URL (`range=today|7d|30d|90d|all|custom`, `from/to`,
  `status`, `store`, `page`, `size`); presets are the browser's local day boundaries; a
  Custom From/To pair with Apply; store `ConnectSelect` only when >1 store; new
  **Received** column; count line + pager + rows-per-page. Light/dark via `crm-*` tokens;
  the native date picker gets `.tracking-orders-date` (`color-scheme` per theme) because
  `crm.input` hard-codes `[color-scheme:dark]`.
- ✅ **DEPLOYED + container-verified 2026-09-08:** api `790ecf22` (blue/green clean, 428 s;
  `prisma migrate deploy` applied the index — `pg_indexes` on `connectcomms-postgres` lists
  `DeliveryOrder_tenantId_createdAt_idx`; `app-api-1` has `routes.ts:68 searchOrders(…parseOrdersQuery…)`).
  Portal deployed at branch head **`cfc17107`** (another session's telephony fix on top of
  790ecf22 — built into the portal image only; ⛔ the api container is still 790ecf22, that fix
  is not on the api); `app-portal-1`'s built orders `page.js` carries the new copy. ⏳ **NOT
  PROVEN: a logged-in look in light + dark** (no MCP tab group in Izzy's Chrome, no portal
  session in the in-app browser) — first person on the page: click `Custom…` and check the
  two date fields in both themes.
- ⛔ The worktree is **CRLF on disk** — exact-anchor patch scripts must normalise line
  endings (memory `takeover-worktree-crlf-patching`).
