# ⛔⛔ AGENT HANDOFF — CRM SUPERMARKET MODE is BUILT END TO END (phases 0–7, the Gesheft plan) and is INERT until a tenant is switched on (2026-08-26) — READ FIRST before touching apps/api/src/supermarket, the /orders portal screens, ProviderCredential, Tenant.crmMode, or before believing any POS integration is live

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SUPERMARKET_MODE_2026-08-26.md`**
(`8e224306` + css fix `38b6c54c` on `feat/ivr-migration-takeover`. Izzy: *"do
phase 0 to 7, one shot… Run 25 very, very heavy stress tests… then… call it
done."* ✅ **api DEPLOYED and container-verified** — `app-api-1`
`.build-commit` = `c65bf3a8`, `SUPERMARKET_SWEEPS_ARMED` boot line, all 10
tables applied, 0 supermarket tenants, doors fail closed (pay-ivr 401/403,
unsubscribe junk 400), health 200 both hostnames, 0 restarts. ✅ **portal
DEPLOYED and bundle-verified** — `app-portal-1` = `38b6c54c`, all six
/orders routes + `sm-root` in the shipped CSS + `sm-order-pop` in the app
layout chunk. ⛔ The FIRST portal deploy died in cssnano on generator debris
in supermarket.css — a mangled comment + a raw `:root` token dump that would
also have leaked mockup tokens portal-wide; excised, then proven by running
next's own compiled cssnano over the file BEFORE re-enqueueing. **Validate a
generated stylesheet with the deploy's own minifier before shipping it.**)

- ⛔⛔ **EVERYTHING IS INERT ON DEPLOY**: `Tenant.crmMode` defaults `"classic"`
  (0 supermarket tenants), the 3 new permission keys are in NO default bucket,
  `MARKETING_MAIL_ENABLED` is unset, and the sweeps no-op on tenants without a
  `POS_TRACKING` key. Nothing changed for any existing customer.
- ✅✅ **SUPERSEDED HOURS LATER THE SAME NIGHT: THE KEY ARRIVED AND THE REGISTER
  IS LIVE.** Izzy pasted Gesheft's key + flipped them to supermarket mode
  himself (2026-08-26 01:40Z); the catalog synced end to end — **22,063 items,
  193 paced pages, `finished:true`, high-water set; incrementals now cost 1
  credit/15 min and picked up 45 live register edits on the first tick.**
  ⛔⛔ **THE REAL API DISAGREED WITH ITS OWN PRINTOUT FOUR WAYS, all fixed +
  fixture-pinned** (`1d84a4b9`→`bdb5af35`): (1) the page envelope is
  `results/hasMore/cursor/total` with `itemCode`/`description`/`prices[]`
  items — the shipped parser read NULL and the sweep would have looped
  `pos_unparseable_page` forever; (2) `prices[]` carries EXPIRED Specials
  beside Regular, so effective-price selection filters priceFrom/priceTill
  windows; (3) ⛔ **their cursors DIE between runs** (a stored cursor 500s on
  the next run — proven twice), so a walk must FINISH inside one run: full
  walks are active-only, cursors are never persisted, budget 400 paced pages;
  (4) **their rate limiter 429s a full-speed walk at ~page 73** — pages are
  paced 350ms and a 429 waits Retry-After and retries the SAME page.
  ⛔ Their order-by-id answers **500** (not 404) on a probe id, so the admin
  Test button falls back to a 1-credit products read. `take` is hard-capped
  at 100. ⛔ **Their `total` field is a filtered figure that means something
  else — never size anything off it** (it said 5,211; the active catalog is
  ~19,244). Shape-discovery cost ~533 credits, one-time.
- ⛔ **The POS client NEVER retries a write** (a 409 `pos_duplicate` on the
  idempotency id means it LANDED — read back, never re-post), **`priceQty` is
  a DIVISOR** ("2 for $10" = $5 each), and `externalId` is capped at their 20
  chars. `approveAndSubmitDraft` is **the ONLY register-order writer**
  (atomic claim → SUBMITTING → createOrder → 409-readback; a wiring test fails
  if any other file calls `.createOrder(`).
- ✅✅ **2026-08-26 NIGHT 2 — THE ORDER PIPELINE GREW A BRAIN (commits
  `9ba7368c` → `1d4e3249`, api+portal DEPLOYED same night).** Izzy's rules,
  verbatim-shaped: **(1) Yiddish Labs ONLY** for order transcription/translation
  (`orderYiddish.ts`: voicemail audio → YL sync STT → YL translate-english; a
  Yiddish text → YL translate; English passes through free; every failure
  degrades to the next layer, never blocks a draft; YL audio budgeted
  `SUPERMARKET_YL_MAX_TRANSCRIPTIONS_PER_RUN`=10/sweep — an over-budget
  voicemail WAITS, it never gets the worse transcript baked in). **(2) An
  OpenAI order brain** (`orderBrain.ts`, tenant's OWN OPENAI key, two
  chat.completions calls — extract lines+constraints, resolve against
  server-fetched catalog candidates): "not brand X" picks a DIFFERENT brand or
  refuses into notes; a hallucinated id is dropped; **null on any failure → the
  regex matcher**. **(3) "Not every message is an order"** — the extract pass
  judges isOrder first; complaints/questions auto-DISMISS with the reason in
  notes (proven live: "Customer is asking why you need their pen"). **(4) The
  account IS the phone number** — `posPhoneDigits` 845-defaults 7 digits; the
  brain captures the phone the customer SPEAKS (beats caller ID); the desk
  editor gained an account-phone box + `extractPosCustomer` brings the WHOLE
  record onto `SupermarketOrderDraft.customerInfo`. **(5) Learning layer 1** —
  `customerUsuals` (the customer's own SUBMITTED drafts, live-priced) rides the
  resolve pass. Reprocess door `POST /admin/integrations/reprocess-drafts`
  (NEEDS_REVIEW only, sequential, per-draft results).
  ⛔⛔ **THE CANDIDATE SEARCH MATCHES NAME **OR BRAND**, MOST-SPECIFIC-FIRST,
  ON STEMS (`5f318d52`, handoff §10) — never regress it to name-only.** Two
  live failures taught it: "Ta'am Tov cream of lox" was refused (the brand is
  a COLUMN, "cream" soups filled the 8-slot pool first) and "Gold's pads"
  picked **Steelwool Soap Pads**. `searchCandidates`: all-tokens AND →
  pairwise ANDs → singles; tokenizer drops apostrophes (`gold's`→`gold`, the
  `'` vs `’` trap); contains() runs on stems so plurals meet singulars. The
  RESOLVE prompt makes a spoken brand a HARD constraint (same-type pick only
  with `unsure:true`). ⛔ The pipeline tests' fake db used to IGNORE its where
  — the name-only bug sat green under 104 tests; `fakeBrainDb` now evaluates
  AND/OR/contains/in faithfully.
  ✅✅ **DAY 3 (2026-08-26 afternoon, handoff §12): the CHECKLIST, the TEACHING
  LANE and the KEYBOARD-FIRST FLOW** (`7fc674b1`→`9928ddb3`, both approved
  mockups built exactly). Every draft stores **agentLines** (per-line
  in_cart/unsure/skipped + reason + top-4 suggestions) → the desk's "WHAT THEY
  ASKED FOR" checklist, live-checked against the cart; **phrase lessons**
  (`SupermarketPhraseLesson`) harvested from rep fixes at submit AND taught on
  **/orders/teach** (Enter teaches; the admin's search text is the
  "what-he-meant" second lesson) feed back as `learned:true` candidates —
  hints the model judges, never forced picks; RESOLVE refuses only as a LAST
  RESORT and matches brands by SOUND. **Keyboard**: ↑/↓ rove, digits set qty,
  letters replace the item (⛔ the swap TEACHES the agent), **PageDown is the
  ONE checkout key** (cards-on-file picker inline, Enter pays & places) — ⛔
  ArrowRight no longer opens the confirm; ONE controller serves the desk AND
  the mini twin. ⛔ Reprocess without explicit draftIds re-takes the same
  newest N; an api deploy kills in-flight reprocess handlers — deploy only
  between runs (bit twice on 08-26: two parallel-session deploys each killed a
  run; a server-side supervisor relaunching on the still-missing-agentLines set
  is the converging shape). ✅✅ **DEPLOYED + VERIFIED 2026-08-26 evening: api +
  portal both at `d05e9f3a` (⊇ `9928ddb3`), both migrations applied, teach-page
  chunk + "Complete this order"/"WHAT THEY ASKED FOR" grepped in the shipped
  bundle. Full-fleet reprocess DONE on the new brain: 219 waiting drafts carry
  1,389 items (was 192 items across 221 that morning), 113 non-orders
  dismissed, 205/219 with checklists (1,669 lines: 1,066 in-cart / 332 unsure /
  271 skipped). The 14 without a checklist have EMPTY transcripts — voicemails
  the YL audio budget deferred; they fill on the next sweep, nothing is lost.
  ⛔ Prisma `agentLines: {equals: null}` on a Json column matches NOTHING —
  filter Json-null in JS.** ⏳ Open tabs/desktop app keep the OLD bundle until
  fully reopened — nobody has driven the keyboard flow or teach page yet.
  ✅ **Gesheft ext 101 (yisraelweinstock@gmail.com) is on her OWN role
  "Gesheft" now — `cmta3tac105acsd138bhyi5qc`, 84 keys = the shared Owner
  role's 82 + `can_view_section_store` + `can_view_supermarket_orders`
  (2026-08-26, handoff §11 — permission change only, Izzy: "duplicate their
  Owner… name it Gesheft… then change their role").** She left the shared
  "Owner" role (⛔ still held by 9 users in 9 OTHER tenants — never edit it);
  her effective set was proven byte-identical before/after the move
  (84→84, gained [] lost []). **Editing the Gesheft role is now safe and
  touches only her.** ⛔ `can_manage_supermarket_orders` (put-through + card
  charge) deliberately NOT granted — Izzy said "see"; writes 403 for her
  until his word. ⛔ A service JWT driving `/admin/custom-roles` needs a REAL
  User id as `sub` (createdByUserId FK), and `effective-permissions` needs
  `?tenantId=` or it 403s.
  ⛔⛔ **GESHEFT'S POS KEY IS SCOPED `customer:get` ACCESS-LEVEL "own"** — it
  CANNOT read the store's existing customers ("Customer not found or you do
  not have access to it"), which is why NO draft has ever resolved an account.
  **POS with Logic must raise it to "all"** — everything above lights up then.
  ⛔ **Their catalog rate limiter is a rolling quota, not pure pacing** — a
  350ms-paced walk died at page 96, a 2s-paced one at 177; **2.5s pacing
  finished all 193 pages in one run** (19,244 upserted, high-water set,
  incrementals back to 1 credit; catalog rows carry `brand`/`sizeText` now).
  ⛔ Photos: the POS API has none; they come from Gesheft's own Self-Point
  webstore (browser-harvested) — **4,540** of 22,063 rows carry one after two
  passes: 4,085 barcode-keyed + 455 matched by **brand + name + ounces**
  (Izzy's rule; conservative — 114 ambiguous skipped, a wrong photo is worse
  than none; matcher `scratchpad/photo-match.py`, names harvest
  `webstore-names.json` — the per-CATEGORY list endpoint with `filters={}`
  works in-browser, the FLAT products list 403s, and their own default filter
  HIDES out-of-stock items). Photos render in the quick-add AND on order item
  rows (server-hydrated, stripped on write); hover for the CDN's `large`.
  ⛔ **Live stock (`PosCatalogItem.onHand`) rides every catalog tick at zero
  extra credits** (Izzy: "always in sync… least credits possible") —
  suggestions sort in-stock first with "not in stock" labels (never hidden),
  order lines carry the tag, the brain prefers in-stock and flags "?"
  otherwise. null = not yet synced (shown normally); register drift can go
  NEGATIVE. No backfill walk was run — stock fills as items change; the full
  walk (~193 credits, 2.5s pacing) is the optional fast fill.
- ✅✅ **CARDS ON FILE AT PUT-THROUGH (`2b564f71`, built to the approved mockup
  <https://claude.ai/code/artifact/18c52179-0658-4fb0-b6c3-7e4dc15a924a>, both
  themes).** `customerCards.ts`: register cards (POS `listCustomerCards`, no
  PIN) merged with cards saved via the tenant's OWN Sola iFields
  (`SmCustomerCard`, xToken encrypted); charge = `chargeToken` on the tenant's
  SOLA ProviderCredential — ⛔ **no platform fallback (guard-tested), ONE
  attempt never retried, a silent Sola records `UNKNOWN` and 409s a second
  press, a DECLINE never blocks the order** (recorded on the draft, rep
  chases). Keyboard flow per Izzy: **Enter advances through the card fields**
  (shared `CardknoxIFieldsForm` gained opt-in `enterAdvancesFocus` —
  ifields `autoSubmit` + `onSubmit` focus chain; the five existing payment
  surfaces byte-identical with it off), **→ opens "Sure you want to place this
  order?" and Enter places it**. ⛔ All of it refuses in plain English until
  Gesheft's Sola key + public `ifieldsKey` are pasted under Integrations
  (SOLA key entry accepts `ifieldsKey` now). ⏳ POS-sourced cards are listed
  but only chargeable when their record carries a gateway token — unproven
  until the customer scope is fixed and a real card record is seen.
- ⛔⛔ **THE PER-TENANT KEY LANE HAS NO PLATFORM FALLBACK, EVER** — Sola/POS
  keys live in `ProviderCredential` (`tenantId`+`provider` unique, encrypted);
  `resolveIntegrationKey` answers null and callers refuse in plain English. A
  customer's charges must never ride the platform's own merchant key.
- ⛔ **The pay-by-phone IVR is stored-cards only** (card-capture shapes are
  guard-tested absent), star is the decimal (`25*37`), PIN enrollment only on
  caller-ID-matching KEYED calls (foreign lookups never enroll), one charge
  effect per fresh confirmation — 3k-call fuzz pins it. ⏳ **The PBX dialplan
  half is NOT on the PBX** — the api door
  (`/internal/supermarket/pay-ivr/step`, secret-gated, on the bypass) is live
  and fail-closed; wiring the dialplan needs a maintenance-window mandate.
- ⛔ **Supermarket tenants are WALLED OFF campaigns** (`crmModeEnforcementHook`
  403s `/crm/campaigns` + `/admin/sms/campaigns` — "cold calling is over");
  the hook fails OPEN on a DB error so a hiccup never kills classic tenants'
  campaigns, while `requireSupermarketMode` on the supermarket surface fails
  CLOSED. The asymmetry is deliberate.
- ⛔ **Specials never ride the platform mailbox**: the lane needs
  `MARKETING_MAIL_ENABLED=1` (today OFF — a send refuses loudly and queues
  NOTHING), type `MARKETING_SPECIAL` never `ADMIN_ALERT`, HMAC unsubscribe on
  every email, caps 2000 recipients / 3 blasts/day, atomic send claim.
- ✅ **The 25 heavy stress tests exist and ALL PASS** (63 api tests + 8 portal
  guards; api typecheck at its 76 baseline, portal 0). ⛔ **They caught two
  real defects pre-ship**: the draft sweep STALLED forever past 50 sources
  (per-row dedupe without a query-level `notIn` — a busy store's tail was
  never reached) and the matcher emitted DUPLICATE line items when one product
  matched by name and code. Both fixed. The test kit
  (`supermarketTestKit.ts`) is the faithful-fake infrastructure — snapshot
  reads, P2002, relation-filter `where` support — reuse it, don't fork it.
- ⛔ **The order twin (`SupermarketOrderPop`) is a PASSIVE observer** of
  `useOptionalSipPhone` — a guard greps it for any call-path touch. Answered
  inbound call on a supermarket tenant → mini dialer pops `/orders/twin`, full
  window routes `/orders/new`; localStorage `"sm-order-pop"` is the
  cross-window bus. It probes `/supermarket/mode` ONCE (that rule is
  `permission: null` — authenticated-only — on purpose, or the pop could
  never learn the mode).
- ⛔ **Shared-worktree note:** the commit was a private-index build with a
  **pinned base in BOTH `read-tree` and `-p`** plus a compare-and-swap
  `update-ref`, surgically EXCLUDING the sibling voice-agent session's
  uncommitted server.ts hunks (their import of an untracked dir); their
  schema models + bypass entries + nav row were carried by agreement. The
  shared index was repaired afterwards (the staged-deletion trap).
- ⏳ **NOT PROVEN: no human has opened any screen, no tenant is in supermarket
  mode, no real POS call, no live pay call, no twin on a real answered call.**
  Acceptance starts with the key: paste it, Test green, flip Gesheft to
  supermarket, watch `SUPERMARKET_SWEEPS_ARMED` + the first catalog sync.
