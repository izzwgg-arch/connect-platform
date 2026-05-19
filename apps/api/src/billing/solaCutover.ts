/**
 * Sola/Connect billing cutover service — Phases A, B, C.
 *
 * CRITICAL SAFETY RULE: A tenant must NEVER have both an active Sola
 * recurring schedule AND Connect autopay enabled, unless explicitly in a
 * not-yet-cut-over state where the worker guard blocks Connect charges.
 *
 * PCI rules:
 * - NEVER log the raw vault token.
 * - NEVER return the token to the browser.
 * - Encrypt immediately using encryptJson (same key as storeSolaPaymentMethod).
 * - Only store encrypted token in PaymentMethod.tokenEncrypted.
 */

import { db } from "@connect/db";
import { encryptJson } from "@connect/security";
import { SolaRecurringClient } from "@connect/integrations";
import { logBillingEvent } from "./invoiceEngine";
import { resolveSolaRecurringClientConfig, parseSolaCardExpiry, last4FromMaskedCard } from "./solaExternalSchedules";

// ─── Cutover status values (string enum, no Prisma migration needed) ──────────
export const CUTOVER_STATUS = {
  TOKEN_LINKED: "TOKEN_LINKED",
  READY_FOR_CUTOVER: "READY_FOR_CUTOVER",
  CUTOVER_COMPLETE: "CUTOVER_COMPLETE",
  CUTOVER_FAILED: "CUTOVER_FAILED",
} as const;
export type CutoverStatus = (typeof CUTOVER_STATUS)[keyof typeof CUTOVER_STATUS];

// ─── Dependency injection types ───────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any;

export type SolaCutoverDeps = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  getRecurringClient: (tenantId?: string | null) => Promise<SolaRecurringClient>;
  encryptToken: (token: string) => string;
  logEvent: (input: { tenantId: string; type: string; message?: string; metadata?: Record<string, unknown> }) => Promise<void>;
  now?: () => Date;
};

export function defaultSolaCutoverDeps(): SolaCutoverDeps {
  return {
    db: db as AnyDb,
    getRecurringClient: async (tenantId) => new SolaRecurringClient(await resolveSolaRecurringClientConfig(tenantId)),
    encryptToken: (token: string) => encryptJson(token),
    logEvent: async (input) => {
      await logBillingEvent({
        tenantId: input.tenantId,
        type: input.type,
        message: input.message,
        metadata: input.metadata,
      });
    },
    now: () => new Date(),
  };
}

// ─── Phase A: Token Linking ────────────────────────────────────────────────────

export type LinkTokenResult =
  | { ok: true; paymentMethodId: string; last4: string | null; brand: string | null; expMonth: string | null; expYear: string | null }
  | { ok: false; code: number; error: string };

/**
 * Link a Sola vault token to a Connect PaymentMethod for an imported schedule.
 *
 * - Fetches the token from Cardknox /GetPaymentMethod.
 * - Encrypts it immediately — never stored or logged raw.
 * - Creates or updates a PaymentMethod row (isImported=true).
 * - Updates the schedule link: cutoverStatus=TOKEN_LINKED, linkedPaymentMethodId.
 * - Does NOT enable autopay, disable Sola, or create an invoice.
 */
export async function linkSolaTokenToPaymentMethod(input: {
  linkId: string;
  operatorId: string;
  deps?: SolaCutoverDeps;
}): Promise<LinkTokenResult> {
  const deps = input.deps ?? defaultSolaCutoverDeps();
  const now = deps.now?.() ?? new Date();

  // 1. Load schedule link
  const link = await (deps.db as AnyDb).billingSolaExternalScheduleLink.findUnique({
    where: { id: input.linkId },
  });
  if (!link) return { ok: false, code: 404, error: "schedule_link_not_found" };
  if (link.mappingStatus !== "MAPPED") return { ok: false, code: 400, error: "schedule_not_mapped" };
  if (!link.tenantId) return { ok: false, code: 400, error: "schedule_has_no_tenant" };

  const tenantId = link.tenantId;

  // 2. Verify tenant exists
  const tenant = await (deps.db as AnyDb).tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
  if (!tenant) return { ok: false, code: 404, error: "tenant_not_found" };

  // 3. Fetch token from Cardknox (server-side only)
  const client = await deps.getRecurringClient(tenantId);

  // Resolve solaPaymentMethodId — may be missing on older imports.
  // Try rawSafeJson first (free), then call GetSchedule to retrieve it.
  let pmId = link.solaPaymentMethodId as string | null | undefined;
  if (!pmId) {
    const raw = link.rawSafeJson as Record<string, unknown> | null | undefined;
    const fromJson = raw?.PaymentMethodId ?? raw?.paymentMethodId;
    if (fromJson && typeof fromJson === "string" && fromJson.trim()) {
      pmId = fromJson.trim();
    }
  }
  if (!pmId) {
    // Try GetSchedule — some Cardknox accounts omit PaymentMethodId from the list view
    try {
      const scheduleRow = await client.getSchedule(link.solaScheduleId);
      const fetched = scheduleRow.PaymentMethodId ?? scheduleRow.paymentMethodId;
      if (fetched && typeof fetched === "string" && fetched.trim()) {
        pmId = fetched.trim();
        await (deps.db as AnyDb).billingSolaExternalScheduleLink.update({
          where: { id: link.id },
          data: { solaPaymentMethodId: pmId },
        });
      }
    } catch {
      // Fall through to GetCustomer
    }
  }
  if (!pmId && link.solaCustomerId) {
    // GetCustomer: Cardknox returns DefaultPaymentMethodId on the customer record.
    // (The PaymentMethods array is absent — DefaultPaymentMethodId is the canonical field.)
    try {
      const customerRow = await client.getCustomer(link.solaCustomerId);
      // Cardknox recurring v2 returns DefaultPaymentMethodId at the top level
      const fetched =
        customerRow.DefaultPaymentMethodId ??
        customerRow.defaultPaymentMethodId ??
        // Fallback: first item if the account ever returns an array
        (Array.isArray(customerRow.PaymentMethods)
          ? (customerRow.PaymentMethods as Array<Record<string, unknown>>)[0]?.PaymentMethodId
          : undefined);
      if (fetched && typeof fetched === "string" && fetched.trim()) {
        pmId = fetched.trim();
        await (deps.db as AnyDb).billingSolaExternalScheduleLink.update({
          where: { id: link.id },
          data: { solaPaymentMethodId: pmId },
        });
      }
    } catch {
      // Fall through to final error
    }
  }
  if (!pmId) return { ok: false, code: 400, error: "schedule_has_no_payment_method_id" };

  // 4. Fetch vault token (server-side only — never log or return raw)
  let tokenData: { token: string; issuer: string | null; maskedCardNumber: string | null; exp: string | null };
  try {
    tokenData = await client.getPaymentMethodWithToken(pmId);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "token_fetch_failed";
    return { ok: false, code: 502, error: `sola_token_fetch_failed: ${msg}` };
  }

  // 4. Encrypt immediately — raw token never touches a log or response
  const tokenEncrypted = deps.encryptToken(tokenData.token);

  const { expMonth, expYear } = parseSolaCardExpiry(tokenData.exp);
  const last4 = last4FromMaskedCard(tokenData.maskedCardNumber);

  // 5. Create or update PaymentMethod (upsert by processorPaymentMethodId within tenant)
  const existingPm = await (deps.db as AnyDb).paymentMethod.findFirst({
    where: { tenantId, processorPaymentMethodId: pmId, active: true },
  });

  let paymentMethod: { id: string; brand: string | null; last4: string | null; expMonth: string | null; expYear: string | null };

  if (existingPm) {
    paymentMethod = await (deps.db as AnyDb).paymentMethod.update({
      where: { id: existingPm.id },
      data: {
        tokenEncrypted,
        tokenKeyId: "v1",
        brand: tokenData.issuer || existingPm.brand,
        last4: last4 || existingPm.last4,
        expMonth: expMonth || existingPm.expMonth,
        expYear: expYear || existingPm.expYear,
        isImported: true,
        importedAt: existingPm.importedAt ?? now,
        processorCustomerId: link.solaCustomerId,
        processorPaymentMethodId: pmId,
        metadata: {
          solaScheduleLinkId: link.id,
          solaCustomerId: link.solaCustomerId,
          solaPaymentMethodId: pmId,
          source: "sola_recurring_import",
        },
      },
      select: { id: true, brand: true, last4: true, expMonth: true, expYear: true },
    });
  } else {
    paymentMethod = await (deps.db as AnyDb).paymentMethod.create({
      data: {
        tenantId,
        processor: "SOLA",
        tokenEncrypted,
        tokenKeyId: "v1",
        brand: tokenData.issuer || link.brand,
        last4: last4 || link.last4,
        expMonth: expMonth || link.expMonth,
        expYear: expYear || link.expYear,
        isDefault: false,
        active: true,
        isImported: true,
        importedAt: now,
        processorCustomerId: link.solaCustomerId,
        processorPaymentMethodId: pmId,
        metadata: {
          solaScheduleLinkId: link.id,
          solaCustomerId: link.solaCustomerId,
          solaPaymentMethodId: pmId,
          source: "sola_recurring_import",
        },
      },
      select: { id: true, brand: true, last4: true, expMonth: true, expYear: true },
    });
  }

  // 6. Update schedule link — mark TOKEN_LINKED
  await (deps.db as AnyDb).billingSolaExternalScheduleLink.update({
    where: { id: input.linkId },
    data: {
      cutoverStatus: CUTOVER_STATUS.TOKEN_LINKED,
      linkedPaymentMethodId: paymentMethod.id,
      tokenLinkedAt: now,
    },
  });

  // 7. Log audit event (no token in metadata)
  await deps.logEvent({
    tenantId,
    type: "billing.sola_external_token_linked",
    message: "Sola vault token linked to Connect PaymentMethod. No charge. Old Sola schedule unchanged.",
    metadata: {
      linkId: input.linkId,
      solaScheduleId: link.solaScheduleId,
      solaPaymentMethodId: pmId,
      paymentMethodId: paymentMethod.id,
      brand: paymentMethod.brand,
      last4: paymentMethod.last4,
      operatorId: input.operatorId,
    },
  });

  return {
    ok: true,
    paymentMethodId: paymentMethod.id,
    last4: paymentMethod.last4,
    brand: paymentMethod.brand,
    expMonth: paymentMethod.expMonth,
    expYear: paymentMethod.expYear,
  };
}

// ─── Phase B: Readiness Check ────────────────────────────────────────────────

export type CutoverReadiness = {
  pricingConfigured: boolean;
  paymentMethodLinked: boolean;
  importedScheduleMapped: boolean;
  oldSolaScheduleActive: boolean;
  connectAutopayEnabled: boolean;
  doubleChargeRisk: boolean;
  nextPaymentDate: string | null;
  skipNextPayment: boolean;
  readyForCutover: boolean;
  blockers: string[];
  warnings: string[];
  scheduleLink: {
    id: string;
    cutoverStatus: string | null;
    linkedPaymentMethodId: string | null;
    solaScheduleId: string;
    brand: string | null;
    last4: string | null;
  } | null;
};

export async function getBillingCutoverReadiness(input: {
  tenantId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  deps?: { db: any };
}): Promise<CutoverReadiness> {
  const deps = input.deps ?? { db: db as AnyDb };

  // Load billing settings
  const settings = await (deps.db as AnyDb).tenantBillingSettings.findUnique({
    where: { tenantId: input.tenantId },
    select: {
      autoBillingEnabled: true,
      defaultPaymentMethodId: true,
      extensionPriceCents: true,
      metadata: true,
    },
  });

  // Load mapped sola schedule links for this tenant
  const scheduleLinks = await (deps.db as AnyDb).billingSolaExternalScheduleLink.findMany({
    where: { tenantId: input.tenantId, mappingStatus: "MAPPED" },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true,
      solaScheduleId: true,
      brand: true,
      last4: true,
      isActive: true,
      cutoverStatus: true,
      linkedPaymentMethodId: true,
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeLinks = scheduleLinks.filter((l: any) => l.isActive);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nonCutoverActiveLinks = activeLinks.filter((l: any) => l.cutoverStatus !== CUTOVER_STATUS.CUTOVER_COMPLETE);

  const pricingConfigured = !!(settings?.extensionPriceCents && settings.extensionPriceCents > 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paymentMethodLinked = scheduleLinks.some((l: any) => l.linkedPaymentMethodId);
  const importedScheduleMapped = scheduleLinks.length > 0;
  const oldSolaScheduleActive = activeLinks.length > 0;
  const connectAutopayEnabled = !!(settings?.autoBillingEnabled);

  // Double-charge risk: active Sola schedule AND Connect autopay both enabled
  const doubleChargeRisk = connectAutopayEnabled && nonCutoverActiveLinks.length > 0;

  const meta = settings?.metadata as Record<string, unknown> | null;
  const scheduleOverride = meta?.billingScheduleOverride as
    | { nextPaymentDate?: string | null; skipNextPayment?: boolean }
    | null
    | undefined;
  const nextPaymentDate = scheduleOverride?.nextPaymentDate ?? null;
  const skipNextPayment = scheduleOverride?.skipNextPayment ?? false;

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!importedScheduleMapped) blockers.push("No Sola schedule mapped to this tenant.");
  if (!paymentMethodLinked) blockers.push("Card token not yet linked — run Link card token first.");
  if (connectAutopayEnabled && nonCutoverActiveLinks.length > 0)
    blockers.push("Connect autopay is already enabled while old Sola schedule is active. Double-charge risk.");
  if (connectAutopayEnabled && !nonCutoverActiveLinks.length) {
    // Nothing to cut over; already done or Connect autopay is from another source
    warnings.push("Connect autopay is already enabled for this tenant.");
  }

  if (oldSolaScheduleActive && !connectAutopayEnabled) {
    warnings.push("Old Sola schedule is still active. Taking over billing will disable it.");
  }
  if (!oldSolaScheduleActive && importedScheduleMapped) {
    warnings.push("Mapped Sola schedule appears already inactive. Verify before taking over billing.");
  }

  const bestLink = scheduleLinks[0] ?? null;

  const readyForCutover =
    blockers.length === 0 &&
    importedScheduleMapped &&
    paymentMethodLinked &&
    !connectAutopayEnabled;

  return {
    pricingConfigured,
    paymentMethodLinked,
    importedScheduleMapped,
    oldSolaScheduleActive,
    connectAutopayEnabled,
    doubleChargeRisk,
    nextPaymentDate: nextPaymentDate ?? null,
    skipNextPayment,
    readyForCutover,
    blockers,
    warnings,
    scheduleLink: bestLink
      ? {
          id: bestLink.id,
          cutoverStatus: bestLink.cutoverStatus,
          linkedPaymentMethodId: bestLink.linkedPaymentMethodId,
          solaScheduleId: bestLink.solaScheduleId,
          brand: bestLink.brand,
          last4: bestLink.last4,
        }
      : null,
  };
}

// ─── Phase C: Take Over Billing ───────────────────────────────────────────────

export type TakeOverBillingInput = {
  tenantId: string;
  solaScheduleLinkId: string;
  linkedPaymentMethodId: string;
  confirmDisableSolaSchedule: true;
  confirmEnableConnectAutopay: true;
  confirmNoImmediateCharge: true;
  operatorId: string;
};

export type TakeOverBillingResult =
  | { ok: true; cutoverAt: string; paymentMethodId: string }
  | { ok: false; code: number; error: string; disableError?: string };

/**
 * Phase C manual cutover — take over billing in Connect.
 *
 * Sequence (all or nothing):
 *  1. Validate schedule belongs to tenant, token exists, Connect autopay not already on.
 *  2. Disable old Sola schedule via /UpdateSchedule IsActive=false.
 *     → On failure: mark CUTOVER_FAILED, return error. Connect autopay NOT enabled.
 *  3. Set PaymentMethod as default for tenant.
 *  4. Enable Connect autoBillingEnabled.
 *  5. Mark schedule link CUTOVER_COMPLETE with timestamps.
 *  6. Log BillingEventLog events.
 *
 * Does NOT create an invoice. Does NOT charge immediately.
 */
export async function takeOverBillingFromSola(
  input: TakeOverBillingInput,
  deps?: SolaCutoverDeps,
): Promise<TakeOverBillingResult> {
  const d = deps ?? defaultSolaCutoverDeps();
  const now = d.now?.() ?? new Date();

  // 1. Load and validate schedule link
  const link = await (d.db as AnyDb).billingSolaExternalScheduleLink.findUnique({
    where: { id: input.solaScheduleLinkId },
  });
  if (!link) return { ok: false, code: 404, error: "schedule_link_not_found" };
  if (link.tenantId !== input.tenantId) return { ok: false, code: 403, error: "schedule_belongs_to_different_tenant" };
  if (link.mappingStatus !== "MAPPED") return { ok: false, code: 400, error: "schedule_not_mapped" };
  if (link.linkedPaymentMethodId !== input.linkedPaymentMethodId) {
    return { ok: false, code: 400, error: "payment_method_does_not_match_schedule_link" };
  }
  if (link.cutoverStatus === CUTOVER_STATUS.CUTOVER_COMPLETE) {
    return { ok: false, code: 409, error: "already_cutover_complete" };
  }

  // 2. Verify token exists on PaymentMethod
  const pm = await (d.db as AnyDb).paymentMethod.findUnique({
    where: { id: input.linkedPaymentMethodId },
    select: { id: true, tenantId: true, tokenEncrypted: true, active: true, brand: true, last4: true },
  });
  if (!pm || pm.tenantId !== input.tenantId) return { ok: false, code: 404, error: "payment_method_not_found" };
  if (!pm.active) return { ok: false, code: 400, error: "payment_method_inactive" };
  if (!pm.tokenEncrypted) return { ok: false, code: 400, error: "payment_method_token_missing" };

  // 3. Verify Connect autopay not already enabled (double-charge guard)
  const settings = await (d.db as AnyDb).tenantBillingSettings.findUnique({
    where: { tenantId: input.tenantId },
    select: { autoBillingEnabled: true },
  });
  if (settings?.autoBillingEnabled) {
    return { ok: false, code: 409, error: "connect_autopay_already_enabled" };
  }

  // Log cutover started
  await d.logEvent({
    tenantId: input.tenantId,
    type: "billing.sola_cutover_started",
    message: "Operator initiated Connect billing takeover from Sola.",
    metadata: {
      operatorId: input.operatorId,
      solaScheduleLinkId: link.id,
      solaScheduleId: link.solaScheduleId,
      paymentMethodId: pm.id,
    },
  });

  // 4. Disable old Sola recurring schedule — MUST succeed before enabling Connect autopay
  const client = await d.getRecurringClient(input.tenantId);
  const disableAttemptedAt = d.now?.() ?? new Date();

  try {
    await client.updateSchedule(link.solaScheduleId, { isActive: false });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : "disable_failed";
    // Mark as failed — do NOT enable Connect autopay
    await (d.db as AnyDb).billingSolaExternalScheduleLink.update({
      where: { id: link.id },
      data: {
        cutoverStatus: CUTOVER_STATUS.CUTOVER_FAILED,
        disableAttemptedAt,
        disableError: errMsg.slice(0, 500),
      },
    });
    await d.logEvent({
      tenantId: input.tenantId,
      type: "billing.sola_schedule_disable_failed",
      message: "Failed to disable old Sola recurring schedule. Connect autopay NOT enabled.",
      metadata: {
        operatorId: input.operatorId,
        solaScheduleLinkId: link.id,
        solaScheduleId: link.solaScheduleId,
        error: errMsg.slice(0, 500),
      },
    });
    return {
      ok: false,
      code: 502,
      error: "sola_schedule_disable_failed",
      disableError: errMsg.slice(0, 200),
    };
  }

  const disabledSolaAt = d.now?.() ?? new Date();
  await d.logEvent({
    tenantId: input.tenantId,
    type: "billing.sola_schedule_disabled",
    message: "Old Sola recurring schedule disabled successfully.",
    metadata: {
      operatorId: input.operatorId,
      solaScheduleLinkId: link.id,
      solaScheduleId: link.solaScheduleId,
    },
  });

  // 5. Set PaymentMethod as default
  await (d.db as AnyDb).paymentMethod.updateMany({
    where: { tenantId: input.tenantId },
    data: { isDefault: false },
  });
  await (d.db as AnyDb).paymentMethod.update({
    where: { id: pm.id },
    data: { isDefault: true },
  });

  // 6. Enable Connect autopay for tenant (upsert billingSettings)
  const connectAutopayEnabledAt = d.now?.() ?? new Date();
  await (d.db as AnyDb).tenantBillingSettings.upsert({
    where: { tenantId: input.tenantId },
    create: {
      tenantId: input.tenantId,
      autoBillingEnabled: true,
      defaultPaymentMethodId: pm.id,
    },
    update: {
      autoBillingEnabled: true,
      defaultPaymentMethodId: pm.id,
    },
  });

  await d.logEvent({
    tenantId: input.tenantId,
    type: "billing.connect_autopay_enabled",
    message: "Connect autopay enabled after successful Sola schedule disable.",
    metadata: {
      operatorId: input.operatorId,
      paymentMethodId: pm.id,
      brand: pm.brand,
      last4: pm.last4,
    },
  });

  // 7. Mark schedule link CUTOVER_COMPLETE
  const cutoverAt = d.now?.() ?? new Date();
  await (d.db as AnyDb).billingSolaExternalScheduleLink.update({
    where: { id: link.id },
    data: {
      cutoverStatus: CUTOVER_STATUS.CUTOVER_COMPLETE,
      cutoverAt,
      cutoverByUserId: input.operatorId,
      disabledSolaAt,
      disableAttemptedAt,
      disableError: null,
      connectAutopayEnabledAt,
    },
  });

  await d.logEvent({
    tenantId: input.tenantId,
    type: "billing.sola_cutover_completed",
    message: "Billing cutover to Connect complete. No immediate charge created.",
    metadata: {
      operatorId: input.operatorId,
      solaScheduleLinkId: link.id,
      solaScheduleId: link.solaScheduleId,
      paymentMethodId: pm.id,
    },
  });

  return {
    ok: true,
    cutoverAt: cutoverAt.toISOString(),
    paymentMethodId: pm.id,
  };
}
