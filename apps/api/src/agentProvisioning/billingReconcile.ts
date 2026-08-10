/**
 * "If the customer adds something, the bill has to follow." — Izzy, 2026-08-06.
 *
 * ⛔ READ THIS BEFORE ADDING A "CHARGE THEM FOR IT" STEP.
 *
 * Next month's invoice does NOT store quantities. It recounts them live every
 * cycle: `resolveBillingQuantities` → `calculateTenantBillingUsage` reads the
 * Extension rows, the PhoneNumber rows and the tenant's SMS flags at the moment
 * the invoice is built. So for a normal tenant, **creating the extension IS the
 * billing update** — and any code that also adds a line, bumps a counter, or
 * writes a charge would bill the customer TWICE for one extension.
 *
 * That is why this module does not "add to the bill". It does the one thing
 * that is actually missing: it PROVES the bill moved, and repairs it when it
 * didn't. There are exactly three ways a real provisioning can be silently
 * free, and all three have bitten this platform:
 *
 *  1. The tenant is on a MANUAL quantity override — the invoice bills a frozen
 *     number and ignores reality forever. We bump the override.
 *  2. The extension number isn't exactly three digits — `calculateTenantBillingUsage`
 *     filters on /^\d{3}$/, so a 2- or 4-digit extension works on the phone and
 *     is never billed. (Same family as the 1-digit bug that made extensions
 *     invisible platform-wide.)
 *  3. A phone number that never lands in the `phoneNumber` table — onboarding
 *     numbers live in PbxTenantInboundDid, which the plan's per-number line
 *     does not count.
 *
 * The shape is: snapshot the monthly total BEFORE, provision, snapshot AFTER,
 * and refuse to call it done if the money didn't move.
 */
import { db } from "@connect/db";
import { buildBillingInvoicePreview } from "../billing/invoiceEngine";
import {
  parseBillingQuantityOverrides,
  mergeBillingQuantityOverridesIntoMetadata,
  type BillingQuantityOverrideKey,
  type BillingQuantityOverridesConfig,
} from "../billing/billingQuantityOverrides";

/** What the customer is adding, in billing terms. */
export type BillableAddition = "extension" | "sms" | "local_number" | "tollfree_number";

/** The override bucket each addition is counted in. */
const OVERRIDE_KEY: Record<BillableAddition, BillingQuantityOverrideKey> = {
  extension: "extensions",
  sms: "smsPackages",
  local_number: "phoneNumbers",
  tollfree_number: "tollFreeNumbers",
};

export type BillingSnapshot = {
  /** What next month currently comes to, in cents, tax and fees included. */
  monthlyTotalCents: number;
  /** Per-bucket billed quantity at snapshot time. */
  quantities: Record<BillingQuantityOverrideKey, number>;
  /** Buckets pinned to a manual number — these do NOT follow reality. */
  manualBuckets: BillingQuantityOverrideKey[];
  /** Unit prices this tenant is actually on (never the sign-up defaults). */
  unitPrices: {
    extensionCents: number;
    additionalPhoneNumberCents: number;
    smsCents: number;
    firstPhoneNumberFree: boolean;
  };
};

/**
 * What this tenant's next invoice looks like right now. Everything downstream
 * quotes and verifies against this, so a price the customer is told is a price
 * the engine actually produces — not a constant that drifted.
 */
export async function snapshotBilling(tenantId: string): Promise<BillingSnapshot> {
  const preview = await buildBillingInvoicePreview({ tenantId });
  const q = preview.billingQuantities;
  const p = preview.pricingResolution;
  const quantities: Record<BillingQuantityOverrideKey, number> = {
    extensions: q?.billing.extensions ?? 0,
    virtualExtensions: q?.billing.virtualExtensions ?? 0,
    phoneNumbers: q?.billing.phoneNumbers ?? 0,
    tollFreeNumbers: q?.billing.tollFreeNumbers ?? 0,
    smsPackages: q?.billing.smsPackages ?? 0,
  };
  const manualBuckets = (Object.keys(quantities) as BillingQuantityOverrideKey[]).filter(
    (k) => q?.modes?.[k] === "manual",
  );
  return {
    monthlyTotalCents: preview.totalCents,
    quantities,
    manualBuckets,
    unitPrices: {
      extensionCents: p?.extensionPriceCents ?? 0,
      additionalPhoneNumberCents: p?.additionalPhoneNumberPriceCents ?? 0,
      smsCents: p?.smsPriceCents ?? 0,
      firstPhoneNumberFree: p?.firstPhoneNumberFree !== false,
    },
  };
}

/** "$30.00" — anything a customer reads. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * What one more of `kind` costs this tenant per month, from THEIR plan.
 *
 * ⛔ Returns the price the invoice engine will actually use. The sign-up
 * constants ($30 an extension, $10 SMS) are what a NEW customer is quoted; an
 * existing tenant may be on a different plan or a negotiated rate, and quoting
 * a number their invoice then contradicts is the one billing mistake customers
 * never forget.
 */
export function priceOfAddition(snapshot: BillingSnapshot, kind: BillableAddition): {
  unitCents: number;
  /** False when this one is genuinely free (the first local number). */
  charged: boolean;
  note: string;
} {
  switch (kind) {
    case "extension":
      return { unitCents: snapshot.unitPrices.extensionCents, charged: true, note: "per month, per extension" };
    case "sms":
      return { unitCents: snapshot.unitPrices.smsCents, charged: true, note: "per month, flat" };
    case "tollfree_number":
      return { unitCents: snapshot.unitPrices.additionalPhoneNumberCents, charged: true, note: "per month" };
    case "local_number": {
      // The first LOCAL number is included. "Billable" is already
      // first-free-adjusted, so a tenant billing 0 today gets the next one free
      // only if they have no local number at all.
      const free = snapshot.unitPrices.firstPhoneNumberFree && snapshot.quantities.phoneNumbers === 0;
      return {
        unitCents: free ? 0 : snapshot.unitPrices.additionalPhoneNumberCents,
        charged: !free,
        note: free ? "your first number is included" : "per month, per extra number",
      };
    }
  }
}

export type BillingReconcileResult = {
  /** Next month's total after provisioning. */
  monthlyTotalCents: number;
  /** How much the monthly bill actually moved. */
  deltaCents: number;
  /** True when a manual override had to be bumped for the charge to happen. */
  repairedManualOverride: boolean;
  /**
   * ⛔ Set when the customer now HAS the thing and the bill did not move. The
   * caller must surface this — a silent free extension is a real loss, and it
   * is invisible in every screen we have.
   */
  warning: string | null;
};

/**
 * Called AFTER the thing exists. Confirms next month's invoice reflects it, and
 * repairs the one case we can repair (a manual override that would otherwise
 * ignore the change forever).
 */
export async function reconcileBillingAfterAddition(input: {
  tenantId: string;
  kind: BillableAddition;
  before: BillingSnapshot;
  /** What we told the customer it would cost. */
  quotedUnitCents: number;
  actorUserId?: string | null;
}): Promise<BillingReconcileResult> {
  const key = OVERRIDE_KEY[input.kind];
  let repairedManualOverride = false;

  // A manual bucket is pinned: usage moved, the invoice will not. Bump it by
  // one so the customer is billed for what they just asked for. We never
  // silently switch them back to auto — someone chose manual deliberately, and
  // that choice may be holding a negotiated quantity.
  if (input.before.manualBuckets.includes(key)) {
    const settings = await db.tenantBillingSettings.findUnique({ where: { tenantId: input.tenantId } });
    const overrides: BillingQuantityOverridesConfig = {
      ...(parseBillingQuantityOverrides(settings?.metadata) ?? {}),
    };
    const current = overrides[key];
    const bumped = Math.max(0, Number(current?.quantity ?? 0)) + 1;
    overrides[key] = { mode: "manual", quantity: bumped };
    await db.tenantBillingSettings.update({
      where: { tenantId: input.tenantId },
      data: { metadata: mergeBillingQuantityOverridesIntoMetadata(settings?.metadata, overrides) as any },
    });
    repairedManualOverride = true;
  }

  const after = await snapshotBilling(input.tenantId);
  const deltaCents = after.monthlyTotalCents - input.before.monthlyTotalCents;

  // The honest check. If we quoted money and the bill did not move, something
  // upstream is not being counted — say so rather than reporting success.
  let warning: string | null = null;
  if (input.quotedUnitCents > 0 && deltaCents <= 0) {
    warning =
      `Heads up: this was set up, but next month's bill did not go up. It should have risen by about ` +
      `${formatCents(input.quotedUnitCents)}. Someone needs to check the billing settings for this account.`;
  }

  return { monthlyTotalCents: after.monthlyTotalCents, deltaCents, repairedManualOverride, warning };
}

/**
 * The real invoice engine, packaged for injection. Capabilities take billing as
 * a dependency so they can be tested without standing the whole engine up — and
 * so this is the ONE place the real thing is wired in.
 */
export const defaultBillingDeps = {
  snapshot: snapshotBilling,
  priceOf: (snapshot: BillingSnapshot, kind: string) => priceOfAddition(snapshot, kind as BillableAddition),
  reconcile: (input: {
    tenantId: string;
    kind: string;
    before: BillingSnapshot;
    quotedUnitCents: number;
    actorUserId?: string | null;
  }) => reconcileBillingAfterAddition({ ...input, kind: input.kind as BillableAddition }),
  format: formatCents,
};
