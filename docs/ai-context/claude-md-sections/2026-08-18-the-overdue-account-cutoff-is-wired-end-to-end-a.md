# ⛔⛔ AGENT HANDOFF — the overdue-account cutoff is WIRED END TO END and ARMED (2026-08-18); 911 nearly got switched off building it — READ FIRST before touching the cutoff, `SERVICE_INTERRUPTION_CUTOVER_AT`, the doorway, or before deactivating ANY outbound route

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_EMERGENCY_CALLING_SERVICE_INTERRUPTION_2026-08-17.md`**
(`c7c1df00` → `2c8cc04e`. **PBX writes under an explicit mandate: one panel
permission, emergency config on two tenants, helper `2026.08.18.1` installed.
✅ api DEPLOYED and container-verified (`2c8cc04e`, job `7771b6cf`); portal
DEPLOYED and bundle-verified (job `743cbf00`). First real sweep ran 5 min after
boot: `considered: 0` — the correct answer with every switch off.** 125 tests
after `97cad9f7`, see the 2026-08-19 bullet.)

- ⛔⛔ **2026-08-19 — IT HAD NEVER ACTUALLY RUN FOR ANYONE.** The sweep's invoice
  query said `status: { in: ["FAILED","OVERDUE","UNPAID"] }` and
  `BillingInvoiceStatus` is `DRAFT|OPEN|PAID|FAILED|OVERDUE|VOID` — no `UNPAID`
  — so Prisma rejected the WHOLE query, the tenant landed in `errors[]`
  (`[SERVICE_INTERRUPTION] tenant failed … Invalid value for argument 'in'`),
  and the only switched-on tenant (TYH Industries, the first sign-up after
  arming) was skipped on every run. `considered: 1` looked healthy; the
  `errors` array was the tell. **Fixed `97cad9f7`**:
  `UNPAID_FAILURE_STATUSES = ["FAILED","OVERDUE"]` — ⛔ `OPEN` is NOT in it on
  purpose (an OPEN invoice is issued but not yet collected; invoices are created
  ahead of the payment date, so counting OPEN would start the countdown before
  the card was charged — the rule is "when a payment FAILS"). ⛔ **The 102 tests
  passed because the fake db ignored `where.status`** — it now validates every
  `in` member against the enum parsed from `schema.prisma` and throws Prisma's
  message (9/13 fail on the old list; 125/125 now). Also closed:
  `mergeDunningAfterFailure` never wrote the `dunning.firstFailedAt` the sweep
  reads for the 7-day grace, so it always fell back to `createdAt` — it stamps
  it once now. ✅ api DEPLOYED and container-verified `97cad9f7` (`deploy-direct.sh api`, 295 s, `.build-commit` = `97cad9f7`, `grep -n 'UNPAID_FAILURE_STATUSES = ' …serviceInterruptionJob.ts` → line 68 `["FAILED", "OVERDUE"]`, `firstFailedAt,` at `billingDunning.ts:109`). Boot log `sweep scheduled {armed:true, cutoverAt:2026-08-18T12:01:07Z}`; five minutes later `sweep complete {considered:1, remindersSent:0, interrupted:0, restored:0, skippedPreCutover:0, errors:[]}` — **no `tenant failed` line**. The `considered:1` is TYH Industries, whose only invoice is PAID, so no countdown — the correct answer. On the previous build (`1c1d067e`, same day) the same tenant had produced `errors:[{…Invalid value for argument 'in'. Expected BillingInvoiceStatus.}]`. ⛔ **When you read `sweep complete`, read
  `errors` — `considered` alone hides a tenant that blew up.** Handoff §11.
- ⛔⛔ **IT IS ARMED.** `SERVICE_INTERRUPTION_CUTOVER_AT=2026-08-18T12:01:07Z` is
  in `.env.platform`. A daily sweep (first run 5 min after api boot) sends the
  reminders, cuts off on day 7 (disables every ARS member across every profile,
  regens the **MAIN** tenant, re-bakes doorways, sets the inbound busy flag) and
  restores on payment. **Any failure older than the cutover is NEVER acted on**
  — Izzy: existing past-due accounts are handled by hand. **The per-tenant
  switch is OFF for every existing tenant and ON for every new sign-up.** So on
  the day of deploy the sweep should consider **0** tenants; ⛔ if it does more,
  stop and read `docker logs app-api-1 | grep SERVICE_INTERRUPTION`.
- ⛔ **Disarm = blank the variable + restart api. Disarm one customer = the
  switch** (`PUT /admin/billing/tenants/:id/service-interruption {enabled:false}`
  or the card on `/admin/billing/customer/[tenantId]`). Restore and force are
  `POST …/restore` and `POST …/interrupt {reason}` — SUPER_ADMIN only.
- ⛔⛔ **THE CUTOFF REGEN MUST RUN IN THE MAIN TENANT.** `ARS-<id>` renders into
  `extensions__50-1-dialplan.conf`; regenerating the customer's own tenant left
  Loopcom Demo dialling out while the DB said "disabled". `applyArsRegen()` is
  the only sanctioned way. Proven 12/12 in Asterisk (§8 of the handoff).
- ⛔⛔ **`members[N][enabled]` IS A CHECKBOX — OMIT to disable; `enabled=0`
  ENABLES it.** Same trap as `teamBuilder.ts:228`. Two tests fail loudly on it.
- ✅ **Inbound busy is in the doorway** (`Busy(10)` when
  `connect/t_<slug>/interrupted=yes`; AstDB read at call time, no regen). ⛔ **Only
  numbers ON the doorway** — Connect-mode T2/T35/T105. Loopcom Demo / Landau Home
  keep ringing during a cutoff; logged per tenant as a warning. Open gap.
- ⛔ **`server.ts` was committed with a PRIVATE INDEX** (3 lines, mode 100644)
  because another session had a mode flip staged. Recipe in the handoff §10.

- ⛔⛔ **"DEACTIVATE ALL THEIR OUTBOUND ROUTES" AND "911 ALWAYS WORKS" CANCEL
  EACH OTHER OUT.** 911 leaves the building through an outbound route. Taken
  literally, the overdue cutoff disconnects emergency calling for a customer
  who is late paying a phone bill. **Resolved with VitalPBX's native emergency
  feature, which bypasses route selection entirely** — proven from the live
  dialplan (`T8_cos-all-init`): the `T8_emergency-calls` GotoIf runs **before**
  `OUTBOUND_PROFILE` is read, so it survives every route being off *and* the
  extension's profile being `disabled`. ⛔ **A custom `connect-emergency-only`
  route was built earlier in that session and is SUPERSEDED — do not resurrect
  it**; `serviceInterruptionPlan.ts` still carries that shape and needs
  simplifying.
- ⛔ **The automation account was DENIED both emergency modules and every field
  read said "You don't have access".** `lOOPCOMAGENT7548` (role 9) now has
  view/add/edit on **119 `emergency_numbers`** and **138 `emergency_locations`**;
  rollback is in `/root/grant-emergency-20260817.sql` on the PBX. Role 9 still
  has 134 privilege rows; roles 1/4/5/6 already had access and were untouched.
- ✅ **LIVE for Matamim (T104) and inii mini (T105) only** — 911 + 8457831212,
  each on their own trunk (129 / 130), each presenting their own number
  (9293598299 / 6469846023), each with a real street address, notifying
  **izzywgg@gmail.com + the customer**. ⛔ That address was **read from the
  database** — the session context said `izzywkg@gmail.com`, one letter out.
- ✅ **RENDERED AND LIVE on both, confirmed in Asterisk** (`dialplan show
  T104_emergency-calls`): each number ends in **`Gosub(trk-129/130,...)`** —
  straight to the trunk, no outbound route, no ARS. That is the proof the
  cutoff can switch every outbound route off without touching 911.
  ⛔ **`setTenant(path)` BEFORE `applyChanges`** — fired in the robot's home
  tenant it returns `success` in 0.7 s and regenerates **nothing**.
  ✅ **The doorway wipe is REAL and was caught live**: applying in inii mini's
  context logged *"Apply Changes had wiped this number's doorway routing —
  re-baked"* for +6469846023, repaired inside the same 2.4 s by
  `rebakeConnectRoutesAfterRegen`. ⛔ **That only covers numbers Connect
  tracks** — inii mini's second doorway route (the retired temp 8452605692) was
  left wiped and healed by the drift reconciler ~40 s later, so **a doorway
  count taken seconds after an apply can read mid-repair and look like an
  outage that is already healing.** Back to baseline after: T2 1/0, T35 1/0,
  T105 2/0 doorway/dead-air.
- ⏳ **NOT PROVEN: nobody has dialled 911 on either tenant** and no notification
  email has arrived. ⛔ Test with **8457831212**, not 911 — do not tie up a
  dispatcher.
- ⛔⛔ **`ombu_tenant_settings(name='outbound_profiles').value` → `ombu_ars.ars_id`
  — NOT `ombu_ars.tenant_id`.** Every real ARS row and every outbound route
  lives under `tenant_id 1`. Joining on tenant_id concluded 26 of 28 customers
  had no outbound routes at all. **If a query says most of the fleet is broken,
  the query is broken.**
- ⛔ **Several customers run MULTIPLE businesses off one account**, each its own
  outbound profile with its own caller ID: **Trust Bookkeepings 9**,
  A plus center 4, Displaydex 3, Secro 2. Anything "per customer" must be **per
  profile** or it misses most of their extensions. And ⛔ **four customers' first
  profile carries another company's caller ID** (Displaydex→Nexus Realty,
  Trust→Avenue Filing, RSBK→Rebbe, Landau Home→a number taken off them), so
  inheriting a caller ID by position sends dispatch to the wrong address.
- **Facts:** `states.id` 3956 = New York, `country_id` 231 = US;
  `ombu_ars_members.sort` is the ordering column; the api's MySQL user is
  **`connect_read`** so PBX writes must run on the PBX from a file.
- ✅ **The customer emails are APPROVED** (Izzy, 2026-08-17): banner with days
  left, one sentence, the amount, the button — ⛔ **do not pad them back out**.
  Live in `emailTemplates.ts`; the nine existing billing emails are byte-identical.
- ⏳ **Still unbuilt: the per-tenant switch, the daily sweep, reconnect-on-payment,
  and onboarding wiring.** Only the pure policy and plan exist.
