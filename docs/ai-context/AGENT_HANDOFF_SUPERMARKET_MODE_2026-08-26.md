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
- Deploy state at the time of writing: committed + pushed; api/portal deploy
  is the next step in-session — check the containers, not this doc.
