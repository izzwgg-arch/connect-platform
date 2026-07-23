// Delivery audit helper — writes to the existing AuditLog model.
// Non-blocking by default (mirrors the CRM timeline helper): audit failures must
// never fail the primary operation.

import { db } from "@connect/db";

export interface DeliveryAuditInput {
  tenantId: string;
  action: string; // e.g. "delivery.order.transition"
  entityType: string; // e.g. "DeliveryOrder"
  entityId: string;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Fire-and-forget audit write. Never throws. */
export function writeDeliveryAudit(input: DeliveryAuditInput): void {
  db.auditLog
    .create({
      data: {
        tenantId: input.tenantId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: input.actorUserId ?? null,
        provider: "delivery",
        metadata: (input.metadata ?? {}) as any,
      },
    })
    .catch(() => {
      /* audit is best-effort; do not surface */
    });
}

/** Awaitable variant for flows that must guarantee the audit row before responding. */
export async function writeDeliveryAuditSync(input: DeliveryAuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: input.actorUserId ?? null,
        provider: "delivery",
        metadata: (input.metadata ?? {}) as any,
      },
    });
  } catch {
    /* best-effort */
  }
}
