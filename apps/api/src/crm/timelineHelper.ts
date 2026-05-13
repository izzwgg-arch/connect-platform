import { db } from "@connect/db";

// ── Types ──────────────────────────────────────────────────────────────────────

export type TimelineEventType =
  | "CONTACT_CREATED"
  | "STAGE_CHANGED"
  | "NOTE_ADDED"
  | "NOTE_EDITED"
  | "TASK_CREATED"
  | "TASK_COMPLETED"
  | "TASK_CANCELED"
  | "CDR_INBOUND"
  | "CDR_OUTBOUND"
  | "CHECKLIST_COMPLETED"
  | "DISPOSITION_SET"
  | "CONTACT_MERGED"
  | "ASSIGNED_TO_USER";

export type WriteTimelineEventInput = {
  tenantId: string;
  contactId: string;
  type: TimelineEventType;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
  /** External row ID — e.g. CrmContactNote.id or ConnectCdr.id */
  linkedId?: string | null;
  createdByUserId?: string | null;
};

// ── Helper ─────────────────────────────────────────────────────────────────────

/**
 * Writes a CrmTimelineEvent row. Non-throwing: logs the error and continues on failure.
 * Timeline events are informational — a write failure must never break the primary operation.
 */
export async function writeTimelineEvent(input: WriteTimelineEventInput): Promise<void> {
  try {
    await (db as any).crmTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        contactId: input.contactId,
        type: input.type,
        title: input.title,
        body: input.body ?? null,
        metadata: input.metadata ?? null,
        linkedId: input.linkedId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      },
    });
  } catch (err) {
    // Never let a timeline write crash the parent operation
    console.error("[CRM][timeline] Failed to write event", { type: input.type, contactId: input.contactId, err });
  }
}

/**
 * Updates the body of a timeline event linked to a specific note.
 * Used when a note is edited so the timeline record stays in sync.
 * Non-throwing.
 */
export async function updateLinkedTimelineBody(
  linkedId: string,
  type: "NOTE_ADDED" | "NOTE_EDITED",
  body: string,
): Promise<void> {
  try {
    await (db as any).crmTimelineEvent.updateMany({
      where: { linkedId, type },
      data: { body },
    });
  } catch (err) {
    console.error("[CRM][timeline] Failed to update linked event body", { linkedId, type, err });
  }
}
