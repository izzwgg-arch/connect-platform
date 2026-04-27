import { db } from "@connect/db";

const SYSTEM_EXTENSION_NAME = /\b(pbx user|invite lifecycle|system|provision|smoke|test)\b/i;

export type BillingUsageSnapshot = {
  tenantId: string;
  extensionCount: number;
  phoneNumberCount: number;
  additionalPhoneNumberCount: number;
  smsEnabled: boolean;
  extensionIds: string[];
  phoneNumberIds: string[];
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
      select: { id: true },
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

  const phoneNumberCount = phoneNumbers.length;
  const includedNumbers = settings?.firstPhoneNumberFree === false ? 0 : 1;
  const smsEnabled =
    settings?.smsBillingEnabled ??
    Boolean(tenant?.smsSubscriptionRequired || tenant?.smsBillingEnforced || tenant?.smsSendMode === "LIVE");

  return {
    tenantId,
    extensionCount: billableExtensions.length,
    phoneNumberCount,
    additionalPhoneNumberCount: Math.max(0, phoneNumberCount - includedNumbers),
    smsEnabled,
    extensionIds: billableExtensions.map((ext: any) => ext.id),
    phoneNumberIds: phoneNumbers.map((number: any) => number.id),
  };
}
