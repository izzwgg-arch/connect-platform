/**
 * The contract between the half that PREPARES a billable change (apps/agent)
 * and the half that APPLIES it (apps/api).
 *
 * ⛔ The hash inputs below are the whole reason an approval for one thing can
 * never be spent on another. If the two sides ever disagree about the exact
 * string, every prepared action stops applying — so they are defined once,
 * here, and both sides import them. (The hashing itself is
 * `chatPermissionGrantHash.ts`: `node:crypto`, subpath import only.)
 *
 * No `node:crypto` in this file — it is re-exported from the package root,
 * which the portal bundles for the browser.
 */

export const ADD_EXTENSION_CAPABILITY_ID = "action.add_extension";
export const ENABLE_SMS_CAPABILITY_ID = "action.enable_sms";
export const ADD_PHONE_NUMBER_CAPABILITY_ID = "action.add_phone_number";

/** Whose inbox a newly-activated texting number lands in. */
export type SmsInboxScope = "everyone" | "shared_with" | "one_person";
export const SMS_INBOX_SCOPES: SmsInboxScope[] = ["everyone", "shared_with", "one_person"];

/**
 * ⛔ EXACTLY three digits — a billing rule as much as a dialplan one.
 * `calculateTenantBillingUsage` counts billable extensions with /^\d{3}$/, so a
 * 2- or 4-digit extension works on the phone and is never charged for. The same
 * family of bug already made 1-digit extensions invisible platform-wide.
 */
export function isBillableExtensionNumber(n: unknown): boolean {
  return /^\d{3}$/.test(String(n ?? "").trim());
}

export function addExtensionHashInput(
  tenantId: string,
  p: { extensionNumber: string; email: string },
): string {
  return `add_extension|${tenantId}|${String(p.extensionNumber).trim()}|${String(p.email).trim().toLowerCase()}`;
}

export function enableSmsHashInput(
  tenantId: string,
  p: { scope: SmsInboxScope; userIds: string[] },
): string {
  return `enable_sms|${tenantId}|${p.scope}|${[...p.userIds].sort().join(",")}`;
}

export function addPhoneNumberHashInput(
  tenantId: string,
  p: { did: string },
): string {
  return `add_phone_number|${tenantId}|${String(p.did).replace(/\D/g, "")}`;
}
