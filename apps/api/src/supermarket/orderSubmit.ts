/**
 * Draft approval + submission (supermarket plan Phase 3, delivery tie-in
 * Phase 7). ⛔ THIS is the only path a draft reaches their register through.
 *
 * The order of operations is the safety property:
 *  1. CLAIM — an atomic updateMany flips APPROVED→SUBMITTING conditioned on
 *     the status read, so 25 concurrent approvals submit exactly once (the
 *     compliance-calendar claim pattern);
 *  2. corrections are computed + frozen (the training data) BEFORE any
 *     external call, so a failed submit still captures the learning signal;
 *  3. the POS order is created with our idempotent externalId — their 409
 *     means "already landed" and is treated as success, never re-posted;
 *  4. the delivery-tracker ingest is best-effort AFTER the register accepted
 *     the order — a delivery hiccup can never lose a register order.
 */

import { computeCorrections } from "./draftMatcher";
import { posClientForTenant } from "./integrationCredentials";
import { PosApiError, posPhoneDigits, toPosExternalId } from "./posWithLogic";

export type DraftItemInput = {
  posProductId: string;
  code: string;
  name: string;
  qty: number;
  unitPriceCents: number;
};

export function sanitizeDraftItems(input: unknown): DraftItemInput[] {
  if (!Array.isArray(input)) return [];
  const out: DraftItemInput[] = [];
  for (const raw of input.slice(0, 100)) {
    if (raw == null || typeof raw !== "object") continue;
    const r: any = raw;
    const qty = Math.floor(Number(r.qty));
    const unit = Math.floor(Number(r.unitPriceCents));
    if (!Number.isFinite(qty) || qty < 1 || qty > 99) continue;
    if (!Number.isFinite(unit) || unit < 0 || unit > 9999999) continue;
    const posProductId = String(r.posProductId ?? "").slice(0, 64);
    if (!posProductId) continue;
    out.push({
      posProductId,
      code: String(r.code ?? "").slice(0, 32),
      name: String(r.name ?? "").slice(0, 200),
      qty,
      unitPriceCents: unit,
    });
  }
  return out;
}

export type SubmitDeps = {
  db: any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
  clientFor?: typeof posClientForTenant;
  /** Injected delivery ingest (the real ingestOrderEvent in production). */
  ingestDeliveryOrder?: (tenantId: string, event: any) => Promise<{ ok: boolean; code?: string }>;
};

export type SubmitResult =
  | { ok: true; posOrderId: string | null; alreadySubmitted: boolean }
  | { ok: false; code: string; message: string };

/**
 * Approve + submit one draft. `actorUserId` is the rep; `reviewedItems` is
 * what they approved (already sanitized by the route).
 */
export async function approveAndSubmitDraft(
  deps: SubmitDeps,
  input: {
    tenantId: string;
    draftId: string;
    actorUserId: string;
    reviewedItems: DraftItemInput[];
    comments: string;
    notes: string;
    orderMethod: "Pickup" | "Delivery";
  },
): Promise<SubmitResult> {
  const { db } = deps;
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  const clientFor = deps.clientFor ?? posClientForTenant;

  const draft = await db.supermarketOrderDraft.findFirst({
    where: { id: input.draftId, tenantId: input.tenantId },
  });
  if (!draft) return { ok: false, code: "not_found", message: "That draft does not exist." };
  if (draft.status === "SUBMITTED") return { ok: true, posOrderId: draft.posOrderId ?? null, alreadySubmitted: true };
  if (draft.status === "DISMISSED") return { ok: false, code: "dismissed", message: "That draft was dismissed." };
  if (input.reviewedItems.length === 0) {
    return { ok: false, code: "no_items", message: "An order needs at least one item." };
  }

  const client = await clientFor(db, input.tenantId);
  if (!client) {
    return { ok: false, code: "no_pos_key", message: "This company has no register connection set up." };
  }

  // 1) CLAIM. Only one concurrent approve wins; the rest read the outcome.
  const posExternalId = draft.posExternalId ?? toPosExternalId(`d${String(draft.id).replace(/[^A-Za-z0-9]/g, "").slice(-18)}`);
  const claimed = await db.supermarketOrderDraft.updateMany({
    where: { id: draft.id, tenantId: input.tenantId, status: { in: ["NEEDS_REVIEW", "APPROVED", "SUBMIT_FAILED"] } },
    data: { status: "SUBMITTING", posExternalId, reviewedBy: input.actorUserId },
  });
  if (!claimed || claimed.count !== 1) {
    const fresh = await db.supermarketOrderDraft.findFirst({ where: { id: draft.id }, select: { status: true, posOrderId: true } });
    if (fresh?.status === "SUBMITTED") return { ok: true, posOrderId: fresh.posOrderId ?? null, alreadySubmitted: true };
    return { ok: false, code: "submit_in_progress", message: "Somebody is already putting this order through." };
  }

  // 2) Corrections frozen before any external call.
  const agentItems = Array.isArray(draft.agentItems) ? (draft.agentItems as any[]) : [];
  const corrections = computeCorrections(
    agentItems.map((i: any) => ({ posProductId: String(i?.posProductId ?? ""), qty: Number(i?.qty ?? 0) })),
    input.reviewedItems.map((i) => ({ posProductId: i.posProductId, qty: i.qty })),
  );
  await db.supermarketOrderDraft.update({
    where: { id: draft.id },
    data: {
      items: input.reviewedItems,
      comments: input.comments.slice(0, 1000),
      notes: input.notes.slice(0, 2000),
      orderMethod: input.orderMethod,
      corrections,
      approvedAt: new Date(),
    },
  });

  // 3) The register order. ⛔ NEVER retried here — a timeout marks
  // SUBMIT_FAILED and the rep's retry rides the same externalId, where their
  // 409 proves whether the first attempt landed.
  const orderBody: Record<string, unknown> = {
    externalOrderId: posExternalId,
    orderMethod: input.orderMethod,
    ...(draft.posCustomerId ? { customerId: draft.posCustomerId } : {}),
    ...(input.comments ? { comments: input.comments.slice(0, 1000) } : {}),
    ...(input.notes ? { notes: input.notes.slice(0, 2000), memo: input.notes.slice(0, 2000) } : {}),
    items: input.reviewedItems.map((i) => ({
      productId: i.posProductId,
      productCode: i.code || undefined,
      quantity: i.qty,
      unitPrice: Math.round(i.unitPriceCents) / 100,
    })),
  };

  let posOrderId: string | null = null;
  try {
    const res: any = await client.createOrder(orderBody);
    posOrderId = res?.id ? String(res.id) : res?.orderId ? String(res.orderId) : null;
  } catch (err: any) {
    if (err instanceof PosApiError && err.code === "pos_duplicate") {
      // Our externalId already landed (an earlier timed-out attempt). Read it back.
      try {
        const existing: any = await client.getOrderByExternalId(posExternalId);
        posOrderId = existing?.id ? String(existing.id) : null;
      } catch {
        posOrderId = null;
      }
    } else {
      const code = err instanceof PosApiError ? err.code : "pos_error";
      await db.supermarketOrderDraft.update({
        where: { id: draft.id },
        data: { status: "SUBMIT_FAILED", submitError: String(code).slice(0, 200) },
      });
      log.warn({ draftId: draft.id, code }, "supermarket order submit failed");
      return { ok: false, code, message: "The register did not accept the order. Nothing was double-posted — try again." };
    }
  }

  await db.supermarketOrderDraft.update({
    where: { id: draft.id },
    data: { status: "SUBMITTED", posOrderId, submitError: null, submittedAt: new Date() },
  });

  // 4) Delivery tracker tie-in — best-effort, after the register accepted.
  if (input.orderMethod === "Delivery" && deps.ingestDeliveryOrder) {
    try {
      const settings = await db.supermarketSettings.findUnique({ where: { tenantId: input.tenantId } });
      if (settings?.deliveryIngestEnabled) {
        const address = await bestEffortCustomerAddress(client, draft.posCustomerId);
        if (address?.line1) {
          await deps.ingestDeliveryOrder(input.tenantId, {
            type: "created",
            id: `pos-${posExternalId}`,
            storeRef: String(settings.deliveryStoreRef || "main"),
            customer: { name: draft.customerName || undefined, phone: draft.customerPhone || undefined },
            address,
          });
        } else {
          log.warn({ draftId: draft.id }, "delivery ingest skipped: no address on the register account");
        }
      }
    } catch (err: any) {
      log.warn({ draftId: draft.id, err: String(err?.message ?? err) }, "delivery ingest failed (order already in register)");
    }
  }

  return { ok: true, posOrderId, alreadySubmitted: false };
}

/** Their customer response shapes are undocumented — read address fields defensively. */
async function bestEffortCustomerAddress(client: any, posCustomerId: string | null): Promise<any | null> {
  if (!posCustomerId) return null;
  try {
    const c: any = await client.getCustomerById(posCustomerId);
    const line1 = c?.address1 ?? c?.address ?? c?.street ?? c?.addressLine1 ?? null;
    if (!line1) return null;
    return {
      line1: String(line1).slice(0, 200),
      line2: c?.address2 ? String(c.address2).slice(0, 200) : undefined,
      city: c?.city ? String(c.city).slice(0, 100) : undefined,
      region: c?.state ? String(c.state).slice(0, 40) : undefined,
      postal: c?.zip ?? c?.zipCode ? String(c?.zip ?? c?.zipCode).slice(0, 20) : undefined,
    };
  } catch {
    return null;
  }
}

/** Reused by the screen-pop lookup route: 10-digit phone or null. */
export { posPhoneDigits };
