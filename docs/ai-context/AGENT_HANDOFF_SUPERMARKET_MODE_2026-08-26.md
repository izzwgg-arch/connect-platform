# AGENT HANDOFF — CRM SUPERMARKET MODE, phases 0–7 in one shot (2026-08-26)

Commit `8e224306` on `feat/ivr-migration-takeover` (44 files, 8,655 insertions,
parent `6f64c768` = the sibling voice-agent session's portal page). Izzy's
order, verbatim: *"do phase 0 to 7, one shot. Do not stop until it's done, end
to end... Run 25 very, very heavy stress tests on the whole system with proof
that everything is working end to end, no bugs"* — and *"make everything
exactly on the dot like the mock-ups. Exactly, exactly, exactly."*
Plan artifact: <https://claude.ai/code/artifact/0312b85a> (The Supermarket
Plan). Mockups: The Orders Desk v9. Gesheft POS intake:
`AGENT_HANDOFF_GESHEFT_POS_API_2026-08-25.md`.

## §1 What exists, by phase

**Phase 0 — keys/vault.** `apps/api/src/supermarket/integrationCredentials.ts`
on the EXISTING `ProviderCredential` table (`@@unique[tenantId, provider]`,
`credentialsEncrypted` envelope via `@connect/security`). New
`IntegrationProvider` values `POS_TRACKING`, `SOLA`, `OPENAI`. Keys are
write-only (masked `…last4` hints); `resolveIntegrationKey` never throws into a
route (null = "no register connection", an answer). ⛔⛔ **NO FALLBACK, and a
wiring test pins it**: `posClientForTenant`/the Sola lane never reach for a
platform-level key — a customer's charges must never ride the platform's own
merchant account.

**Phase 1 — POS bridge.** `posWithLogic.ts`, a zero-dependency client for
`api.poswithlogic.dev`: `x-api-key` header, `X-Customer-Pin` only on
balance/charges, `AbortController` timeouts, error classification
(401→`pos_auth_failed`, 402→`pos_out_of_credits`, 404→`pos_not_found`,
409→`pos_duplicate`, 429→`pos_rate_limited` + Retry-After), credit metering by
their documented table (writes 18, reads 0–1) via an `onCredits` callback.
⛔ **The client NEVER retries — proven by test** (one charge call = one HTTP
request even on failure). ⛔ `priceQty` is a **DIVISOR** ("2 for $10" = $5
each, `posUnitPriceCents`). `toPosExternalId` caps at their 20-char limit.
`catalogSync.ts` = the 15-min sweep (3-min boot kick): `lastMod` incremental,
cursor pages keep ALL params (their rule), page-budgeted with cursor RESUME,
⛔ **the high-water mark advances ONLY on a finished sweep** (mid-cursor
advance skips the unfetched tail forever — STRESS 11 pins it).

**Phase 2 — modes + cockpit.** `Tenant.crmMode` (`"classic"` default).
`crmMode.ts`: `requireSupermarketMode` (fail-CLOSED per route; SUPER_ADMIN
passes for inspection) + `crmModeEnforcementHook`, a server.ts preHandler that
403s supermarket tenants off `/crm/campaigns` + `/admin/sms/campaigns`
(*"cold calling is over"* — fail-OPEN on DB error so a hiccup can't kill
classic tenants' campaigns; deliberate asymmetry). Portal: `/orders` (the
Orders Desk), `/orders/new`, `/orders/twin`, `/orders/deliveries`,
`/orders/drivers`, `/orders/specials`, `/admin/integrations` — all ported from
the v9 mockups (CSS machine-derived by `make_portal_css.py`, uniform `.sm-`
prefix scoped under `.sm-root`; a portal guard fails if any selector escapes
the prefix).

**Phase 3 — drafts.** `draftBuilder.ts` sweep (2-min interval, 4-min boot):
voicemail transcripts + inbound SMS on supermarket tenants → `matchDraftText`
against the synced catalog (item numbers `/^\d{2,8}$/`, names ≤3 tokens,
English + Yiddish quantity words, `xN` suffix; ⛔ ambiguous names are DROPPED,
never guessed) → `SupermarketOrderDraft` rows (`@@unique[tenantId, sourceType,
sourceId]`, `agentItems` frozen at build). WIC (`w.i.c.`/`וויק`) routes to
COMMENTS automatically. Rep reviews in the Orders Desk → `PATCH` →
`POST .../approve` → `approveAndSubmitDraft` (`orderSubmit.ts`): **atomic
claim** (`updateMany` conditioned on status → SUBMITTING), corrections frozen
BEFORE the external call, `createOrder` with the row-derived `externalOrderId`;
`pos_duplicate` (409) → read-back = landed; failure → SUBMIT_FAILED, **never
auto-retried**. Delivery-method orders feed `ingestDeliveryOrder` (the
delivery-tracking system, same process) best-effort AFTER the register
accepted.

**Phase 4 — pay-by-phone IVR.** `payIvrCore.ts` (pure reducer) +
`payIvrRuntime.ts` (DB-backed session on `SupermarketPayCall`) behind
`POST /internal/supermarket/pay-ivr/step` (internal-secret guard, on the JWT
bypass). Star is the decimal point (`25*37` = $25.37, `payAmount.ts`); prompts
splice from the recorded set (num_0..20, tens, hundred/thousand,
16_dollars/17_cents/18_and — identical filenames both voice sets). PIN
enrollment ⛔ ONLY on caller-ID-matching keyed calls, encrypted at rest,
purged when stale; foreign lookups NEVER enroll (STRESS 22). All attempt caps
3; charges cap 3/call; charge `externalId` = row-tail + chargeSeq.
⛔ Stored cards only — a wiring test greps runtime+core for card-capture
shapes and fails on any. ⏳ **The PBX dialplan half is NOT written to the PBX**
— it needs a maintenance-window mandate + the real key; the api door is live
and fail-closed.

**Phase 5 — per-customer keys.** The `/admin/integrations` screen (SUPER_ADMIN
only, nav-forced): tenant picker, CRM-mode switch, key rows with **Test**
(differential refusal: probe `getOrderById("connect-key-probe")` —
`pos_not_found` = key works, `pos_auth_failed` = rejected), supermarket
switches (payIvrEnabled / deliveryIngestEnabled / autoSubmit). Key removal is
`POST /admin/integrations/keys/remove` (⛔ not DELETE — `apiDelete` carries no
body) and DELETES the row, never blanks it.

**Phase 6 — specials.** `specials.ts`: the walled marketing lane —
`MARKETING_MAIL_ENABLED=1` gate (⛔ specials never ride the platform support@
mailbox; refusal queues NOTHING, STRESS 20), recipients = the tenant's own
Contact primary emails minus `MarketingUnsubscribe`, deduped, capped 2000,
3 blasts/day, atomic claim so concurrent sends collapse to one (STRESS 19).
Every email carries an HMAC unsubscribe link (`urlSigningSecret` scheme
`"marketing-unsubscribe"`, public route `GET /marketing/unsubscribe/:token` on
the bypass). EmailJob type `MARKETING_SPECIAL` (⛔ never ADMIN_ALERT), body
HTML-escaped (hostile content proven escaped).

**Phase 7 — learning + drivers.** `learning.ts`: ISO-week correction stats;
`decideAutoSubmit` needs the switch AND ≥N clean weeks AND ≥5 drafts/week AND
rate ≤ threshold (10k-history brute-force agreement sweep, STRESS 23). Driver
onboarding: `POST /supermarket/drivers/full` (User INVITED + DriverProfile +
`DRIVER_INVITE` email with the Loopcom Driver setup steps);
⛔ resend-invite refuses 409 once `lastLoginAt`/ACTIVE (the TYH lesson).
`/orders/deliveries` = the live map (driver pills, GPS-off banner, crm:dial
call cells).

**The order twin.** `SupermarketOrderPop` (mounted in providers.tsx): a
PASSIVE observer of `useOptionalSipPhone` — on ringing→connected inbound in a
supermarket tenant, the mini dialer `window.open`s `/orders/twin?phone=…`
(420×720) and broadcasts on localStorage so a full window can follow; full
windows `router.push` `/orders/new`. ⛔ A guard greps it for any call-path
touch and fails — it can never affect answering. The twin warns on
`beforeunload` while a draft is open ("must not disappear until the order is
put through").

## §2 Wiring (the shapes that rot silently — all test-pinned)

- server.ts: imports + `registerSupermarketRoutes({...})` before
  `registerMfaRoutes`; `crmModeEnforcementHook` preHandler; sweeps armed with
  boot kicks + intervals behind `SUPERMARKET_SWEEPS_DISABLED`; boot line
  **`SUPERMARKET_SWEEPS_ARMED`** — grep it after every deploy.
- Rules: `{ prefix: "/supermarket", permission: "can_view_supermarket_orders" }`,
  `{ prefix: "/supermarket/mode", permission: null }` (longest-prefix wins —
  the mode probe must be reachable by every signed-in user or the order pop
  can never learn the mode), `{ prefix: "/admin/integrations", permission:
  "can_manage_global_settings" }`.
- Bypass: `isInternalSupermarketPayIvrPath` + `isMarketingUnsubscribePath`,
  const AND OR-chain (403 = reached the handler, 401 = didn't).
- Permission keys `can_view_supermarket_orders`, `can_manage_supermarket_orders`,
  `can_manage_supermarket_specials` (+ drivers ride
  `can_manage_tracking_drivers`): ACTION keys, **in NO default bucket** —
  SUPER_ADMIN via force-add, so no snapshot migration; grant per custom role.
- Ownership-first ordering on every draft route: tenant-scoped `findFirst` →
  404 BEFORE permission → 403 BEFORE body → 400 (STRESS 14 pins a foreign
  draft answering 404 to a fully-keyed foreign user).
- Env switches: `SUPERMARKET_SWEEPS_DISABLED=1`,
  `SUPERMARKET_CATALOG_SYNC_INTERVAL_MS`, `SUPERMARKET_DRAFT_BUILDER_INTERVAL_MS`,
  `SUPERMARKET_CATALOG_PAGE_BUDGET`, `MARKETING_MAIL_ENABLED`,
  `MARKETING_UNSUBSCRIBE_URL_SIGNING_SECRET` (else derived from JWT_SECRET).

## §3 The migration

`20260826020000_supermarket_mode`: 3 enum values, `Tenant.crmMode`, 10 tables
(8 supermarket + the sibling's `VoiceAgentSettings`/`VoiceAgentCall`, carried
by agreement), 8 FKs. Generated by `prisma migrate diff`, accessors verified
against the real generated client. **Everything inert on deploy**: 0
supermarket tenants, all switches off, keys in no bucket.

## §4 The 25 heavy stress tests (Izzy's stop-condition) — ALL PASS

`supermarketStress.test.ts` (+ 30 unit in `supermarketCore.test.ts`, 10 wiring
pins in `supermarketWiring.test.ts`, 8 portal guards in
`apps/portal/lib/supermarketPortal.test.ts`; **63 api + 8 portal, all green**;
api typecheck 76 = exact baseline, portal 0). Registered:
`"src/supermarket/*.test.ts"` in apps/api, `lib/supermarketPortal.test.ts` in
the portal list. Infrastructure: `supermarketTestKit.ts` — a faithful fake db
(snapshot reads, P2002 uniques, honest updateMany, **relation filters in
`where` via a resolving Proxy**) + a faithful fake POS register (documented
semantics, failure injection, request log); seeded PRNG so every failure
replays.

Highlights: reducer fuzz 3k calls/60k events (no charge without a fresh
confirmation, ever); amount entry EXHAUSTIVE over the full DTMF alphabet ≤5
chars + 50k randoms; every dollar amount 0–99,999 splices only recorded
prompts AND **reads back as its own value** (a revaluer re-hears the splice);
400-call runtime marathon with injected 500s/timeouts — session books
reconcile with the register ledger TO THE CENT; 25 concurrent approvals → ONE
register order; timeout→retry→409-readback lands once; 300-op tenant-isolation
storm with forged tenantIds in every body → zero bleed, zero 500s; 5k
unsubscribe forgeries → none verify to a foreign identity; 2,600-contact blast
dedupe/cap/claim; 100-driver-create storm → one login; PIN store lifecycle;
10k-history auto-submit brute-force agreement; 600 hostile bodies over every
write route → zero 500s, zero prototype pollution; the 120-order end-to-end
marathon (voicemail/text → sweep → rep → register → delivery tracker →
corrections → auto-submit verdict → a real pay call settling the balance).

**The stress run caught two real defects before they shipped:**
1. ⛔ **The draft sweep stalled forever past 50 sources**: per-row dedupe alone
   meant every sweep re-read the same oldest `MAX_SOURCES_PER_RUN` (all
   drafted) and created nothing — a busy store's tail was never reached. Fixed
   with `id: { notIn: draftedSourceIds }` in the QUERY (found by STRESS 25).
2. ⛔ **The matcher duplicated line items** when one product matched by name
   AND code ("2 milk" + "104 x3" = two rows to the register). Merge is on the
   PRODUCT now.

Also earned: base64 malleability is not forgery (a trailing-sextet bit flip
decodes to identical bytes — the invariant is "never verifies to a FOREIGN
identity"); and the comment-stripping rule bit a sixth time (the stylesheet's
own header names `.tab`/`.tabs` while explaining their avoidance).

## §5 Cross-session contract (voice agent, session connect-2-7a)

They build the conversational voice agent ON my tables: drafts with
`sourceType: "voice_call"` + frozen `agentItems`; OPENAI key through MY
`storeIntegrationKey` (one ProviderCredential writer); they NEVER call the POS
submit — a voice order lands as a draft for the rep. My commit carried their
schema models, bypass entries, bypass test, nav row + force line, portal test
registration; **surgically excluded** their server.ts hunks + api package.json
glob (their api half imports their untracked `apps/api/src/voiceAgent/`) —
committing those would have shipped an import of files not in the repo.
Private-index with pinned base (`read-tree $BASE` + `commit-tree -p $BASE` +
compare-and-swap `update-ref ... $NEW $BASE`), then the shared index repaired
by re-adding my paths (the staged-deletion trap).

## §6 ⏳ NOT PROVEN — the honest list

- **No real POS call has ever been made.** The Gesheft key never arrived;
  everything provider-facing is proven against the faithful fake only. First
  key in → use the admin screen's Test button (differential refusal).
- **The pay-IVR has no PBX dialplan** — the api door is live and fail-closed;
  the AudioSocket/dialplan half needs a maintenance-window PBX mandate.
- **The marketing lane is OFF** (`MARKETING_MAIL_ENABLED` unset) and no
  sending mailbox exists for it.
- **No human has opened any screen**, no tenant is in supermarket mode, no
  driver has been invited, no twin has popped on a real call.
- ✅ DEPLOYED 2026-08-26: api job `b1b93518` → `c65bf3a8` (container-verified:
  boot line, tables, fail-closed doors, 0 restarts); portal job `727c5c63` →
  `38b6c54c` after the cssnano fix (bundle string-verified). The voice-agent
  sibling's api half rode the same api deploy; their telephony half + env/PBX
  steps await Izzy's word.

## §7 THE KEY ARRIVED — the register is live (2026-08-26, same night)

Izzy pasted Gesheft's POS key and flipped their crmMode himself. The first
real calls ever made found the API differing from its printout four ways —
each fixed, deployed and pinned by a verbatim fixture (`1d84a4b9`, `09954727`,
`93d7ac60`, `bdb5af35`):

1. **Envelope**: `{results, hasMore, cursor, total}`; items carry
   `itemCode`/`description`/`prices[]`/`active`/`lastModified`. The shipped
   parser returned null → the sweep would loop `pos_unparseable_page` forever.
2. **`prices[]`** includes EXPIRED Specials beside Regular —
   `pickEffectivePrice` filters priceFrom/priceTill windows; in-window Special
   beats Regular; `qty` is the bulk divisor.
3. **Cursors die between runs** (stored cursor → 500 on the next run's first
   request, at 8 and 11 min of age — proven twice). Walks must finish in one
   run: full walks are active-only, cursors never persisted,
   DEFAULT_PAGE_BUDGET 400 paced pages.
4. **Rate limiter**: a full-speed walk 429s at ~page 73. Pages paced 350ms
   (SUPERMARKET_CATALOG_PAGE_PACE_MS); a 429 waits capped Retry-After and
   retries the SAME page (MAX_RATE_LIMIT_WAITS/run). Proven live: two waits
   mid-walk, walk continued.

Also: order-by-id answers **500** on the probe id (Test falls back to a
1-credit products read); `take` capped at 100; ⛔ their `total` is a filtered
figure (said 5,211; active catalog ≈ 19,244) — never size off it.

**End state, verified live**: 22,063 catalog rows, `finished:true`, high-water
`2026-08-25T23:05:32-04:00`; the next tick cost **1 credit** and upserted 45
live register edits. Quick-add search returns real rows (Challah, foil pans,
real prices). Shape discovery spent ~533 credits total, one-time. The "Store"
sidebar section shipped the same night (`03a5f370`): section key
`can_view_section_store` in NO default bucket — SUPER_ADMIN-only until granted.

## §8 — Night 2 (2026-08-26): the order pipeline grew a brain, cards on file, photos, the phone-is-the-account rule

Commits `9ba7368c` → `1d4e3249` on `feat/ivr-migration-takeover`; api deployed
through the queue same night (jobs 956e06be / 2960707e / b27b69d2), portal
(dff7f0d6 hover-zoom + f9dd5e2f cards). Migrations applied by the api deploys:
`20260826050000_catalog_brand_size`, `20260826070000_draft_customer_info`,
`20260826090000_customer_cards_payment`.

### The YL + brain pipeline (Izzy's orders, same session)
- `orderYiddish.ts` — YL sync STT for voicemail audio (local audio store file),
  YL translate-english for Yiddish text; key from the AgentSecret row
  `yiddishlabs_api_key` (env fallback); 402 = out of credits, its own code;
  a transcription is attempted ONCE per source. Degradation ladder ends at the
  stored transcript — a draft with a worse transcript beats no draft.
- `orderBrain.ts` — two bounded chat.completions calls on the TENANT's OPENAI
  ProviderCredential (no platform fallback). EXTRACT judges `isOrder` first
  (complaints/questions/chatter → notAnOrder + reason, resolve pass skipped);
  captures the SPOKEN account phone (7 digits → 845…). RESOLVE picks from
  server-fetched candidates per line + `customerUsuals` (the customer's own
  SUBMITTED drafts, prices refreshed from the live catalog row). Constraint
  honouring is the point: "not brand X" → a different brand or a refusal into
  notes. Hallucinated ids dropped. Null on ANY failure → regex matcher.
- `draftBuilder.composeDraftContent` — the ONE pipeline for both sweep blocks
  and the reprocess door; engine provenance "brain:<model>[+yl]"/"matcher[+yl]";
  YL audio budget SUPERMARKET_YL_MAX_TRANSCRIPTIONS_PER_RUN (10) per sweep —
  over budget a voicemail WAITS for the next tick. notAnOrder → the draft is
  created (or reprocessed) as DISMISSED with the reason in notes — the dedupe
  anchor survives, the review queue stays honest.
- Reprocess door `POST /admin/integrations/reprocess-drafts` {tenantId, limit,
  draftIds?} — NEEDS_REVIEW only (never rewrites a decision), sequential on
  purpose (YL is per-credit, OpenAI per-token), per-draft result rows.
  ⛔ Repeat calls WITHOUT draftIds re-take the same newest N forever (reprocess
  does not change status) — the runner must pass explicit id slices.

### Live findings that shaped it
- ⛔⛔ **Gesheft's POS key: `customer:get` access level "own"** — cannot read
  the store's existing customers; every lookup answers "Customer not found or
  you do not have access to it" (and some records 500 "unexpected error").
  Discovered by probing path variants; `/customers/phonenumber/{10digits}` IS
  the right path. POS with Logic must raise the key to access level "all".
- ⛔ **The catalog rate limiter is a rolling QUOTA** — 350ms pacing died at
  page 96, 2s at 177, **2.5s finished all 193 pages in one run** (19,244
  upserted, lastError null, high-water set → incrementals 1 credit again).
  brand on 15,865 rows; the rest carry no brand at the register.
- The reprocess test over Izzy's pinned scope (newest 10 voicemail drafts +
  the page's 60 texts) ran the same night — results in the session log
  (loopcom /root/reprocess-run.log): the brain filled items, translated, and
  correctly ruled non-orders ("Audio contained no clear speech", "Customer is
  asking why you need their pen; no items requested").
- Photos: 4,085/22,063 rows carry a webstore photo — ALL the webstore offers;
  hover-zoom uses the CDN's `large` size (xlarge/original 403).

### Cards on file (approved mockup 18c52179, built both themes)
- `customerCards.ts` + routes GET/POST `/supermarket/customers/:id/cards`,
  POST `/supermarket/drafts/:id/charge`. Money rules: tenant SOLA key only
  (guard: no resolveBillingGatewayConfig/billingSolaConfig anywhere in the
  file); chargeToken called EXACTLY once per attempt (guard counts call
  sites); silent Sola → paymentStatus UNKNOWN and the route 409s any second
  press; DECLINE recorded, order unaffected. SmCustomerCard stores the
  encrypted xToken (cc:save on the tenant key from the iFields SUT).
- Desk: Payment block per the mockup; Enter-advance through card fields via
  the shared CardknoxIFieldsForm's new opt-in `enterAdvancesFocus`
  (react-ifields `options.autoSubmit` + `onSubmit` per iframe — README-proven
  Enter detection); → opens "Sure you want to place this order?", Enter
  places (confirm button autofocused), Esc backs out. The charge chains AFTER
  approve succeeded.
- ⏳ Register-sourced cards (`pos:` ids) are listed but chargeable only when a
  record carries a gateway token — unknown until the customer scope is fixed.
  ⏳ Sola key + public ifieldsKey arrive "tomorrow"; the SOLA key entry now
  accepts ifieldsKey. Until pasted, every card surface refuses in plain
  English and orders go through unchanged.

### The phone IS the account
- posPhoneDigits: 7 digits → `845` + digits. The brain's spoken phone beats
  caller ID for the lookup; the desk editor's phone box PATCHes customerPhone
  (route normalizes, POS-looks-up, fills posCustomerId/customerName/
  customerInfo). `extractPosCustomer` pulls id/name/address/email + bounded
  raw into `customerInfo` — "once we find the account, bring in everything".

### Still open
- POS key scope fix (their side) — gates account lookup AND register cards.
- Sola key + ifieldsKey paste (Izzy, tomorrow) — first live save-card + charge
  is the acceptance test.
- Learning layers 2+ (phrase→item lessons harvested from rep corrections;
  cheap history mining of months of texts WITHOUT YL) — designed, not built.
- Nobody has driven the card UI in a browser; the reprocess quality verdict
  is Izzy's to make from the drafts screen.

## §9 — Later on night 2: truncation fix, stock, photo pass 2, keyboard flow

- ⛔⛔ **THE BRAIN WAS TRUNCATING ON REAL ORDERS — the recorded gpt-5 trap,
  caught on Izzy's own test case.** Pearl Mutter's 31-line WIC voicemail
  filled only 6 items (the regex matcher's answer). Probed live: the extract
  call used 3,946 of its 4,000-token cap, **3,264 of it reasoning** — over the
  cap on the real run, truncated JSON, silent matcher fallback. Both calls now
  cap at 16,000 (`orderPipeline.test.ts` pins them ≥16000). After the fix the
  same draft fills 18 items with the WIC split, returns and refusal reasons in
  notes. ⛔ Reprocess reuses a draft's stored YL transcript+translation
  (`preTranslated`) — re-running the brain never re-bills YL audio.
- **Closest-match "?"** (Izzy: "fill in with the one available and put a
  question mark"): the resolve pass picks the close variant with
  `unsure:true` instead of refusing; the flag survives sanitizeDraftItems and
  renders as a "?" pill. Refusal only for nothing-close / hard constraints.
- **Live stock, zero extra credits**: `onHand` parsed off every catalog tick;
  suggestions in-stock-first with "not in stock" labels (out-of-stock shown
  at the bottom, NEVER hidden — Izzy corrected mid-build); order lines carry
  the tag via draft-detail hydration; brain candidates carry inStock:false.
  No backfill walk (his "least credits possible") — stock fills as the
  register touches items; freshness rides the 15-min incremental.
- **Photo pass 2 by brand+name+oz**: category-walk harvest in the browser
  (394 nav categories, `filters={}`, size=100; the flat list 403s; their own
  filter hides out-of-stock) → 6,864 products with names/brand/weight/unit →
  conservative matcher (brand agreement + token overlap + oz equality,
  ambiguity skips) → 455 new matches ingested via the barcode door using the
  POS row's OWN code. 4,540 rows now carry photos. Only 13 products were
  missing from the original barcode harvest by image-URL diff.
- **Keyboard flow** (Izzy): Enter advances through the card iFields
  (react-ifields `options.autoSubmit` + `onSubmit`), → opens "Sure you want
  to place this order?", Enter places, Esc backs out.
- ⛔ Trap re-paid: `pkill -f <script>` over ssh self-matches the remote
  shell's own command line when ANY part of the command names the file —
  split the pattern AND keep sed/nohup mentions out of the same ssh call.

## §10 — the brain's item search learned BRANDS (2026-08-26, `5f318d52`, api DEPLOYED)

Izzy, from two live drafts: "Why wasn't the Lux added to this order?" (Berkowitz
— "Ta'am Tov cream of lox" refused while Cream Of Lox sat in the catalog) and
"This one said gold. They should have been searching the brand they say as
well" (Falkowitz — "Gold's pads" picked **Steelwool Soap Pads**). Then: "most
orders missing items. The agent needs to be a lot better."

- ⛔ **The candidate search only matched product NAMES.** "Ta'am Tov" lives in
  the `brand` column, so no token combination could surface the lox, and the
  single-token "cream" pass filled the 8-slot pool with soups before "lox" ever
  ran. `searchCandidates` (orderBrain.ts) now:
  - matches every token against **name OR brand** (`tokenWhere`);
  - runs **most-specific-first**: all-tokens AND → every pairwise AND →
    singles — so a polluted generic word can no longer starve the pool;
  - **stems** each token for the contains() (`gallons`→`gallon`,
    `pads`→`pad`, `cuties`→`cuti`) so plural/singular meet both ways;
  - the tokenizer **drops apostrophes** (`gold's` → `gold`) — the register may
    store `'` vs `’` and a contains() on either spelling misses.
- ⛔ **RESOLVE prompt: a spoken brand is a HARD constraint.** Never another
  brand's product off a generic word (pads, milk, cream); brand absent from
  candidates → refuse the line or same-TYPE pick with `unsure:true`.
- ⛔ **The fake db was ignoring its where AGAIN** — the pipeline tests' catalog
  fake returned everything, so the old name-only search passed green.
  `fakeBrainDb` now evaluates AND/OR/contains/in faithfully and takes an
  optional catalog; the cream-of-lox regression test builds the polluted pool
  and asserts the lox comes back FIRST.
- **Fleet reprocess**: all 221 NEEDS_REVIEW drafts re-run through the improved
  brain (216 with stored YL text = zero YL cost; before-count 192 items
  total). Runner: `/root/reprocess-all.js` + `/root/reprocess-ids.json`,
  copied into the container, batches of 10 by explicit draftIds.
