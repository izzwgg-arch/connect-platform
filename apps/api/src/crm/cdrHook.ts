import { db } from "@connect/db";

/**
 * CRM CDR hook — Phase 2A.
 *
 * Called fire-and-forget (no await) after a ConnectCdr upsert succeeds in
 * /internal/cdr-ingest. Writes CRM timeline events for CRM-enrolled contacts
 * matched by phone number.
 *
 * HARD RULES:
 *   - Never throw — all errors caught internally.
 *   - Never block CDR ingest — caller must NOT await this.
 *   - If CRM disabled, returns immediately.
 *   - If no CRM-enrolled contact matches, does nothing.
 *   - No duplicate timeline events for same contact + CDR linkedId + type.
 */

export interface CdrHookParams {
  linkedId: string;
  tenantId: string;
  fromNumber: string | null;
  toNumber: string | null;
  direction: string; // "incoming" | "outgoing" | "internal" | "unknown"
  disposition: string;
  durationSec: number;
  talkSec: number;
  recordingAvailable: boolean;
  startedAt: Date;
}

/**
 * Normalise a phone number to digits only, returning multiple candidate variants
 * to handle both 10-digit (US local) and 11-digit (+1 prefixed) formats.
 */
function phoneCandidates(raw: string | null): string[] {
  if (!raw) return [];
  const digits = raw.replace(/\D/g, "");
  if (!digits) return [];
  const result = [digits];
  // If 11 digits starting with "1", also include the 10-digit form
  if (digits.length === 11 && digits.startsWith("1")) result.push(digits.slice(1));
  // If 10 digits, also include the 11-digit form with leading "1"
  if (digits.length === 10) result.push("1" + digits);
  return [...new Set(result)];
}

export async function fireCrmCdrHook(params: CdrHookParams): Promise<void> {
  try {
    const { linkedId, tenantId, fromNumber, toNumber, direction, disposition, durationSec, talkSec, recordingAvailable, startedAt } = params;

    // Skip internal extension-to-extension calls — not CRM-relevant
    if (direction === "internal") return;

    // Check CRM tenant settings — bail early if CRM is disabled
    const settings = await (db as any).crmTenantSettings.findUnique({
      where: { tenantId },
      select: { enabled: true },
    });
    if (!settings?.enabled) return;

    // Build phone number candidates for matching
    const fromCandidates = phoneCandidates(fromNumber);
    const toCandidates = phoneCandidates(toNumber);
    const allCandidates = [...new Set([...fromCandidates, ...toCandidates])];
    if (allCandidates.length === 0) return;

    // Find CRM-enrolled contacts matched by any of the phone number variants
    const matchedPhones = await (db as any).contactPhone.findMany({
      where: {
        numberNormalized: { in: allCandidates },
        contact: {
          tenantId,
          crmMeta: { isNot: null }, // only CRM-enrolled contacts
        },
      },
      select: {
        contactId: true,
        contact: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (matchedPhones.length === 0) return;

    // Deduplicate matched contacts (same contact may have multiple phone variants)
    const seenContactIds = new Set<string>();
    const uniqueContacts: Array<{ contactId: string; displayName: string }> = [];
    for (const p of matchedPhones) {
      if (!seenContactIds.has(p.contactId)) {
        seenContactIds.add(p.contactId);
        const fn = p.contact.firstName ?? "";
        const ln = p.contact.lastName ?? "";
        const displayName = [fn, ln].filter(Boolean).join(" ").trim() || "Contact";
        uniqueContacts.push({ contactId: p.contactId, displayName });
      }
    }

    // Determine timeline event type from direction
    const eventType: "CDR_INBOUND" | "CDR_OUTBOUND" =
      direction === "outgoing" ? "CDR_OUTBOUND" : "CDR_INBOUND";

    const label = direction === "outgoing" ? "Outbound call" : "Inbound call";
    const dispLabel = disposition === "answered" ? "answered"
      : disposition === "missed" ? "missed"
      : disposition === "busy" ? "busy"
      : disposition === "canceled" ? "canceled"
      : disposition === "failed" ? "failed"
      : disposition;
    const durationLabel = talkSec > 0
      ? `${Math.floor(talkSec / 60)}m ${talkSec % 60}s`
      : durationSec > 0 ? `${durationSec}s` : "";

    for (const { contactId, displayName } of uniqueContacts) {
      try {
        // Idempotency guard — belt-and-suspenders alongside the partial unique index
        const existing = await (db as any).crmTimelineEvent.findFirst({
          where: { contactId, linkedId, type: eventType },
          select: { id: true },
        });
        if (existing) continue;

        const title = `${label} · ${dispLabel}${durationLabel ? " · " + durationLabel : ""}`;

        const otherNumber = eventType === "CDR_INBOUND" ? fromNumber : toNumber;
        const body = otherNumber ? otherNumber : undefined;

        const metadata: Record<string, unknown> = {
          direction,
          fromNumber: fromNumber ?? null,
          toNumber: toNumber ?? null,
          durationSec,
          talkSec,
          disposition,
          recordingAvailable,
          cdrLinkedId: linkedId,
        };

        // Write timeline event — using upsert-style with unique index for final safety
        try {
          await (db as any).crmTimelineEvent.create({
            data: {
              tenantId,
              contactId,
              type: eventType,
              title,
              body: body ?? null,
              metadata,
              linkedId,
            },
          });
        } catch (createErr: any) {
          // Unique constraint violation (P2002) means a duplicate — acceptable, skip
          if (createErr?.code === "P2002") continue;
          throw createErr;
        }

        // Update CrmContactMeta.lastActivityAt
        await (db as any).crmContactMeta.updateMany({
          where: { contactId, tenantId },
          data: { lastActivityAt: startedAt },
        });
      } catch (contactErr: any) {
        console.error("[CRM][cdrHook] Failed to write timeline for contact", {
          contactId,
          linkedId,
          err: contactErr?.message,
        });
        // Continue to next contact — never let one failure block others
      }
    }
  } catch (err: any) {
    // Top-level catch — CDR ingest must NEVER be affected by CRM errors
    console.error("[CRM][cdrHook] Unexpected error — CDR ingest unaffected", {
      linkedId: params.linkedId,
      err: err?.message,
    });
  }
}
