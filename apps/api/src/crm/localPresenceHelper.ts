/**
 * CRM Local Presence — caller ID selection helper.
 *
 * IMPORTANT ARCHITECTURE NOTE:
 * Calls in this platform are placed client-side via WebRTC/SIP (JsSIP in useSipPhone.ts).
 * The PBX (VitalPBX/Asterisk) controls the actual outbound SIP caller ID per extension.
 * This helper is ADVISORY ONLY — it selects the best tenant-owned DID for a destination
 * but does NOT place or modify any call. The caller ID is returned to the UI for display
 * and logging; it does not currently change the actual SIP caller ID without PBX config.
 *
 * Safety guarantees:
 * - Only returns PhoneNumber rows that belong to the same tenantId (double-checked).
 * - Never throws — all errors are caught and undefined is returned.
 * - If localPresenceEnabled is false on CrmTenantSettings, always returns undefined.
 * - If no area code match found, returns undefined (caller falls back to default).
 */

import { db } from "@connect/db";

/**
 * Normalize a raw phone number string to a 10-digit US number (no +1 prefix).
 * Returns null if the input cannot be parsed as a 10-digit US number.
 */
export function normalizeToE164Us(raw: string): string | null {
  // Strip all non-digits
  const digits = raw.replace(/\D/g, "");
  // Accept 10-digit (1234567890) or 11-digit with leading 1 (11234567890)
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits[0] === "1") return digits.slice(1);
  return null;
}

/**
 * Extract the 3-digit US area code from a normalized 10-digit number.
 * Returns null if the input is not a valid 10-digit number.
 */
export function extractAreaCode3(normalized10: string): string | null {
  if (!/^\d{10}$/.test(normalized10)) return null;
  return normalized10.slice(0, 3);
}

/**
 * Select the best CRM caller ID for a given destination number.
 *
 * @param tenantId   - The tenant requesting the caller ID
 * @param destinationNumber - The number being dialed (any format)
 * @returns E.164 phone number string (e.g. "+15125551234") or undefined if no match
 *
 * Returns undefined when:
 *  - localPresenceEnabled is false for the tenant
 *  - No CrmCallerIdPool entry matches the destination area code
 *  - The matched PhoneNumber does not belong to the same tenant (safety check)
 *  - Any DB error occurs
 *  - The destination is not a parseable US number
 */
export async function selectCrmCallerId(
  tenantId: string,
  destinationNumber: string,
): Promise<string | undefined> {
  try {
    // 1. Check if local presence is enabled for this tenant
    const settings = await (db as any).crmTenantSettings.findUnique({
      where: { tenantId },
      select: { localPresenceEnabled: true },
    });
    if (!settings?.localPresenceEnabled) return undefined;

    // 2. Normalize the destination to a 10-digit US number
    const normalized = normalizeToE164Us(destinationNumber);
    if (!normalized) return undefined;

    // 3. Extract the 3-digit area code
    const areaCode3 = extractAreaCode3(normalized);
    if (!areaCode3) return undefined;

    // 4. Find an active pool entry matching the area code
    const poolEntry = await (db as any).crmCallerIdPool.findFirst({
      where: {
        tenantId,
        areaCode3,
        isActive: true,
      },
      include: {
        phoneNumber: {
          select: { id: true, tenantId: true, phoneNumber: true, status: true },
        },
      },
      orderBy: { createdAt: "asc" }, // deterministic: oldest entry wins ties
    });

    if (!poolEntry) return undefined;

    // 5. Belt-and-suspenders: verify the PhoneNumber belongs to this tenant
    // This prevents any hypothetical FK bypass from leaking another tenant's DID.
    if (
      !poolEntry.phoneNumber ||
      poolEntry.phoneNumber.tenantId !== tenantId ||
      poolEntry.phoneNumber.status !== "ACTIVE"
    ) {
      return undefined;
    }

    // 6. Return in E.164 format
    const raw = String(poolEntry.phoneNumber.phoneNumber);
    // Ensure E.164: if already starts with +, use as-is; otherwise prepend +1 for US
    if (raw.startsWith("+")) return raw;
    const digits = raw.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits[0] === "1") return `+${digits}`;
    return raw; // passthrough for non-US numbers

  } catch {
    // Never throw — local presence failure must never block a call
    return undefined;
  }
}
