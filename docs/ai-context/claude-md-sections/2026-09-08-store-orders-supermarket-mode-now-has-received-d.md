# ⛔ AGENT HANDOFF — Store → Orders (Supermarket mode) now has Received date-range, status tabs (+Failed, +Dismissed), Source, server-side search and paging; "only two orders left" was the workspace switcher on All workspaces (2026-09-08) — READ FIRST before touching `GET /supermarket/drafts`, `OrdersDesk.tsx`'s list, or for ANY "the orders disappeared"

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_ORDERS_DESK_FILTERS_2026-09-08.md`**
(commit **`65225b5e`**; mockup approved first at
https://claude.ai/code/artifact/cf7ce2bb-68b5-46a9-a75d-8a3307db1e68). This is the page Izzy
meant by *"the orders page … only showing me 24 hours back"* — the Tracking → Orders work in
the section below was the wrong page (still valid, not the ask).

- ⛔ **"All the orders are gone, only two are left" = header switcher on All workspaces.** No
  `x-tenant-context` → `resolveEffectiveTenantBillingContext` falls back to the Support user's
  own tenant (Connect Communications: exactly 2 drafts from 08-26). Gesheft had 932 + 431 rows
  throughout. Check the switcher before suspecting a deploy or data loss.
- ⛔ **There was never a 24 h rule** — the list was `take: 100` newest, no date filter, no
  paging; Gesheft's ~60–120 drafts/day filled it.
- ✅ **API:** `GET /supermarket/drafts` takes `status, source, from, to, q, page, pageSize`
  (pure `draftListQuery.ts`, 7 tests green, in the package test glob); response keeps `drafts`
  and adds `total/page/pageSize`. Search = name (insensitive) / phone digits / POS order #.
  No migration (indexes existed).
- ✅ **Portal:** URL-backed filters (`tab, range, from, to, src, q, page, size`); tab strip +
  Failed to send + Dismissed; filter bar with Received presets + Custom from/to, Source chips,
  Clear filters; live search; ONE table for all tabs with a real Received date/time, count
  line, pager, rows-per-page; dark + light (`color-scheme` per theme on the date inputs).
- ✅ **DEPLOYED + container-verified 2026-09-08:** api `65225b5e` (235 s, blue/green clean;
  `app-api-1` has `supermarketRoutes.ts:622 parseDraftListQuery`), portal `65225b5e` (29 s; the built
  chunks + CSS carry `sm-filterbar`), both `/ready` 200. A first portal attempt was cancelled at the
  BUILD stage (never cut over) when I noticed the entangled auth commit; Izzy then said *"Just deploy the
  filters as we discussed"* and it was redeployed. ⏳ NOT PROVEN: a logged-in look in light + dark.
- ✅ **Same evening — "Kishef 101" = Gesheft ext 101 = user "Phone Orders" (`yisraelweinstock@gmail.com`,
  `cmnmjhr3500anp96hc00p068a`, role USER, no custom role → every `/supermarket/*` call 403 → the quick-add
  dropdown never fills).** Granted CustomRole **`cmttct4x33omgg0fah09mdt3t` "Store — all access"** (73 keys:
  all 10 Store keys + the whole END_USER bucket) by DB write (handoff §6). ⛔⛔ **A custom role is
  AUTHORITATIVE** — the user's effective set becomes exactly the role's keys, so a "store-only" role strips
  overview/voicemail/chat; always include the base keys. ⛔ The 403 polls on `/orders` seen meanwhile were
  Izzy's OWN desktop (`Loopcom/0.1.17-rc.9`, tenant Landau Home, `classic` mode) — a classic tenant can
  never use Store pages; work Gesheft orders as Phone Orders or as Support with the workspace on Gesheft.
- ⛔ **This deploy was the first to ship another session's `39b9eb4f` "sign-in code v2"**
  (api + portal together so both halves match). If login misbehaves, look there first.
