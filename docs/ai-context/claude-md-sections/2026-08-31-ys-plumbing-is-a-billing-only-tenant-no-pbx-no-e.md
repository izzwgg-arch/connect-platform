# ⛔ AGENT HANDOFF — YS Plumbing is a BILLING-ONLY tenant: no PBX, no extension row, back-billed to May 20 (2026-08-31) — READ FIRST before creating a Connect-only customer, before linking ANY tenant to a shared `TaxProfile`, before billing a "virtual extension", or before running `/admin/billing/invoices/:id/send`

> Moved verbatim from `CLAUDE.md` on 2026-09-14 when CLAUDE.md was cut down to rules + index. Keep editing THIS file for this area; its one-line entry lives in CLAUDE.md's HANDOFF INDEX.


Full handoff: **`docs/ai-context/AGENT_HANDOFF_YS_PLUMBING_BILLING_ONLY_TENANT_2026-08-31.md`**
(**PRODUCTION DATA ONLY — no code, no deploy, no migration, no PBX write, and NO
EMAIL REACHED THE CUSTOMER.** Fully reversible.) Izzy, 2026-08-31: *"create a new
tenant called YS Plumbing only here in Loopcom, not in the PBX … $20 a month plus
tax for a virtual extension. They started May 20 … Generate invoices all the way
through."*

- ✅ **Tenant `cmthlm60d0000s90mxc1wmimh`** — 0 PBX links, 0 extensions, 0 phone
  numbers, 0 users, 0 PBX DIDs. $20/mo + **8.125% sales tax = $21.63**, billing
  day **20**, autopay **OFF** (no card). **Four OPEN invoices
  `CC-202608-00022…00025`** (May 20–Jun 19 … Aug 20–Sep 19), all **due today**
  per his instruction, **open balance $86.52**.
- ⛔⛔ **DO NOT LINK A SHARED `TaxProfile` TO A TENANT THAT USES
  `metadata.billingTelecomFees` — IT REWRITES OTHER CUSTOMERS' TAXES.**
  `PUT /admin/billing/tenants/:id/settings` ends by writing
  `taxProfilePatchFromTelecomFees(...)` **onto the linked profile row**, and
  `TaxProfile` rows are SHARED: `tax_profile_ny_orange` is linked by **Fixup
  Group AND RSBK**. Linking it here "for the nicer audit label" would, on the
  first settings save, have set `e911FeePerExtension: 0` and
  `regulatoryFeePercent: 0` on that shared row and **silently stopped charging
  E911 and regulatory recovery on two other paying customers.**
  ✅ `taxProfileId` stays **null** — the telecomFees metadata is authoritative for
  the math and the profile only ever supplies a jurisdiction label to the audit
  snapshot. It is the house pattern already (Trimpro, Yossis, McNamara Lion,
  Secro, Smooth Leasing, ADDB are all telecomFees + `taxProfileId: null`).
- ⛔ **A "virtual extension" is a BILLING QUANTITY, never an `Extension` row.**
  `billingQuantityOverrides.virtualExtensions = { mode: "manual", quantity: N }`
  priced from `metadata.billingVirtualExtensionPriceCents`; the line is built at
  `invoiceEngine.ts:285` as `metadata.lineItemKind: "virtual_extensions"`.
  **Trimpro is the live precedent** (2 at $5.00). A real Extension row would need
  a 3-digit `extNumber` to bill at all (`usage.ts`), would show in the Team
  directory as a phone line that does not exist, and would be one PBX sync away
  from being treated as a real endpoint.
- ⛔⛔ **`POST /admin/billing/invoices/:id/send` FALLS BACK TO THE OPERATOR'S OWN
  EMAIL** — `const to = invoice.tenant.billingSettings?.billingEmail || u.email`.
  Run it before `billingEmail` is set and **the customer's invoice is emailed to
  Izzy**, while the invoice is stamped `lastEmailStatus: QUEUED` as though it had
  gone out. **Set `billingEmail` first.**
- ✅ **Creating invoices with `billingEmail` still null is how they were made
  SILENTLY, and it is by construction, not luck:** `queueInvoiceSentOnFinalize`
  calls `resolveBillingEmailRecipient` **without** `allowUserFallback`, so a null
  billing email resolves to nothing and the send is skipped (`no_billing_email`).
  Verified: `EmailJob` rows for this tenant = **0**.
- ⛔ **The invoice HTTP route has no `dueDate` input** (`serviceStartDate` /
  `serviceEndDate` / `billingMonthCount` / `prorate` only) and defaults to
  `now + paymentTermsDays`. "Due today" was done by calling the exported
  `createBillingInvoice` directly in `app-api-1` with an explicit `dueDate` — the
  SAME engine function the route calls, with a parameter it already supports.
  **Never build a second invoice-creation path.** Due at **23:59:59 New York**,
  not local midnight, or the invoice is already past-due the instant it is written.
- ✅ **Priced BEFORE anything was created** with
  `buildBillingInvoicePreviewFromSettings` (in-memory settings snapshot — writes
  nothing): sales tax only $21.63 / + regulatory $21.83 / + E911 $24.83. Izzy
  chose sales tax only — **E911 is not charged because they have no phone number
  and no PBX line.**
- ⏳ **NOT DONE, needs Izzy: `billingEmail` IS NULL and nobody has been told they
  owe $86.52.** He said he would supply the address. Then send the **combined pay
  link** (proven live: `GET /admin/billing/invoices/<id>/payment-link` →
  `combined: { count: 4, totalCents: 8652 }`, one card entry settles all four)
  rather than four separate invoice emails. ⏳ Autopay stays off until a card
  exists — once both are set the worker creates the Sep 20 invoice itself at T-3,
  so do **not** also make that one by hand.
- ⚠️ **The PBX already has an outbound route named "YS Plumbing"** (one of the 21
  `trk-group` contexts recorded in the Hanna international-calling section). It
  was **not** touched and is **not** linked. ⛔ Linking a PBX tenant later would
  make `calculateTenantBillingUsage` count real extensions **on top of** the
  manual virtual-extension quantity.
