# AGENT HANDOFF — YS Plumbing: a BILLING-ONLY tenant, no PBX, back-billed to its start date (2026-08-31)

**Scope of the change: PRODUCTION DATA ONLY.** No code was written, nothing was
deployed, no migration ran, the PBX was never touched, and **no email reached the
customer**. Everything here is reversible.

Izzy, 2026-08-31: *"create a new tenant called YS Plumbing only here in Loopcom,
not in the PBX, and then we're charging them $20 a month plus tax for a virtual
extension. They started May 20, so they haven't paid since then. Generate
invoices all the way through."*

## 1. What exists now

| Thing | Value |
|---|---|
| Connect tenant | **`cmthlm60d0000s90mxc1wmimh`** — "YS Plumbing", `kind: CUSTOMER`, `isApproved: true` |
| PBX links / extensions / phone numbers / users / PBX DIDs | **0 / 0 / 0 / 0 / 0** |
| Billing settings row | `cmthlm6320002s90msa9bt80i` |
| Price | `extensionPriceCents: 2000` + `metadata.billingVirtualExtensionPriceCents: 2000` |
| Billed quantity | `metadata.billingQuantityOverrides.virtualExtensions = { mode: "manual", quantity: 1 }` |
| Tax | `taxEnabled: true`, **`taxProfileId: null`**, `metadata.billingTelecomFees.salesTax` = 8.125% on `invoice_subtotal` |
| Billing day | **20** (they started 2026-05-20) |
| Autopay | **OFF** (`autoBillingEnabled: false`) — there is no card on file |
| Billing email | **null** — waiting on the address from Izzy |
| Invoices | 4 x **OPEN**, `$21.63` each, **open balance `$86.52`** |

Invoices, all due **2026-08-31 23:59:59 America/New_York** (Izzy: "due today"):

| Invoice | Service period (NY) |
|---|---|
| `CC-202608-00022` | May 20 - Jun 19 |
| `CC-202608-00023` | Jun 20 - Jul 19 |
| `CC-202608-00024` | Jul 20 - Aug 19 |
| `CC-202608-00025` | Aug 20 - Sep 19 |

Each carries exactly two line items: **`Virtual extensions` qty 1 @ $20.00** and
**`Sales tax` $1.63**. `BillingEventLog` records four `invoice_created` rows
stamped `source: "operator_backfill"`.

## 2. THE LANDMINE THIS AVOIDED: do NOT link a shared TaxProfile

`PUT /admin/billing/tenants/:id/settings` ends with a block that, when the tenant
has a `taxProfileId`, writes `taxProfilePatchFromTelecomFees(...)` **onto that
TaxProfile row**.

`TaxProfile` rows are **SHARED ACROSS TENANTS** — `tax_profile_ny_orange` is
linked by **Fixup Group AND RSBK**. Had YS Plumbing been linked to it "for the
nicer audit label", the first save of its fee config would have written
`e911FeePerExtension: 0` and `regulatoryFeePercent: 0` onto that shared row and
**silently stopped charging E911 and regulatory recovery on two other paying
customers.**

**`taxProfileId` stays NULL on any tenant configured through
`metadata.billingTelecomFees`.** That metadata is authoritative for the math
(`invoiceEngine.computeFeesAtTaxableBase` takes the telecom-fees branch whenever
`parseBillingTelecomFees` returns non-null); the profile only ever contributes a
jurisdiction label to the audit snapshot. It is also the house pattern already —
Trimpro, Yossis, McNamara Lion, Secro, Smooth Leasing and ADDB all run
telecomFees with `taxProfileId: null`.

## 3. A "virtual extension" is a BILLING QUANTITY, not an Extension row

There is no `Extension` row and there must not be one. Billing quantity overrides
have carried a first-class **`virtualExtensions`** key since 2026-05-17
(`billingQuantityOverrides.ts`), described in the engine as "Manual quantity
only — not tracked in the system", and the invoice line is built at
`invoiceEngine.ts:285` with `metadata.lineItemKind: "virtual_extensions"` priced
from `metadata.billingVirtualExtensionPriceCents`.

**Trimpro is the live precedent** (2 virtual extensions at $5.00 each), so this
is an exercised path, not a new one.

Creating a real `Extension` row instead would have been wrong twice over: it
would need a 3-digit `extNumber` to bill at all (`usage.ts` filters the extension
number against a 3-digit pattern), it would appear in the Team directory as a
phone line that does not exist, and it would put the tenant one PBX-sync away
from being treated as a real endpoint.

## 4. Why nothing reached the customer, and how to send when Izzy says so

`createBillingInvoice` calls `queueInvoiceSentOnFinalize`, which calls
`resolveBillingEmailRecipient` **without** `allowUserFallback`. With
`billingEmail: null` and no invoice-level email that resolves to an empty string
and the email is skipped (`no_billing_email`) — so the four invoices were created
in silence **by construction**, not by luck. Verified afterwards: `EmailJob` rows
for this tenant = **0**.

**`POST /admin/billing/invoices/:id/send` FALLS BACK TO THE OPERATOR'S OWN
ADDRESS** (`const to = invoice.tenant.billingSettings?.billingEmail || u.email`).
Run it before setting `billingEmail` and **the invoice is emailed to Izzy, not to
the customer**, and the invoice is stamped `lastEmailStatus: QUEUED` as though it
had gone out. **Set `billingEmail` first.**

Preferred delivery once the address is set: **one combined pay link** rather than
four separate invoice emails. Proven live through the real route
(`GET /admin/billing/invoices/<id>/payment-link`): it returns
`combined: { count: 4, totalCents: 8652, url: .../pay/invoices/<token> }` — one
card entry settles all four, oldest first. The route also reports
`sms.capable: true` from **(845) 723-1213**, so it can be texted.

## 5. Why `dueDate` had to bypass the HTTP route

`POST /admin/billing/tenants/:tenantId/invoices` accepts only
`serviceStartDate` / `serviceEndDate` / `billingMonthCount` / `prorate`; it has
**no `dueDate` input** and `createBillingInvoice` therefore defaults to
`now + paymentTermsDays` (15 days). Izzy asked for **due today**, so the invoices
were created by calling the exported `createBillingInvoice` directly inside
`app-api-1` with an explicit `dueDate` — the same engine function the route
itself calls, with a parameter the engine already supports and the route simply
does not expose. This is not a second invoice-creation path; do not build one.

Due date is **23:59:59 New York**, not local midnight, so the invoice reads
"due Aug 31" and is not already past the instant it is written.

## 6. Verification performed

- Read-only preview of all three tax variants through
  `buildBillingInvoicePreviewFromSettings` (an in-memory settings snapshot — it
  writes nothing) **before** anything was created: sales tax only `$21.63`,
  plus regulatory `$21.83`, plus E911 `$24.83`. Izzy chose sales tax only.
- Period boundaries confirmed against `buildBillingSchedule` for
  `billingDayOfMonth: 20` — the 20th 00:00 NY through the next 20th 00:00 NY
  minus 1ms, which is exactly what the four invoices carry.
- After creation: 0 PBX links, 0 extensions, 0 numbers, 0 users, 0 EmailJobs,
  4 OPEN invoices, `$86.52` balance, `taxProfileId` still null.
- Combined pay link exercised through the real admin route (200).

## 7. NOT DONE — needs Izzy

1. **`billingEmail` is null.** He said he would supply the address. Until it is
   set, nothing can be emailed to the customer and `/send` would misfire to him.
2. **Nobody has been told they owe `$86.52`.** Send the combined link (email or
   SMS) once the address is in.
3. **Autopay is off and there is no card on file.** Turning `autoBillingEnabled`
   on without a default payment method gains nothing; add the card first. Once
   both are set the worker takes over on the 20th — `runAutopayReminderPhase`
   creates the Sep 20 - Oct 19 invoice at T-3 (Sept 17) automatically, so **do
   not also create that one by hand.**
4. **No user login exists for this tenant.** Deliberate — it is a billing-only
   record. If they should reach the customer billing portal they need a
   `TENANT_ADMIN` user invited.
5. **The PBX already carries an outbound route named "YS Plumbing"**
   (CLAUDE.md's list of 21 `trk-group` contexts without an `_011.` pattern). It
   was **not** touched and is **not** linked to this Connect tenant. Whether that
   route is this customer, and whether it should be, is Izzy's call — but note
   that linking a PBX tenant later would make `calculateTenantBillingUsage` start
   counting real extensions **on top of** the manual virtual-extension quantity.

## 8. Rollback

Nothing is paid, so the money guard is not engaged.

- Undo the invoices: `POST /admin/billing/invoices/:id/void` on each of the four
  (leaves an auditable VOID row), or delete them outright with
  `deleteBillingInvoice.ts` if the record should not exist at all.
- Undo the tenant: deleting `Tenant cmthlm60d0000s90mxc1wmimh` cascades the
  billing settings and invoices (`onDelete: Cascade`).
- The tenant is **never-linked** to the PBX, so `pbxOrphanTenantSweep` will never
  touch it (a tenant with no `TenantPbxLink` was never on the PBX, so "deleted on
  the PBX" cannot have happened to it).
