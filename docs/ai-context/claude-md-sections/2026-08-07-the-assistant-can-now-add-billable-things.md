# ⛔⛔ AGENT HANDOFF — the assistant can now ADD BILLABLE THINGS (2026-08-07) — READ FIRST before adding ANY "charge them for it" step, before adding an `/internal/agent/*` door, or for anything touching what a customer is billed when something is provisioned

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_AGENT_PROVISIONING_2026-08-07.md`**
(`4badbf06` → `e338d0ab` on `feat/ivr-migration-takeover`; api + portal + agent
**DEPLOYED and container-verified**. ⏳ Never walked in a browser.)

- ⛔ **THE RULE: next month's invoice does NOT store quantities — it recounts
  them live every cycle** (`resolveBillingQuantities` → `calculateTenantBillingUsage`
  reads Extension rows, PhoneNumber rows and the SMS flag when the invoice is
  built). **So creating the extension IS the billing update**, and a second "add
  it to the invoice" step would charge the customer TWICE. What was missing is
  *proof the money moved*: `billingReconcile.ts` snapshots the monthly total
  before, provisions, snapshots after, and refuses to report success if it
  didn't rise.
- ⛔ **Three ways a real thing is silently FREE, all previously live:** a tenant
  pinned to a **manual** quantity override (usage moves, invoice never does —
  now bumped); an extension number that isn't **exactly three digits** (usage
  counts `/^\d{3}$/`, so a 2- or 4-digit line works on the phone and bills
  nothing); and a number that never reaches the **`phoneNumber` table** — see
  the open item below.
- ⛔ **OPEN — the additional-number fee is not charged on 11 of 29 live
  tenants.** Their DIDs live only in `PbxTenantInboundDid`, which the plan's
  per-number line doesn't count, so the engine thinks they have NO numbers.
  inii mini (two numbers) was being quoted "$0.00, first number included".
  Adding a number is now REFUSED when real DIDs exceed billed numbers, and the
  quote reflects reality — but ⛔ **the underlying count is deliberately NOT
  fixed**: backfilling would start billing 11 customers for numbers they've had
  for months. That's Izzy's call.
- ⛔ **Prices come from `resolveTenantBillingPricing`, never `ONBOARDING_PRICES`.**
  Those constants are what a NEW customer is quoted; an existing account may be
  on a plan or a negotiated rate. The agent has no price constants of its own —
  it reads them over `/internal/agent/account-setup-info`.
- ⛔ **Every new `/internal/agent/*` door MUST be added to
  `shouldSkipJwtVerification` — this has shipped broken TWICE.** The JWT hook
  runs before routing, so a missing entry answers **401** and the door's own
  secret check never runs; the agent then reports a vague "I couldn't retrieve
  that" forever with nothing wrong in the logs. **403 = the handler ran; 401 =
  you never reached it.** Guarded by `internalDoorBypass.test.ts`, which reads
  the route module's SOURCE (a unit test of the handler passes straight through
  this bug).
- **The gates live once**, in `apps/api/src/agentConfirmations.ts` (password,
  single-use atomic claim, params hash, tenant scoping, rate limit, audit);
  capabilities plug in. ⛔ `transactional: true` = pure DB, a failure rolls the
  approval back; `false` = PBX/carrier/email, the approval **stays spent**
  because re-running half a purchase is worse than not finishing it — and such a
  capability's own refusal message MUST survive ("the extension exists but the
  welcome email didn't go" is the whole value).
- ⛔ **Provisioning REPLAYS the real portal routes** (`POST /pbx/extensions` →
  `POST /admin/users`) signed as the confirming admin, never reimplements them.
  `/pbx/extensions` stamps `ownerUserId` with its creator and `/admin/users`
  then refuses that extension — hand it back in between.
- **Texting**: `smsBillingEnabled` is the whole billing switch; ⛔ **`smsSendMode`
  stays TEST** (an earlier version flipped it to LIVE, which would have broken
  campaign sends without helping texting). Most `TenantSmsNumber` rows are
  unclaimed — claim only a `tenantId: null` one.
- **Buying a number**: spare stock first, the PBX inbound route is part of the
  same operation (a number that doesn't ring is worse than none), toll-free
  rejected at parse time, and it refuses outright for tenants with no VoIP.ms
  subaccount rather than half-provisioning.
- ⏳ **Acceptance test in §8 of the handoff** — ask for an extension in chat,
  confirm with a password, check the welcome email lands and the invoice preview
  moves by exactly the quoted amount. Also open: 7 red tests in
  `pbxTenantDirectorySync` that are NOT from this work.
