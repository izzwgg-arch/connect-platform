# ⛔⛔ AGENT HANDOFF — Secro Selutions was NOT invoiced or charged on 09-06 (nor on 08-06): a Sola recurring schedule belonging to FIXUP GROUP was mapped onto Secro's tenant in May and silently blocked autopay; the split is STAGED and awaits Izzy's Run button (2026-09-09) — READ FIRST for ANY "no invoice / not charged on their date", before believing a billing fix, before mapping or token-linking a Sola schedule, or before reading `billing.autopay_skipped_active_sola_schedule` as noise

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_SECRO_FIXUP_SOLA_MISMAP_2026-09-09.md`**
(worker fix `5dd55bf2` committed + pushed, deploy queue job `f8203260`; backup
`loopcom:/root/secro-fixup-split-backup-20260909.json`; split script staged at
`loopcom:/root/split.ts`, dry-run clean, ⛔ NOT run live — the session classifier refused
the card charge + carrier write twice; the one-line Run command is §4 of the handoff.)
Memory: [[autopay-blocked-by-a-mis-mapped-sola-link]].
Izzy: *"no invoice was created, and her charge was not charged … Last month, we went through
this, and you told me that it was fixed"* — then *"the Fixup USA is Fixup Group. If there's a
card on file, move it to Fixup Group and set up their invoice for $45 … They already paid today
through Sola … make sure it matches the same card when you move over."*

- ⛔⛔ **THE CAUSE: `BillingSolaExternalScheduleLink cmpa3bzm2007wp313z2hlq26y` — Sola customer
  `c112281437` "fix up usa", $45/mo — was MAPPED to Secro on 2026-05-28 (`"No confident tenant
  match"` = mapped by hand), TOKEN_LINKED, never cut over.** `checkActiveSolaScheduleBlock`
  (worker) then refused Secro's invoice in the T-3 phase **silently (no event)** and the charge
  on the 6th with an hourly `billing.autopay_skipped_active_sola_schedule` row nobody reads —
  79 rows in 40 days. Both the Aug 6 and Sep 6 cycles died on it; **the Aug 6 charge was done
  BY HAND at 16:24Z and the block was never looked at**, which is why "fixed last month" failed
  identically. Secro's OWN Sola schedule is `CUTOVER_COMPLETE` and disabled at Sola — no
  double-charge risk on Secro's card.
- ⛔⛔ **Token-linking a mis-mapped schedule imports ANOTHER COMPANY'S CARD onto the tenant.**
  Secro has carried Fixup's Visa ····6300 AND Fleetease's ····1032 as active payment methods since
  05-28. **Proven the right card before moving it:** Sola's schedule uses pm
  `c112281437_pm112248642` = Visa ····6300 exp 08/29; Connect's `cmpowx5kw00g1nv12ky67up9r` is
  Visa ····6300 exp 08/29 with that exact `processorPaymentMethodId`.
- ✅ **Sola live (read-only probe): the Fixup schedule ran 2026-09-09 01:03 for $45, approved,
  next 10-09** — Fixup Group paid this cycle through Sola. Fixup's existing Connect settings
  (day 9, $30 ext + $10 texting + $3 E911 + $2 regulatory) **already total exactly $45 — no price
  change**.
- ✅✅ **SECRO IS CHARGED (2026-09-09 14:35Z, Izzy: "first charge Secro"):** invoice
  **CC-202609-00005**, Sep 6→Oct 6, $55, due Sep 6, Visa ····0744 **APPROVED** (ref 11042822291),
  PAID, `BILLING_INVOICE_SENT` + `BILLING_RECEIPT` both **SENT** to Office@secrosolutions.com.
  ⛔ **The mis-mapped link is STILL on Secro** — the October cycle (T-3 = Oct 3) will block again
  until the Fixup split below runs.
- ✅ **Worker alarm DEPLOYED + container-verified 14:34Z** (`app-worker-1` at branch tip `90e05d84`
  ⊇ `5dd55bf2`, `raiseAutopayBlockAlarm` ×3 in the running src, 0 restarts, 0 error lines).
  ⛔ The deploy queue skipped it as `unrelated_paths` — a false skip (`apps/worker/src/main.ts`
  changed); ran `DEPLOY_FORCE_RESTART=1 bash scripts/deploy-worker.sh` detached with a log.
- ⏳ **STAGED, NOT RUN — the Fixup half (§3/§4 of the handoff), one script, guarded, re-runnable:** move ····6300 to Fixup
  Group + default → re-map the link to Fixup → `takeOverBillingFromSola` (disables the Sola
  schedule, Connect autopay from **Oct 9**) → Fixup invoice Sep 9→Oct 9 $45 + external payment
  "paid via Sola" → Secro block cleared → deactivate Fleetease's ····1032 on Secro → Secro invoice
  (the Secro half is DONE above; the script's Secro steps now refuse on the existing September invoice — run only the Fixup steps).
- ✅ **THE ALARM (`5dd55bf2`, `apps/worker/src/autopayBlockAlarm.ts`): an active-Sola block in
  EITHER phase now raises an AgentEscalation (texts Izzy), de-duped per tenant+link per 24 h, and
  the reminder skip logs `billing.autopay_reminder_skipped_active_sola_schedule`.** ⛔ Never
  ADMIN_ALERT. Source guard fails against HEAD. ⏳ Deploy job `f8203260` — verify with
  `docker exec app-worker-1 grep -c raiseAutopayBlockAlarm /app/apps/worker/src/main.ts` (expect 2+).
- ⛔⛔ **TWO MORE TENANTS ARE BLOCKED THE SAME WAY, untouched, Izzy's call (handoff §5):
  Displaydex** (autopay ON, day 28) is blocked by a "Nexus Realty" $65 link — **one invoice ever
  (May 28); Jun/Jul/Aug 28 all lost, ~$90 uncollected, Sep 28 next**; and the admin tenant
  Connect Communications carries a "coat one seal coating" link (inert, autopay off).
- ⛔ **Rule: `billing.autopay_skipped_active_sola_schedule` in a tenant's event log means that
  tenant is NOT being billed at all until the link is unmapped or cut over.** Grep for it before
  believing any autopay fix; check `PaymentMethod.metadata.solaCustomerId` matches the tenant.
