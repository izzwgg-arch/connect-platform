// LoopCom Mobile audit helper — writes the existing tenant-scoped AuditLog.
// Same contract as delivery/audit.ts: an audit failure must never fail the
// operation it records. ⛔ `provider` is deliberately NOT set: it is the
// IntegrationProvider enum and has no telnyx/mobile member — an unknown value
// there makes Prisma reject the whole row (the delivery helper's "delivery"
// literal hits exactly that and its rows silently never land). The provider
// name lives in metadata instead.

import { db } from "@connect/db";

export interface MobileAuditInput {
  tenantId: string;
  action: string; // e.g. "mobile.line.suspend"
  entityType: string; // e.g. "MobileLine"
  entityId: string;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Fire-and-forget audit write. Never throws, never logs secrets. */
export function writeMobileAudit(input: MobileAuditInput): void {
  db.auditLog
    .create({
      data: {
        tenantId: input.tenantId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: input.actorUserId ?? null,
        metadata: ({ provider: "telnyx", ...(input.metadata ?? {}) }) as any,
      },
    })
    .catch(() => {
      /* audit is best-effort; do not surface */
    });
}

/** Awaitable variant for flows that must guarantee the audit row before responding. */
export async function writeMobileAuditSync(input: MobileAuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: input.actorUserId ?? null,
        metadata: ({ provider: "telnyx", ...(input.metadata ?? {}) }) as any,
      },
    });
  } catch {
    /* best-effort */
  }
}
