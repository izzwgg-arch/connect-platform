import type { Db } from "../db.js";

export type AuditInput = {
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  organizationId?: string | null;
  before?: unknown;
  after?: unknown;
  source?: string;
  ip?: string | null;
};

/** Immutable-ish: rows are only ever inserted. Sensitive fields must be stripped by the caller. */
export async function audit(db: Db, input: AuditInput) {
  await db.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      organizationId: input.organizationId ?? null,
      before: input.before === undefined ? undefined : (input.before as object),
      after: input.after === undefined ? undefined : (input.after as object),
      source: input.source ?? "api",
      ip: input.ip ?? null,
    },
  });
}
