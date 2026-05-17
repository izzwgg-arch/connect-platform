import { db } from "@connect/db";
import { splitPhoneNumbersByKind } from "./billingPhoneNumbers";

const SYSTEM_EXTENSION_NAME = /\b(pbx user|invite lifecycle|system|provision|smoke|test)\b/i;

export type BillingUsageSnapshot = {
  tenantId: string;
  extensionCount: number;
  /** All active DIDs (local + toll-free). */
  phoneNumberCount: number;
  /** Active local (non–toll-free) DIDs. */
  localPhoneNumberCount: number;
  /** Active toll-free DIDs (NANP NPA detection). */
  tollFreePhoneNumberCount: number;
  /** Billable local DIDs after first-number-free (toll-free excluded). */
  localBillablePhoneNumberCount: number;
  /** Billable toll-free DIDs (all active toll-free; no first-free). */
  tollFreeBillablePhoneNumberCount: number;
  /**
   * Sum of local + toll-free billable counts (legacy field name).
   * Prefer `localBillablePhoneNumberCount` + `tollFreeBillablePhoneNumberCount`.
   */
  additionalPhoneNumberCount: number;
  smsEnabled: boolean;
  extensionIds: string[];
  phoneNumberIds: string[];
  localPhoneNumberIds: string[];
  tollFreePhoneNumberIds: string[];
};

export async function calculateTenantBillingUsage(
  tenantId: string,
  settings?: { firstPhoneNumberFree?: boolean | null; smsBillingEnabled?: boolean | null },
): Promise<BillingUsageSnapshot> {
  const [extensions, phoneNumbers, tenant] = await Promise.all([
    (db as any).extension.findMany({
      where: { tenantId, status: "ACTIVE", billable: true },
      select: { id: true, extNumber: true, displayName: true },
    }),
    (db as any).phoneNumber.findMany({
      where: { tenantId, status: "ACTIVE" },
      select: { id: true, phoneNumber: true },
    }),
    (db as any).tenant.findUnique({
      where: { id: tenantId },
      select: { smsSubscriptionRequired: true, smsBillingEnforced: true, smsSendMode: true },
    }),
  ]);

  const billableExtensions = extensions.filter((ext: any) => {
    const number = String(ext.extNumber || "").trim();
    const name = String(ext.displayName || "").trim();
    return /^\d{3}$/.test(number) && !SYSTEM_EXTENSION_NAME.test(name);
  });

  const { local, tollFree } = splitPhoneNumbersByKind(
    phoneNumbers.map((n: { id: string; phoneNumber: string }) => ({ id: n.id, phoneNumber: n.phoneNumber })),
  );

  const localPhoneNumberCount = local.length;
  const tollFreePhoneNumberCount = tollFree.length;
  const phoneNumberCount = localPhoneNumberCount + tollFreePhoneNumberCount;
  const includedLocalFree = settings?.firstPhoneNumberFree === false ? 0 : 1;
  const localBillablePhoneNumberCount = Math.max(0, localPhoneNumberCount - includedLocalFree);
  const tollFreeBillablePhoneNumberCount = tollFreePhoneNumberCount;
  const additionalPhoneNumberCount = localBillablePhoneNumberCount + tollFreeBillablePhoneNumberCount;

  const smsEnabled =
    settings?.smsBillingEnabled ??
    Boolean(tenant?.smsSubscriptionRequired || tenant?.smsBillingEnforced || tenant?.smsSendMode === "LIVE");

  return {
    tenantId,
    extensionCount: billableExtensions.length,
    phoneNumberCount,
    localPhoneNumberCount,
    tollFreePhoneNumberCount,
    localBillablePhoneNumberCount,
    tollFreeBillablePhoneNumberCount,
    additionalPhoneNumberCount,
    smsEnabled,
    extensionIds: billableExtensions.map((ext: any) => ext.id),
    phoneNumberIds: phoneNumbers.map((number: any) => number.id),
    localPhoneNumberIds: local.map((n) => n.id),
    tollFreePhoneNumberIds: tollFree.map((n) => n.id),
  };
}
