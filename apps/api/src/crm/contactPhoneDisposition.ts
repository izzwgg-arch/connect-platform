/** Phone-level CRM disposition helpers (pure + DB load). */

export type CrmDispositionChannel = "CALL" | "SMS" | "EMAIL" | "VOICEMAIL_DROP";

export type PhoneDispositionRow = {
  phoneId: string | null;
  disposition: string;
  channel: CrmDispositionChannel | string;
  note: string | null;
  createdAt: Date;
  createdByUserId: string;
};

export type LatestPhoneDisposition = {
  disposition: string;
  channel: CrmDispositionChannel | string;
  note: string | null;
  createdAt: Date;
  createdByUserId: string;
};

/** Latest disposition per phoneId (ignores rows without phoneId). */
export function mergeLatestPhoneDispositions(
  rows: PhoneDispositionRow[],
): Map<string, LatestPhoneDisposition> {
  const map = new Map<string, LatestPhoneDisposition>();
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const row of sorted) {
    if (!row.phoneId || map.has(row.phoneId)) continue;
    map.set(row.phoneId, {
      disposition: row.disposition,
      channel: row.channel,
      note: row.note,
      createdAt: row.createdAt,
      createdByUserId: row.createdByUserId,
    });
  }
  return map;
}

export async function loadLatestPhoneDispositionsForContact(
  db: any,
  tenantId: string,
  contactId: string,
): Promise<Map<string, LatestPhoneDisposition>> {
  const rows = await db.crmContactPhoneDisposition.findMany({
    where: { tenantId, contactId, phoneId: { not: null } },
    orderBy: { createdAt: "desc" },
    select: {
      phoneId: true,
      disposition: true,
      channel: true,
      note: true,
      createdAt: true,
      createdByUserId: true,
    },
  });
  return mergeLatestPhoneDispositions(rows as PhoneDispositionRow[]);
}

export function formatPhoneDispositionFields(
  phoneId: string,
  latest: LatestPhoneDisposition | undefined,
): {
  lastDisposition: string | null;
  lastDispositionAt: string | null;
  lastDispositionChannel: CrmDispositionChannel | string | null;
} {
  if (!latest) {
    return { lastDisposition: null, lastDispositionAt: null, lastDispositionChannel: null };
  }
  return {
    lastDisposition: latest.disposition,
    lastDispositionAt: latest.createdAt.toISOString(),
    lastDispositionChannel: latest.channel,
  };
}

export function buildDispositionTimelineMetadata(opts: {
  disposition: string;
  phoneId?: string | null;
  phoneType?: string | null;
  phoneNumber?: string | null;
  channel?: CrmDispositionChannel | null;
  note?: string | null;
  linkedId?: string | null;
  previousStage?: string | null;
  newStage?: string | null;
  hasNote?: boolean;
  hasFollowUp?: boolean;
}): Record<string, unknown> {
  return {
    disposition: opts.disposition,
    phoneId: opts.phoneId ?? null,
    phoneType: opts.phoneType ?? null,
    phoneNumber: opts.phoneNumber ?? null,
    channel: opts.channel ?? null,
    linkedId: opts.linkedId ?? null,
    previousStage: opts.previousStage ?? null,
    newStage: opts.newStage ?? null,
    hasNote: !!opts.hasNote,
    hasFollowUp: !!opts.hasFollowUp,
    note: opts.note?.trim() || null,
  };
}

export function dispositionTimelineTitle(opts: {
  disposition: string;
  phoneType?: string | null;
  channel?: CrmDispositionChannel | string | null;
}): string {
  const parts: string[] = [];
  if (opts.phoneType) parts.push(opts.phoneType);
  if (opts.channel) parts.push(String(opts.channel).replace(/_/g, " "));
  if (parts.length === 0) return `Disposition: ${opts.disposition}`;
  return `Disposition (${parts.join(" · ")}): ${opts.disposition}`;
}

export const CRM_DISPOSITION_CHANNELS = ["CALL", "SMS", "EMAIL", "VOICEMAIL_DROP"] as const;

export function isCrmDispositionChannel(value: string): value is CrmDispositionChannel {
  return (CRM_DISPOSITION_CHANNELS as readonly string[]).includes(value);
}
