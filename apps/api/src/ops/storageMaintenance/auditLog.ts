import { randomUUID } from "node:crypto";
import type { StorageAuditEvent, StorageAuditEventType } from "./types";

const MAX_EVENTS = 200;
const events: StorageAuditEvent[] = [];

export function appendStorageAuditEvent(input: {
  type: StorageAuditEventType;
  actorUserId: string | null;
  scanId?: string | null;
  planId?: string | null;
  detail: string;
  metadata?: Record<string, unknown>;
}): StorageAuditEvent {
  const event: StorageAuditEvent = {
    id: randomUUID(),
    at: new Date().toISOString(),
    type: input.type,
    actorUserId: input.actorUserId,
    scanId: input.scanId ?? null,
    planId: input.planId ?? null,
    detail: input.detail,
    metadata: input.metadata,
  };
  events.unshift(event);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  return event;
}

export function listStorageAuditEvents(limit = 50): StorageAuditEvent[] {
  return events.slice(0, Math.max(1, Math.min(200, limit)));
}

export function clearStorageAuditEventsForTests(): void {
  events.length = 0;
}
