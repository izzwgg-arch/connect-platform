import type { OrgRole, RelationshipKind } from "../../node_modules/.prisma/community-client/index.js";

/**
 * Pure decisions for the introduction (referral) engine. Routes fetch rows
 * (connections, relationship tags, memberships, privacy settings) and hand
 * them here — nobody re-derives "is there a path" inline (CONVENTIONS §3).
 *
 * The rule that matters: a requester may only ask a MIDDLE who is their own
 * 1st-degree connection, and the middle's link to the target is only usable
 * as a path when it is ALREADY a discoverable/public signal — never a hidden
 * relationship. Three kinds of discoverable evidence:
 *   (a) middle → target PERSON is an ACTIVE connection, and the target has
 *       chosen to make their connections list PUBLIC (the CONNECTIONS
 *       default hides this — so this path only exists when the target opted in).
 *   (b) middle holds a MUTUAL RelationshipTag with the target ORG
 *       (CUSTOMER/VENDOR/WORKED_WITH/PARTNER) — mutual tags are a two-sided,
 *       already-public signal by design.
 *   (c) middle holds a VERIFIED membership (VERIFIED_ADMIN/VERIFIED_DOMAIN)
 *       at the target ORG.
 * Anything else (e.g. a private 1st-degree connection alone) yields no path.
 */

export type IntroHow = "knows the owner" | "verified customer of" | "works at" | "connected to";
export type IntroStrength = 1 | 2 | 3;

export type IntroEvidence =
  | { kind: "public_connection" }
  | { kind: "mutual_org_tag"; tagKind: RelationshipKind }
  | { kind: "verified_membership"; role: OrgRole };

/** Kinds whose mutuality is treated as a discoverable "does business with" signal. */
export const MUTUAL_TAG_KINDS: RelationshipKind[] = ["CUSTOMER", "VENDOR", "WORKED_WITH", "PARTNER"];

/** Affiliation values that count as a verified (not just claimed) membership. */
export const VERIFIED_AFFILIATIONS = ["VERIFIED_ADMIN", "VERIFIED_DOMAIN"] as const;

/** Open (undecided-or-live) IntroRequest statuses — a second ask for the same triple is blocked while one of these stands. */
export const OPEN_INTRO_STATUSES = ["REQUESTED", "APPROVED"] as const;
export function isOpenIntroStatus(status: string): boolean {
  return (OPEN_INTRO_STATUSES as readonly string[]).includes(status);
}

/** Maps one piece of evidence to the plain-English "how" shown to the requester, and its confidence (1 lowest, 3 highest). */
export function describeEvidence(evidence: IntroEvidence): { how: IntroHow; strength: IntroStrength } {
  switch (evidence.kind) {
    case "public_connection":
      return { how: "connected to", strength: 1 };
    case "mutual_org_tag":
      return { how: "verified customer of", strength: 3 };
    case "verified_membership":
      return evidence.role === "OWNER" ? { how: "knows the owner", strength: 3 } : { how: "works at", strength: 2 };
  }
}

/** When a middle qualifies more than one way, only the strongest is shown. */
export function bestEvidence(candidates: IntroEvidence[]): IntroEvidence | null {
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestStrength = describeEvidence(best).strength;
  for (const c of candidates.slice(1)) {
    const s = describeEvidence(c).strength;
    if (s > bestStrength) {
      best = c;
      bestStrength = s;
    }
  }
  return best;
}

/** The deterministic line used before any AI draft exists, and as its fallback. Never invents facts. */
export function templateDraft(input: { requesterName: string; requesterHeadline?: string | null; targetName: string; message?: string | null }): string {
  const who = input.requesterHeadline ? `${input.requesterName} (${input.requesterHeadline})` : input.requesterName;
  const ask = input.message ? ` — ${input.message}` : "";
  return `Hi ${input.targetName}, I'd like to introduce ${who}${ask}`;
}
