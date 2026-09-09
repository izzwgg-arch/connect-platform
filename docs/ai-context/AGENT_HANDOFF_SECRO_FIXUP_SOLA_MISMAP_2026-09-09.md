# AGENT HANDOFF — Secro Selutions was never invoiced or charged on 2026-09-06 (nor on 2026-08-06): a Sola recurring schedule belonging to FIXUP GROUP was mapped onto Secro's tenant in May and silently blocked autopay (2026-09-09)

Izzy, 2026-09-09: *"again, for Secro solution, no invoice was created, and her charge was not
charged on the date that she was supposed to pay, which is usually on the 6th. Last month, we went
through this, and you told me that it was fixed."* Then: *"the Fixup USA is Fixup Group. If there's
a card on file, move it to Fixup Group and set up their invoice for $45. They already paid today
through Sola … They used to be together"* and *"make sure it matches the same card when you move
over, and don't move the wrong card."*

Related: `AGENT_HANDOFF_BILLING_REBUILD_2026-08-07.md` (the "last month" fixes — none of them
touched this cause), `BILLING.md` § Sola Vault Schedule Linking.
Memory: [[autopay-blocked-by-a-mis-mapped-sola-link]].

## 1. The cause, proven from the rows

| Fact | Where it was read |
|---|---|
| Secro (`cmnlgrynn0016p9pakbscpvfs`) billing day **6**, autopay **on**, default card Visa ····0744 | `TenantBillingSettings` |
| Paid **Jun 6, Jul 8, Aug 6** at $55; **nothing in September** | `PaymentTransaction` |
| Worker logged `autopay_invoice_generation_started` hourly from Sep 3 (T-3) and **created nothing** | `BillingEventLog` |
| From Sep 6 04:00Z (the charge instant) the worker logged `billing.autopay_skipped_active_sola_schedule` **every hour**, link `cmpa3bzm2007wp313z2hlq26y`, Sola schedule `c112281437_s11678830` | `BillingEventLog` — **79 rows in 40 days**, the same block fired hourly on **Aug 6** too |
| That link is Sola customer **`c112281437` "fix up usa"**, $45/month, `MAPPED` to Secro on **2026-05-28 02:38** (`matchReason: "No confident tenant match"` — i.e. mapped by hand), `TOKEN_LINKED`, never cut over, `isActive` | `BillingSolaExternalScheduleLink` |
| Its token-link created **PaymentMethod ····6300 ON SECRO'S TENANT** (2026-05-28 03:07). A second foreign card, **····1032 (Fleetease)**, landed on Secro the same second | `PaymentMethod` (`isImported`, metadata `solaCustomerId`) |
| Secro's OWN Sola schedule (`c112607330_s11772292`, $55) is `CUTOVER_COMPLETE`, disabled at Sola 2026-06-03, `nextConnectChargeAt 2026-07-06` — correct and harmless | same table; Sola live `IsActive:false` |
| **Sola live:** `c112281437_s11678830` is **still active at Sola, ran 2026-09-09 01:03:48 for $45, next 2026-10-09** — so Fixup Group paid today via Sola | read-only `getSchedule` probe from `app-api-1` |
| The schedule's card at Sola = pm `c112281437_pm112248642` = **Visa ····6300 exp 08/29**; Connect's PaymentMethod `cmpowx5kw00g5nv12ky67up9r` = Visa ····6300 exp 08/29 with `processorPaymentMethodId c112281437_pm112248642` | `getPaymentMethodMasked` + `PaymentMethod` row — **the card match Izzy asked for is proven** |

**Mechanism.** `apps/worker/src/main.ts` `checkActiveSolaScheduleBlock(tenantId)` returns any link on
the tenant that is `MAPPED` + `isActive` + not `CUTOVER_COMPLETE`. It is consulted in BOTH phases:
the T-3 reminder phase (`runAutopayReminderPhase`) — which **skipped with no event at all** — and
the due-date charge phase — which wrote an hourly event nobody reads. The guard itself is correct (an
un-cutover Sola schedule on the SAME company means a double charge); the defect is that it fired for a
schedule that was never Secro's, and that nothing told a person.

⛔ **Why "it was fixed last month" was wrong.** The 2026-08-07 billing rebuild fixed day-1 invoicing,
the always-true `due` flag, the NULL-dropping Prisma filter and the erased billing emails. None of
those was Secro's problem. Secro's **August 6 charge was done by hand at 16:24Z** on Aug 6 (invoice +
charge outside any worker tick) while the block kept firing hourly on either side of it; **the block
itself was never looked at**, so September failed identically. The July charge landed on Jul 8, two
days late, for the same reason.

## 2. What is DONE (2026-09-09)

- ✅ **Worker fix, committed `5dd55bf2`, pushed, deploy queued (job `f8203260`)** —
  `apps/worker/src/autopayBlockAlarm.ts`: when the active-Sola block fires in EITHER phase the worker
  now raises an **`AgentEscalation`** (SMS to Izzy's two numbers + the escalation email — the only
  channel that reaches a person; ⛔ never `ADMIN_ALERT`, muted at the send door), de-duped **per
  tenant + link per 24 h**, and the reminder-phase skip logs
  `billing.autopay_reminder_skipped_active_sola_schedule`. The text names the tenant, the payment
  date, the link, the Sola label, and says outright when the Sola label is not this tenant's name
  (typo-tolerant: "Secro solutions" ≈ "Secro Selutions"). 6 tests; the source guard **fails replayed
  against HEAD**.
- ✅ **Backup** of every row the split touches: `loopcom:/root/secro-fixup-split-backup-20260909.json`
  (600): the three links, Secro's three cards, both tenants' billing settings.
- ✅ **The split script is written, staged and DRY-RUN CLEAN inside `app-api-1`** at
  `/app/apps/api/split.ts` (copy at `loopcom:/root/split.ts`). Every precondition passed. ⛔ **It has
  NOT been run live** — the session's action classifier refused the live invocation twice (it carries
  a card charge and a carrier-side write). See §4 for the one command.

## 3. What the script does live, in order (each step guarded, stops at the first failure)

| Step | Action | Route/engine used |
|---|---|---|
| F1 | Move PaymentMethod ····6300 from Secro to **Fixup Group** (`cmqr9cs9402qqs013m7p64lpi`), make it default there; set Fixup's `defaultPaymentMethodId` | direct row update, guarded on current tenant + last4 + Sola pm id |
| F2 | Re-map link `cmpa3bzm2…` to Fixup Group | `mapSolaExternalSchedule` (writes `billing.sola_external_schedule_mapped`) |
| F3 | **Take over billing**: disables the Sola schedule at Sola, enables Connect autopay on Fixup, sets `nextConnectChargeAt` = start of the NEXT cycle (**2026-10-09**) + `billingScheduleOverride.nextPaymentDate` | `takeOverBillingFromSola` — the sanctioned Phase D flow |
| F4 | Create Fixup's invoice **Sep 9 → Oct 9**, due Sep 9, **$45** (their existing settings already total exactly $45: $30 ext + $10 texting + $3 E911 + $2 regulatory — **no price change was needed**); refuses if the total is not 4500 | `createBillingInvoice` with explicit period + dueDate, `skipInvoiceEmail` |
| F5 | Post an **external payment** $45 on it, `CARD_EXTERNAL`, reference "Sola recurring c112281437_s11678830 run 2026-09-09", no receipt email → invoice PAID | `postExternalPayment` |
| S1 | Assert Secro is no longer blocked (query returns nothing) | — |
| S2 | Deactivate Fleetease's card ····1032 on Secro (`active:false`, reason in metadata) | direct row update (guarded `isDefault:false`) |
| S3 | Create Secro's invoice **Sep 6 → Oct 6**, due **Sep 6**, **$55**; refuses if not 5500 | `createBillingInvoice` |
| S4 | **Charge Secro's Visa ····0744** for $55 (note recorded on the event log) | `chargeBillingInvoice` — the same engine the admin Pay button uses; a receipt email goes to `Office@secrosolutions.com` as in August |

⛔ Fixup's Sola schedule is disabled by F3 — **Connect charges Fixup on Oct 9 from ····6300**
(worker T-3 invoice Oct 6). Reversal of F3: Sola `updateSchedule(isActive:true)` + set
`autoBillingEnabled false`. Reversal of the rest: the backup file (card rows and link rows).

## 4. The one command (Izzy — Run button)

```bash
ssh connect 'docker cp /root/split.ts app-api-1:/app/apps/api/split.ts && docker exec -w /app/apps/api app-api-1 npx tsx split.ts --live 2>&1 | tail -20; docker exec app-api-1 rm -f /app/apps/api/split.ts'
```

Expected tail: `F1 … F5`, `S1 secro autopay block cleared`, `S2`, `S3 secro invoice … total 5500`,
`S4 secro charge {"status":"APPROVED"…}`, `S4 secro invoice after {"status":"PAID","balanceDueCents":0…}`.
Any `STOP:` line means nothing after it ran; re-run is safe (preconditions re-check, so a half-run
refuses rather than double-writing).

Afterwards, verify: `select "invoiceNumber",status,"totalCents","periodStart","paidAt" from
"BillingInvoice" where "tenantId" in ('cmnlgrynn0016p9pakbscpvfs','cmqr9cs9402qqs013m7p64lpi')
order by "createdAt" desc limit 3;` and the Sola probe reads `IsActive:false` on
`c112281437_s11678830`.

## 5. The same fault on TWO OTHER tenants — not touched, needs Izzy

The blocking query (`MAPPED` + `isActive` + not `CUTOVER_COMPLETE`) returns exactly three links:

| Tenant | Link | Sola label | $/mo | Effect today |
|---|---|---|---|---|
| Secro Selutions | `cmpa3bzm2…` | **fix up usa** | 45 | this incident — cleared by §4 |
| **Displaydex** (day 28, autopay ON) | `cmpa3c0wx0080p313be3ku2q5` | **Nexus Realty** (Amex ····1005, also imported onto Displaydex) | 65 | **Displaydex has had ONE invoice ever (May 28, $30). Jun 28, Jul 28, Aug 28 were all blocked** — 38 skip events on Aug 28 alone. Displaydex's own schedule is `CUTOVER_COMPLETE`, so Sola is NOT charging them either: **$90 uncollected so far, and Sep 28 will be lost too.** |
| Connect Communications (admin tenant, autopay off) | `cmpa3bz6a007vp313csqvfbsm` | coat one seal coating | 35 | inert (autopay off) but wrong |

Nexus Realty is (per the outbound-CID handoff) Eli's other business — whether it should be its own
tenant, or Displaydex's second obligation to be cut over, is Izzy's call. Either way Displaydex's
three missed cycles need creating + collecting by hand, exactly as §3 S3/S4 does for Secro.

## 6. Rules this earned

- ⛔ **`billing.autopay_skipped_active_sola_schedule` in a tenant's event log = that tenant is NOT
  being invoiced or charged, every cycle, until the link is unmapped or cut over.** Grep for it
  before believing any autopay fix. The reminder phase logs
  `billing.autopay_reminder_skipped_active_sola_schedule` from `5dd55bf2` on; before that it was silent.
- ⛔ **A Sola link's `companyName` must match the tenant it is mapped to** — the sync suggests by name
  and `"No confident tenant match"` means a person chose. Token-linking a mis-mapped link **imports
  another company's card onto this tenant** (Secro carried Fixup's AND Fleetease's cards for three
  months). Check `PaymentMethod.metadata.solaCustomerId` against the tenant's own Sola customer.
- ⛔ **The take-over sets `nextConnectChargeAt` from the tenant's `billingDayOfMonth`** — Fixup is day 9
  because Sola ran on the 9th; keep them aligned or the first Connect cycle double-covers or gaps.
- ⛔ The split script runs INSIDE `app-api-1` and calls the engine functions directly (same functions
  the admin routes call) — a self-signed token was not needed and the script is re-runnable.
