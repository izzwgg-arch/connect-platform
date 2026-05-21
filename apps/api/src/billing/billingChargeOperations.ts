import { createHash } from "node:crypto";
import { db } from "@connect/db";

type OperationStatus = "PENDING" | "APPROVED" | "DECLINED" | "ERROR";

export type BillingChargeReservation =
  | { kind: "new"; operation: any; businessKey: string }
  | { kind: "replay"; operation: any; transaction: any | null; businessKey: string };

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeText(input: string | null | undefined): string {
  return String(input || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function stableJson(input: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(input)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = input[key];
        return acc;
      }, {}),
  );
}

export function buildBillingChargeBusinessKey(parts: Record<string, unknown>): string {
  return `billing:charge:v2:${sha256(stableJson(parts)).slice(0, 48)}`;
}

export function buildSavedCardInvoiceChargeBusinessKey(input: {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  paymentMethodId: string;
  chargeType: string;
}): string {
  return buildBillingChargeBusinessKey({
    amountCents: input.amountCents,
    chargeType: input.chargeType,
    invoiceId: input.invoiceId,
    paymentMethodId: input.paymentMethodId,
    tenantId: input.tenantId,
  });
}

export function buildSutInvoiceChargeBusinessKey(input: {
  tenantId: string;
  invoiceId: string;
  amountCents: number;
  customerKey: string;
  chargeType: string;
}): string {
  return buildBillingChargeBusinessKey({
    amountCents: input.amountCents,
    chargeType: input.chargeType,
    customerKey: input.customerKey,
    invoiceId: input.invoiceId,
    tenantId: input.tenantId,
  });
}

export function buildOneTimeChargeBusinessKey(input: {
  tenantId: string;
  customerKey: string;
  amountCents: number;
  description: string;
  invoiceMemo?: string | null;
  chargeMode: string;
  paymentMethodId?: string | null;
}): string {
  return buildBillingChargeBusinessKey({
    amountCents: input.amountCents,
    chargeMode: input.chargeMode,
    customerKey: input.customerKey,
    description: normalizeText(input.description),
    invoiceMemo: normalizeText(input.invoiceMemo),
    paymentMethodId: input.paymentMethodId || null,
    tenantId: input.tenantId,
  });
}

function isUniqueViolation(err: unknown, fieldName: string): boolean {
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e?.code !== "P2002") return false;
  const target = e.meta?.target;
  if (Array.isArray(target)) return target.includes(fieldName);
  return String(target || "").includes(fieldName);
}

function chargeInProgress(operation: any, transaction: any | null = null): Error {
  const err: any = new Error("CHARGE_IN_PROGRESS");
  err.code = "CHARGE_IN_PROGRESS";
  err.existingOperation = operation;
  err.existingTransaction = transaction;
  return err;
}

async function findOperationTransaction(operation: any): Promise<any | null> {
  if (operation?.paymentTransactionId) {
    const byId = await (db as any).paymentTransaction.findUnique({ where: { id: operation.paymentTransactionId } });
    if (byId) return byId;
  }
  return (db as any).paymentTransaction.findFirst({
    where: { billingChargeOperationId: operation.id },
    orderBy: { createdAt: "desc" },
  });
}

async function resolveExistingOperation(
  operation: any,
  input: {
    businessKey: string;
    allowRetry?: boolean;
  },
): Promise<BillingChargeReservation> {
  const transaction = await findOperationTransaction(operation);
  if (operation.status === "PENDING") {
    throw chargeInProgress(operation, transaction);
  }
  if (operation.status === "APPROVED" || !input.allowRetry) {
    return { kind: "replay", operation, transaction, businessKey: input.businessKey };
  }
  const updated = await (db as any).billingChargeOperation.update({
    where: { id: operation.id },
    data: { status: "PENDING" },
  });
  return { kind: "new", operation: updated, businessKey: input.businessKey };
}

export async function reserveBillingChargeOperation(input: {
  tenantId: string;
  businessKey: string;
  operationType: string;
  chargeType: string;
  amountCents: number;
  invoiceId?: string | null;
  paymentMethodId?: string | null;
  customerKey?: string | null;
  clientOperationId?: string | null;
  metadata?: Record<string, unknown>;
  allowRetry?: boolean;
}): Promise<BillingChargeReservation> {
  try {
    const operation = await (db as any).billingChargeOperation.create({
      data: {
        tenantId: input.tenantId,
        businessKey: input.businessKey,
        operationType: input.operationType,
        chargeType: input.chargeType,
        amountCents: input.amountCents,
        invoiceId: input.invoiceId ?? null,
        paymentMethodId: input.paymentMethodId ?? null,
        customerKey: input.customerKey ?? null,
        clientOperationId: input.clientOperationId ?? null,
        metadata: input.metadata || undefined,
        status: "PENDING",
      },
    });
    return { kind: "new", operation, businessKey: input.businessKey };
  } catch (err) {
    if (!isUniqueViolation(err, "businessKey")) throw err;
    const existing = await (db as any).billingChargeOperation.findUnique({ where: { businessKey: input.businessKey } });
    if (!existing) throw err;
    return resolveExistingOperation(existing, input);
  }
}

export async function attachBillingChargeOperationInvoice(operationId: string, invoiceId: string): Promise<void> {
  await (db as any).billingChargeOperation.update({
    where: { id: operationId },
    data: { invoiceId },
  });
}

export async function markBillingChargeOperationError(operationId: string, message: string): Promise<void> {
  await (db as any).billingChargeOperation.update({
    where: { id: operationId },
    data: {
      status: "ERROR" satisfies OperationStatus,
      metadata: { error: message },
    },
  }).catch(() => null);
}

export async function updateBillingChargeOperationFromTransaction(operationId: string, transaction: any): Promise<void> {
  const status: OperationStatus =
    transaction?.status === "APPROVED"
      ? "APPROVED"
      : transaction?.status === "DECLINED"
        ? "DECLINED"
        : "ERROR";
  await (db as any).billingChargeOperation.update({
    where: { id: operationId },
    data: {
      status,
      invoiceId: transaction?.invoiceId ?? undefined,
      paymentMethodId: transaction?.paymentMethodId ?? undefined,
      paymentTransactionId: transaction?.id ?? undefined,
    },
  }).catch(() => null);
}
