import { z } from "zod";

/**
 * Pure organization decisions — no db, no I/O. Routes fetch rows and apply
 * these; nothing here re-derives a rule that already lives elsewhere.
 */

export const ORG_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type OrgDay = (typeof ORG_DAYS)[number];
export type OrgHours = Partial<Record<OrgDay, [string, string] | "closed">>;

const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h).");
const dayHours = z.union([z.literal("closed"), z.tuple([timeStr, timeStr])]);
export const orgHoursSchema = z.object({
  sun: dayHours.optional(),
  mon: dayHours.optional(),
  tue: dayHours.optional(),
  wed: dayHours.optional(),
  thu: dayHours.optional(),
  fri: dayHours.optional(),
  sat: dayHours.optional(),
});

/** Fields a member with org.edit_page may change on the org record. */
export const ORG_EDITABLE_FIELDS = [
  "displayName",
  "legalName",
  "industry",
  "size",
  "foundedYear",
  "website",
  "domain",
  "phone",
  "smsNumber",
  "whatsappNumber",
  "email",
  "description",
  "serviceArea",
  "hours",
  "acceptsRfqs",
  "showPhone",
  "showEmail",
  "showWhatsapp",
  "openMessages",
  "searchEngineVisible",
] as const;

/** True when at least one OTHER membership in the same org still holds OWNER. */
export function hasAnotherOwner(memberships: Array<{ personId: string; role: string }>, excludingPersonId: string): boolean {
  return memberships.some((m) => m.role === "OWNER" && m.personId !== excludingPersonId);
}

/** Which contact channels the page is willing to show, respecting the toggles. */
export function visibleContact(org: { phone: string | null; email: string | null; whatsappNumber: string | null; smsNumber: string | null; showPhone: boolean; showEmail: boolean; showWhatsapp: boolean }) {
  return {
    phone: org.showPhone ? org.phone : null,
    email: org.showEmail ? org.email : null,
    whatsapp: org.showWhatsapp ? (org.whatsappNumber ?? org.smsNumber ?? org.phone) : null,
  };
}

/** loopcom-verify=<orgId> found among the domain's TXT records? */
export function txtRecordsProveDomain(records: string[][], organizationId: string): boolean {
  const want = `loopcom-verify=${organizationId}`;
  return records.some((chunks) => chunks.join("").trim() === want);
}

export function domainInstructions(domain: string, organizationId: string): string {
  return `Add a TXT record to ${domain}: loopcom-verify=${organizationId}. DNS can take up to an hour to update — then recheck.`;
}

/** Email's domain, lowercase, or null. */
export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? "").lastIndexOf("@");
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null;
}
