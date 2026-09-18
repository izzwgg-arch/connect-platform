/**
 * Pure moderation policy — routes fetch rows, this decides what they mean.
 * Nothing here touches the database.
 */

export type ReportReasonKind =
  | "SPAM"
  | "SCAM"
  | "HARASSMENT"
  | "IMPERSONATION"
  | "PHISHING"
  | "MALWARE"
  | "FAKE_JOB"
  | "FAKE_COMPANY"
  | "FAKE_REVIEW"
  | "BOT"
  | "MASS_SOLICITATION"
  | "OTHER";

const HIGH = new Set(["SCAM", "PHISHING", "MALWARE"]);
const MEDIUM = new Set(["IMPERSONATION", "FAKE_JOB", "FAKE_COMPANY", "MASS_SOLICITATION"]);

/** Ban-worthy reasons surface first in the queue; used for the severity stripe. */
export function caseSeverity(reason: string): "high" | "medium" | "low" {
  if (HIGH.has(reason)) return "high";
  if (MEDIUM.has(reason)) return "medium";
  return "low";
}

/** Target types the moderation queue knows how to resolve to a title + href. */
export const MODERATION_TARGET_TYPES = ["person", "organization", "post", "comment", "message", "job", "listing", "rfq", "event", "group"] as const;
export type ModerationTargetType = (typeof MODERATION_TARGET_TYPES)[number];

/** Content kinds REMOVE_CONTENT can actually soft-delete/close, given the schema. */
export const REMOVABLE_TARGET_TYPES = ["post", "comment", "message", "listing", "job", "opportunity", "rfq"] as const;

export type OrgVisibilityRow = { status: string };

/** A suspended/banned company disappears from every public surface — never a 403, always a 404 (absence and refusal share the shape). */
export function isOrgVisible(org: OrgVisibilityRow | null | undefined): boolean {
  if (!org) return false;
  return org.status !== "SUSPENDED" && org.status !== "BANNED";
}

/**
 * Progressive outreach restriction: a second RESTRICT_OUTREACH action (ACTIONED)
 * against the same subject within 90 days doubles the previous restriction's
 * day count. First restriction uses the moderator-chosen `requestedDays`.
 */
export function restrictionDaysFor(requestedDays: number, priorRestrictDaysWithin90d: number | null): number {
  const base = Math.max(1, Math.floor(requestedDays || 7));
  if (priorRestrictDaysWithin90d && priorRestrictDaysWithin90d > 0) {
    return priorRestrictDaysWithin90d * 2;
  }
  return base;
}

export function daysToMs(days: number): number {
  return days * 24 * 3600 * 1000;
}

/** Human sentence a restricted/suspended/banned person sees, built from the moderator's note. */
export function subjectMessage(kind: string, userMessage: string | null | undefined, days?: number | null): string {
  if (userMessage && userMessage.trim()) return userMessage.trim();
  switch (kind) {
    case "WARN":
      return "A moderator reviewed something on your account and issued a warning.";
    case "RESTRICT_OUTREACH":
      return days ? `You can't send connection requests or messages to new people for ${days} days.` : "You can't send connection requests or messages to new people for a while.";
    case "SUSPEND":
      return "Your account is temporarily suspended.";
    case "BAN":
      return "Your account has been banned.";
    default:
      return "A moderator took action on your account.";
  }
}
