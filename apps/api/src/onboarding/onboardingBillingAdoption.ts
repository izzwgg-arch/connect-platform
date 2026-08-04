// ── Moving sign-up billing onto the tenant that actually went live ───────────
//
// Checkout creates the customer's tenant early (the invoice, the vaulted card,
// and autopay all need a tenant to hang off), and the PBX build is supposed to
// adopt that same tenant. When the two ever disagree — the historical bug, or
// the background auto-sync racing the orchestrator and provisioning its own
// tenant for the new PBX tenant — the customer ends up split: phone system on
// one tenant, card-on-file and autopay on another. Month 2 then silently never
// charges them.
//
// This module moves everything billing owns from the checkout tenant to the
// live tenant, in one place, so the orchestrator's race-repair and the
// backfill script cannot drift apart.

export type BillingAdoptionSummary = {
  invoicesMoved: number;
  lineItemsMoved: number;
  transactionsMoved: number;
  chargeOperationsMoved: number;
  eventLogsMoved: number;
  paymentMethodsMoved: number;
  autoBillingCarried: boolean;
  defaultPaymentMethodCarried: string | null;
  billingEmailCarried: string | null;
};

/**
 * Move every billing artifact from `fromTenantId` (the orphaned checkout
 * tenant) to `toTenantId` (the tenant the phone system landed on), and carry
 * the autopay settings across.
 *
 * The card token itself is gateway-level (the platform Cardknox account, not
 * per-tenant), so re-pointing the PaymentMethod row is the whole move.
 *
 * Idempotent: every step is an updateMany keyed on `fromTenantId`, so a re-run
 * finds nothing left to move.
 */
export async function adoptOnboardingBilling(
  dbc: any,
  fromTenantId: string,
  toTenantId: string,
): Promise<BillingAdoptionSummary> {
  if (!fromTenantId || !toTenantId || fromTenantId === toTenantId) {
    return {
      invoicesMoved: 0, lineItemsMoved: 0, transactionsMoved: 0,
      chargeOperationsMoved: 0, eventLogsMoved: 0, paymentMethodsMoved: 0,
      autoBillingCarried: false, defaultPaymentMethodCarried: null, billingEmailCarried: null,
    };
  }

  // Read the checkout tenant's settings BEFORE moving anything — they say
  // whether autopay was switched on and which card is the default.
  const fromSettings = await dbc.tenantBillingSettings.findUnique({ where: { tenantId: fromTenantId } }).catch(() => null);

  const paymentMethods = await dbc.paymentMethod.updateMany({ where: { tenantId: fromTenantId }, data: { tenantId: toTenantId } });
  const invoices = await dbc.billingInvoice.updateMany({ where: { tenantId: fromTenantId }, data: { tenantId: toTenantId } });
  const lineItems = await dbc.billingInvoiceLineItem.updateMany({ where: { tenantId: fromTenantId }, data: { tenantId: toTenantId } });
  const transactions = await dbc.paymentTransaction.updateMany({ where: { tenantId: fromTenantId }, data: { tenantId: toTenantId } });
  const chargeOps = await dbc.billingChargeOperation.updateMany({ where: { tenantId: fromTenantId }, data: { tenantId: toTenantId } });
  const eventLogs = await dbc.billingEventLog.updateMany({ where: { tenantId: fromTenantId }, data: { tenantId: toTenantId } });

  // Carry autopay + default card + billing email onto the live tenant without
  // clobbering anything an operator may already have set there.
  const toSettings = await dbc.tenantBillingSettings.findUnique({ where: { tenantId: toTenantId } }).catch(() => null);
  const carryAutoBilling = !!fromSettings?.autoBillingEnabled && !toSettings?.autoBillingEnabled;
  const carryDefaultPm =
    fromSettings?.defaultPaymentMethodId && !toSettings?.defaultPaymentMethodId
      ? String(fromSettings.defaultPaymentMethodId)
      : null;
  const carryBillingEmail =
    fromSettings?.billingEmail && !toSettings?.billingEmail ? String(fromSettings.billingEmail) : null;

  if (carryAutoBilling || carryDefaultPm || carryBillingEmail) {
    const patch = {
      ...(carryAutoBilling ? { autoBillingEnabled: true } : {}),
      ...(carryDefaultPm ? { defaultPaymentMethodId: carryDefaultPm } : {}),
      ...(carryBillingEmail ? { billingEmail: carryBillingEmail } : {}),
    };
    await dbc.tenantBillingSettings.upsert({
      where: { tenantId: toTenantId },
      create: { tenantId: toTenantId, ...patch },
      update: patch,
    });
  }

  // The orphan must never try to bill: its default card is gone (moved above),
  // so switch its autopay off and drop the dangling default-card pointer.
  if (fromSettings) {
    await dbc.tenantBillingSettings.update({
      where: { tenantId: fromTenantId },
      data: { autoBillingEnabled: false, defaultPaymentMethodId: null },
    }).catch(() => null);
  }

  return {
    invoicesMoved: invoices?.count ?? 0,
    lineItemsMoved: lineItems?.count ?? 0,
    transactionsMoved: transactions?.count ?? 0,
    chargeOperationsMoved: chargeOps?.count ?? 0,
    eventLogsMoved: eventLogs?.count ?? 0,
    paymentMethodsMoved: paymentMethods?.count ?? 0,
    autoBillingCarried: carryAutoBilling,
    defaultPaymentMethodCarried: carryDefaultPm,
    billingEmailCarried: carryBillingEmail,
  };
}

/**
 * Delete the orphaned checkout tenant, but ONLY if it is provably empty:
 * no users, no extensions, no PBX link, and no billing rows left (i.e. the
 * adoption above already ran). Anything still attached → leave it alone and
 * report why.
 */
export async function deleteTenantIfEmpty(
  dbc: any,
  tenantId: string,
): Promise<{ deleted: boolean; reason: string | null }> {
  const [users, extensions, link, invoices, paymentMethods] = await Promise.all([
    dbc.user.count({ where: { tenantId } }),
    dbc.extension.count({ where: { tenantId } }),
    dbc.tenantPbxLink.findFirst({ where: { tenantId } }),
    dbc.billingInvoice.count({ where: { tenantId } }),
    dbc.paymentMethod.count({ where: { tenantId } }),
  ]);
  const blockers: string[] = [];
  if (users > 0) blockers.push(`${users} user(s)`);
  if (extensions > 0) blockers.push(`${extensions} extension(s)`);
  if (link) blockers.push("a PBX link");
  if (invoices > 0) blockers.push(`${invoices} invoice(s)`);
  if (paymentMethods > 0) blockers.push(`${paymentMethods} payment method(s)`);
  if (blockers.length) return { deleted: false, reason: `still has ${blockers.join(", ")}` };
  await dbc.tenant.delete({ where: { id: tenantId } });
  return { deleted: true, reason: null };
}
