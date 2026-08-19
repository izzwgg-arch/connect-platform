// Scan → assignment service. Idempotent, tenant/store-safe, server-authoritative.
// Uses the pure decideScan() for all branching; this layer only touches the db.

import { db } from "@connect/db";
import { decideScan, normalizeClientOpId, type ScanDecision } from "./scan";
import { resolveLabelToken, transitionOrder } from "./orderService";
import { writeDeliveryAudit } from "./audit";
import type { DeliveryOrderStatus } from "./status";

export interface ScanInput {
  tenantId: string;
  driverId: string;
  driverStoreIds: string[];
  actorUserId: string;
  token: string;
  clientOpId: unknown;
  confirmReassign?: boolean;
}

export interface ScanResult {
  ok: boolean;
  decision?: ScanDecision;
  orderId?: string;
  idempotent?: boolean;
  code?: string;
}

const isUniqueViolation = (e: any) => e?.code === "P2002";

/** Progress a freshly-assigned order to ASSIGNED via legal driver transitions. */
async function progressToAssigned(tenantId: string, orderId: string, status: DeliveryOrderStatus, actorUserId: string) {
  if (status === "READY") {
    await transitionOrder({ tenantId, orderId, to: "SCANNED", actor: "driver", actorUserId });
    await transitionOrder({ tenantId, orderId, to: "ASSIGNED", actor: "driver", actorUserId });
  } else if (status === "SCANNED") {
    await transitionOrder({ tenantId, orderId, to: "ASSIGNED", actor: "driver", actorUserId });
  }
  // LOADED / RETURNED_TO_STORE / RESCHEDULED: keep current (assignment recorded separately)
}

export async function scanLabel(input: ScanInput): Promise<ScanResult> {
  const clientOpId = normalizeClientOpId(input.clientOpId);
  if (!clientOpId) return { ok: false, code: "op_id_required" };

  // Idempotency: this exact client operation already applied?
  // Tenant-scoped: `clientOpId` is client-supplied and globally unique, so a
  // bare lookup would hand back a FOREIGN tenant's orderId on a collision.
  // Ids are 40-bit tokens so guessing is impractical — closed anyway.
  const priorOp = await db.deliveryAssignment.findFirst({
    where: { clientOpId, tenantId: input.tenantId },
    select: { orderId: true, driverId: true },
  });
  if (priorOp) {
    return {
      ok: true,
      idempotent: true,
      orderId: priorOp.orderId,
      decision: {
        outcome: "duplicate",
        code: "duplicate",
        canAssign: false,
        needsConfirmation: false,
        message: "Already scanned — it's on your run.",
      },
    };
  }

  const order = await resolveLabelToken(input.tenantId, input.token);
  const currentAssignment = order
    ? await db.deliveryAssignment.findUnique({ where: { orderId: order.id }, select: { driverId: true } })
    : null;

  const decision = decideScan({
    driverTenantId: input.tenantId,
    driverStoreIds: input.driverStoreIds,
    driverId: input.driverId,
    order: order
      ? { id: order.id, tenantId: order.tenantId, storeId: order.storeId, status: order.status as DeliveryOrderStatus }
      : null,
    currentAssigneeDriverId: currentAssignment?.driverId ?? null,
    alreadyProcessed: false,
  });

  // Clean assignment path.
  if (decision.canAssign && order) {
    try {
      await db.deliveryAssignment.create({
        data: { tenantId: input.tenantId, orderId: order.id, driverId: input.driverId, clientOpId },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        // Raced: someone assigned between decide and create.
        return {
          ok: true,
          orderId: order.id,
          decision: { ...decision, outcome: "already_assigned", code: "already_assigned", canAssign: false, needsConfirmation: true },
        };
      }
      throw e;
    }
    await progressToAssigned(input.tenantId, order.id, order.status as DeliveryOrderStatus, input.actorUserId);
    writeDeliveryAudit({
      tenantId: input.tenantId,
      action: "delivery.order.scanned",
      entityType: "DeliveryOrder",
      entityId: order.id,
      actorUserId: input.actorUserId,
      metadata: { driverId: input.driverId, clientOpId },
    });
    return { ok: true, orderId: order.id, decision };
  }

  // Reassignment path (explicit confirmation required).
  if (decision.outcome === "already_assigned" && order && input.confirmReassign) {
    await db.deliveryAssignment.update({
      where: { orderId: order.id },
      data: { driverId: input.driverId, clientOpId, runId: null },
    });
    writeDeliveryAudit({
      tenantId: input.tenantId,
      action: "delivery.order.reassigned",
      entityType: "DeliveryOrder",
      entityId: order.id,
      actorUserId: input.actorUserId,
      metadata: { toDriverId: input.driverId, clientOpId },
    });
    return {
      ok: true,
      orderId: order.id,
      decision: { ...decision, outcome: "assigned", code: "assigned", canAssign: true, message: "Order moved to your run." },
    };
  }

  // All non-assigning outcomes (wrong_tenant, wrong_store, invalid, duplicate, needs-confirm, …)
  return { ok: true, orderId: order?.id, decision };
}
