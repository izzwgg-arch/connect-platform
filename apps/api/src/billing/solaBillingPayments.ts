import type { SolaCardknoxAdapter, SolaWebhookEvent } from "@connect/integrations";
import { buildConnectBillingGatewayXInvoice, parseConnectBillingGatewayXInvoice } from "@connect/integrations";
import { db } from "@connect/db";
import { getBillingSolaAdapter, decryptPaymentToken } from "./solaGateway";
import { logBillingEvent, markBillingInvoicePaid } from "./invoiceEngine";
import {
  queuePaymentFailedEmailOnce,
  queueReceiptEmailOnce,
} from "./billingEmailLifecycle";

/** Keys used to detect duplicate webhook deliveries (same processor ref and/or same event id). */
export function buildBillingWebhookDedupeOrClause(params: { processorRef: string; eventId: string }) {
  const or: Array<{ processorTransactionId?: string; idempotencyKey?: string }> = [];
  if (params.processorRef) {
    or.push({ processorTransactionId: params.processorRef });
    or.push({ idempotencyKey: `webhook:ref:${params.processorRef}` });
  }
  if (params.eventId) {
    or.push({ idempotencyKey: `webhook:evt:${params.eventId}` });
  }
  return or.length ? { OR: or } : { OR: [{ idempotencyKey: "__impossible__" }] };
}

export function buildBillingWebhookIdempotencyKey(params: { eventId: string; processorRef: string }): string {
  if (params.eventId) return `webhook:evt:${params.eventId}`;
  if (params.processorRef) return `webhook:ref:${params.processorRef}`;
  return `webhook:unknown:${Date.now()}`;
}

/** Resolve `BillingInvoice` from webhook `xInvoice` (CONNECT-scoped or legacy number/id). */
export async function resolvePlatformBillingInvoiceForWebhookRef(ref: string) {
  if (!ref) return null;
  const parsed = parseConnectBillingGatewayXInvoice(ref);
  if (parsed) {
    const inv = await (db as any).billingInvoice.findFirst({
      where: { id: parsed.invoiceId, tenantId: parsed.tenantId },
      include: { paymentMethod: true },
    });
    if (inv) return inv;
  }
  return (db as any).billingInvoice.findFirst({
    where: { OR: [{ invoiceNumber: ref }, { id: ref }] },
    include: { paymentMethod: true },
  });
}

export type ChargeBillingInvoiceOptions = {
  runId?: string | null;
  /** Injected adapter for tests — omit to use tenant/env resolution via getBillingSolaAdapter */
  adapter?: SolaCardknoxAdapter;
};

/**
 * Token charge against a BillingInvoice (tenant pay button, admin retry, worker autopay).
 * Records PaymentTransaction, updates invoice on decline, receipt email on success.
 */
export async function chargeBillingInvoice(invoice: any, method: any, options?: ChargeBillingInvoiceOptions): Promise<any> {
  const adapter = options?.adapter ?? (await getBillingSolaAdapter(invoice.tenantId));
  const token = decryptPaymentToken(method);
  const amountCents = invoice.balanceDueCents ?? invoice.totalCents;
  const idempotencyKey = `billing:sale:${invoice.id}:${Date.now()}`;

  await logBillingEvent({
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    runId: options?.runId ?? null,
    type: options?.runId ? "autopay_attempted" : "payment.charge_attempt",
    message: options?.runId ? "Scheduled autopay charge" : `SOLA cc:sale for invoice ${invoice.invoiceNumber}`,
    metadata: { paymentMethodId: method.id, amountCents },
  });

  const gatewayXInvoice = buildConnectBillingGatewayXInvoice(invoice.tenantId, invoice.id, invoice.invoiceNumber);
  const response = await adapter.chargeToken({
    token,
    amountCents,
    gatewayXInvoice,
    idempotencyKey,
  });

  const processorRef =
    response.xRefNum !== undefined && response.xRefNum !== null && String(response.xRefNum).trim() !== ""
      ? String(response.xRefNum)
      : null;

  const transaction = await (db as any).paymentTransaction.create({
    data: {
      tenantId: invoice.tenantId,
      invoiceId: invoice.id,
      paymentMethodId: method.id,
      amountCents,
      status: response.approved ? "APPROVED" : response.status === "DECLINED" ? "DECLINED" : "ERROR",
      processorTransactionId: processorRef,
      responseCode: response.xResult,
      responseMessage: response.xError || response.xStatus,
      rawResponseSafeJson: response.safePayload,
      idempotencyKey,
    },
  });

  await (db as any).paymentMethod.update({ where: { id: method.id }, data: { lastUsedAt: new Date() } });

  if (response.approved) {
    await markBillingInvoicePaid(invoice.id, amountCents);
    await (db as any).billingInvoice.update({ where: { id: invoice.id }, data: { paymentMethodId: method.id } });
    const billingSettings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId: invoice.tenantId } });
    if (billingSettings?.billingEmail && transaction.id) {
      await queueReceiptEmailOnce({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        totalCents: invoice.totalCents,
        transactionId: transaction.id,
        cardLabel: method.last4 ? `${method.brand || "Card"} ending ${method.last4}` : null,
        paidViaAutopay: !!options?.runId,
      });
    }
  } else {
    await (db as any).billingInvoice.update({
      where: { id: invoice.id },
      data: { status: "FAILED", failedAt: new Date(), paymentMethodId: method.id },
    });
    await (db as any).alert
      .create({
        data: {
          tenantId: invoice.tenantId,
          severity: "HIGH",
          category: "BILLING",
          message: `Payment failed for invoice ${invoice.invoiceNumber}`,
          metadata: { invoiceId: invoice.id, transactionId: transaction.id },
        },
      })
      .catch(() => null);
    const billingSettings = await (db as any).tenantBillingSettings.findUnique({ where: { tenantId: invoice.tenantId } });
    if (billingSettings?.billingEmail && transaction.id) {
      await queuePaymentFailedEmailOnce({
        tenantId: invoice.tenantId,
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        totalCents: invoice.totalCents,
        transactionId: transaction.id,
        reason: response.xError,
      });
    }
  }

  await logBillingEvent({
    tenantId: invoice.tenantId,
    invoiceId: invoice.id,
    runId: options?.runId ?? null,
    type: response.approved ? "payment_succeeded" : "payment_failed",
    metadata: { transactionId: transaction.id, response: response.safePayload },
  });

  return transaction;
}

export type HostedSessionForBillingInvoiceInput = {
  invoice: {
    id: string;
    tenantId: string;
    invoiceNumber: string;
    balanceDueCents: number;
    totalCents: number;
    metadata?: unknown;
  };
  publicPortalBaseUrl: string;
  adapter?: SolaCardknoxAdapter;
};

/**
 * Creates a SOLA hosted checkout session for a BillingInvoice (JWT-authenticated caller).
 * Persists last session metadata on the invoice row for support/debug (no schema change).
 */
export async function createHostedSessionForBillingInvoice(input: HostedSessionForBillingInvoiceInput): Promise<{
  redirectUrl: string;
  providerSessionId?: string;
}> {
  const adapter = input.adapter ?? (await getBillingSolaAdapter(input.invoice.tenantId));
  const amountCents = input.invoice.balanceDueCents ?? input.invoice.totalCents;
  if (amountCents <= 0) {
    const err: any = new Error("INVOICE_ZERO_BALANCE");
    err.code = "INVOICE_ZERO_BALANCE";
    throw err;
  }

  const successUrl = `${input.publicPortalBaseUrl.replace(/\/$/, "")}/billing/invoices/${encodeURIComponent(input.invoice.id)}?hosted=success`;
  const cancelUrl = `${input.publicPortalBaseUrl.replace(/\/$/, "")}/billing/invoices/${encodeURIComponent(input.invoice.id)}?hosted=cancel`;

  const hosted = await adapter.createHostedSession({
    tenantId: input.invoice.tenantId,
    subscriptionId: input.invoice.id,
    planCode: "BILLING_INVOICE",
    amountCents,
    successUrl,
    cancelUrl,
  });

  const prevMeta = (input.invoice.metadata && typeof input.invoice.metadata === "object" ? input.invoice.metadata : {}) as Record<string, unknown>;
  const nextMeta = {
    ...prevMeta,
    hostedCheckout: {
      ...(typeof prevMeta.hostedCheckout === "object" && prevMeta.hostedCheckout ? (prevMeta.hostedCheckout as object) : {}),
      lastProviderSessionId: hosted.providerSessionId || null,
      lastRedirectUrl: hosted.redirectUrl,
      lastInvoiceNumber: input.invoice.invoiceNumber,
      updatedAt: new Date().toISOString(),
    },
  };

  await (db as any).billingInvoice.update({
    where: { id: input.invoice.id },
    data: { metadata: nextMeta },
  });

  await logBillingEvent({
    tenantId: input.invoice.tenantId,
    invoiceId: input.invoice.id,
    type: "payment.hosted_session_created",
    message: "Hosted checkout session created for invoice",
    metadata: { providerSessionId: hosted.providerSessionId || null },
  });

  return { redirectUrl: hosted.redirectUrl, providerSessionId: hosted.providerSessionId };
}

export type ApplyBillingWebhookContext = {
  platformInvoice: any;
  event: SolaWebhookEvent;
  payload: Record<string, any>;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  envAdapter: SolaCardknoxAdapter;
  getBillingSolaAdapterForTenant: (tenantId: string) => Promise<SolaCardknoxAdapter>;
};

/**
 * SOLA/Cardknox webhook branch for BillingInvoice + PaymentTransaction (idempotent).
 * Returns null if signature verification fails (caller should send 403).
 */
export async function applySolaWebhookToBillingInvoice(ctx: ApplyBillingWebhookContext): Promise<
  | { ok: true; deduped: true; invoiceId: string }
  | { ok: true; invoiceId: string; transactionId: string; approved: boolean }
  | { ok: false; error: "invalid_signature" | "missing_correlation" }
> {
  const { platformInvoice, event, payload, rawBody, headers, envAdapter, getBillingSolaAdapterForTenant } = ctx;

  let verifyAdapter: SolaCardknoxAdapter;
  try {
    verifyAdapter = await getBillingSolaAdapterForTenant(platformInvoice.tenantId);
  } catch {
    verifyAdapter = envAdapter;
  }

  const validSignature =
    verifyAdapter.verifyCardknoxWebhook(headers, rawBody) ||
    envAdapter.verifyCardknoxWebhook(headers, rawBody) ||
    verifyAdapter.verifyWebhook(headers, rawBody) ||
    envAdapter.verifyWebhook(headers, rawBody);

  if (!validSignature) {
    await logBillingEvent({
      tenantId: platformInvoice.tenantId,
      invoiceId: platformInvoice.id,
      type: "webhook.signature_rejected",
      message: "SOLA webhook signature verification failed for BillingInvoice branch",
      metadata: { invoiceNumber: platformInvoice.invoiceNumber },
    }).catch(() => null);
    return { ok: false, error: "invalid_signature" };
  }

  const processorRef = String(payload.xRefNum || payload.xRefnum || payload.xRefNumber || "").trim();
  const eventId = String(event.eventId || processorRef || "").trim();
  if (!eventId) {
    await logBillingEvent({
      tenantId: platformInvoice.tenantId,
      invoiceId: platformInvoice.id,
      type: "webhook.rejected",
      message: "Missing event id and processor ref on webhook",
      metadata: {},
    }).catch(() => null);
    return { ok: false, error: "missing_correlation" };
  }

  const dedupeWhere = buildBillingWebhookDedupeOrClause({ processorRef, eventId });
  const existingTx = await (db as any).paymentTransaction.findFirst({
    where: { tenantId: platformInvoice.tenantId, ...dedupeWhere },
  });
  if (existingTx) {
    await logBillingEvent({
      tenantId: platformInvoice.tenantId,
      invoiceId: platformInvoice.id,
      type: "webhook.deduped",
      message: "Duplicate SOLA webhook ignored",
      metadata: { existingTransactionId: existingTx.id, processorRef, eventId },
    }).catch(() => null);
    return { ok: true, deduped: true, invoiceId: platformInvoice.id };
  }

  const approved = event.status === "SUCCEEDED";
  const amountCents = event.amountCents ?? platformInvoice.balanceDueCents ?? platformInvoice.totalCents;
  const idempotencyKey = buildBillingWebhookIdempotencyKey({ eventId, processorRef });
  const xRes = String(payload.xResult || payload.xresult || "").trim().toUpperCase();
  let txStatus: "APPROVED" | "DECLINED" | "ERROR" | "PENDING";
  if (approved) txStatus = "APPROVED";
  else if (event.status === "FAILED") txStatus = xRes === "E" ? "ERROR" : "DECLINED";
  else txStatus = "PENDING";

  const tx = await (db as any).paymentTransaction.create({
    data: {
      tenantId: platformInvoice.tenantId,
      invoiceId: platformInvoice.id,
      paymentMethodId: platformInvoice.paymentMethodId || null,
      amountCents,
      currency: event.currency || platformInvoice.currency || "USD",
      status: txStatus,
      processor: "SOLA",
      processorTransactionId: processorRef ? String(processorRef) : null,
      responseCode: payload.xResult ? String(payload.xResult) : null,
      responseMessage: payload.xError || payload.xStatus ? String(payload.xError || payload.xStatus) : null,
      rawResponseSafeJson: payload as any,
      idempotencyKey,
    },
  });

  if (approved) {
    const wasPaid = platformInvoice.status === "PAID";
    if (!wasPaid) {
      await markBillingInvoicePaid(platformInvoice.id, amountCents);
    }
    if (!wasPaid) {
      const pm = platformInvoice.paymentMethod;
      const cardLabel = pm?.last4 ? `${pm.brand || "Card"} ending ${pm.last4}` : null;
      await queueReceiptEmailOnce({
        tenantId: platformInvoice.tenantId,
        invoiceId: platformInvoice.id,
        invoiceNumber: platformInvoice.invoiceNumber,
        totalCents: platformInvoice.totalCents,
        transactionId: tx.id,
        cardLabel,
        paidViaAutopay: false,
      });
    }
    await (db as any).billingEventLog.create({
      data: {
        tenantId: platformInvoice.tenantId,
        invoiceId: platformInvoice.id,
        type: "payment_succeeded",
        metadata: { transactionId: tx.id, providerEventId: event.eventId, source: "webhook" },
      },
    });
  } else if (event.status === "FAILED") {
    await (db as any).billingInvoice.update({
      where: { id: platformInvoice.id },
      data: { status: "FAILED", failedAt: new Date() },
    });
    await (db as any).alert
      .create({
        data: {
          tenantId: platformInvoice.tenantId,
          severity: "HIGH",
          category: "BILLING",
          message: `Payment failed for invoice ${platformInvoice.invoiceNumber}`,
          metadata: { invoiceId: platformInvoice.id, transactionId: tx.id },
        },
      })
      .catch(() => null);
    await queuePaymentFailedEmailOnce({
      tenantId: platformInvoice.tenantId,
      invoiceId: platformInvoice.id,
      invoiceNumber: platformInvoice.invoiceNumber,
      totalCents: platformInvoice.totalCents,
      transactionId: tx.id,
      reason: payload.xError || payload.xStatus ? String(payload.xError || payload.xStatus) : null,
    });
    await (db as any).billingEventLog.create({
      data: {
        tenantId: platformInvoice.tenantId,
        invoiceId: platformInvoice.id,
        type: "payment_failed",
        metadata: { transactionId: tx.id, providerEventId: event.eventId, xResult: xRes || null, source: "webhook" },
      },
    });
  } else {
    await (db as any).billingEventLog.create({
      data: {
        tenantId: platformInvoice.tenantId,
        invoiceId: platformInvoice.id,
        type: "webhook.payment_pending",
        metadata: { transactionId: tx.id, providerEventId: event.eventId },
      },
    });
  }

  return { ok: true, invoiceId: platformInvoice.id, transactionId: tx.id, approved };
}
