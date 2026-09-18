import type { RelationshipKind } from "../../node_modules/.prisma/community-client/index.js";

/**
 * Pure graph-domain decisions that are not already in `policy/graph.ts`
 * (pairKey/degree/mutual/isBlockedEitherWay/sharesOrganization — routes
 * import those directly). Nothing here touches the database.
 */

/** Each kind's mirror on the other side. WORKED_WITH/PARTNER/REFERRED/MENTOR mirror themselves. */
export const RELATIONSHIP_COMPLEMENT: Record<RelationshipKind, RelationshipKind> = {
  CUSTOMER: "VENDOR",
  VENDOR: "CUSTOMER",
  PURCHASED_FROM: "SOLD_TO",
  SOLD_TO: "PURCHASED_FROM",
  WORKED_WITH: "WORKED_WITH",
  PARTNER: "PARTNER",
  REFERRED: "REFERRED",
  MENTOR: "MENTOR",
} as const;

export const RELATIONSHIP_FILTER_KIND: Record<string, RelationshipKind> = {
  customers: "CUSTOMER",
  vendors: "VENDOR",
  worked_with: "WORKED_WITH",
  referred: "REFERRED",
  partners: "PARTNER",
};

const IGNORED_COOLDOWN_MS = 30 * 24 * 3600 * 1000;

/** An IGNORED connection can only be re-requested 30 days after the ignore. */
export function ignoredCooldownOver(ignoredAt: Date, now = new Date()): boolean {
  return now.getTime() - ignoredAt.getTime() >= IGNORED_COOLDOWN_MS;
}

export function ignoredCooldownMessage(): string {
  return "This person ignored a request from you recently — you can try again 30 days after that.";
}

const DISMISS_COOLDOWN_MS = 90 * 24 * 3600 * 1000;
export function dismissedWithinCooldown(dismissedAt: Date, now = new Date()): boolean {
  return now.getTime() - dismissedAt.getTime() < DISMISS_COOLDOWN_MS;
}
