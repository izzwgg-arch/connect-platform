/**
 * Builds the two panel forms that give a customer emergency dialling:
 *
 *   1. an outbound route matching ONLY 911 and 845-783-1212, and
 *   2. that route appended to the customer's existing route selection (ARS).
 *
 * Pure — every function returns form pairs. Nothing here talks to the panel;
 * the provisioning driver does. Field names and shapes are the ones
 * `onboarding/pbxTenantBuild.ts` already uses in production, so this follows
 * the proven path rather than inventing a second one.
 *
 * ⛔ ONE ROUTE PER CUSTOMER, NOT ONE SHARED ROUTE. Each customer has their own
 * trunk (their own VoIP.ms subaccount), so a shared route would try to push
 * their emergency call down somebody else's trunk.
 *
 * ⛔⛔ THE CALLER ID IS SET PER CUSTOMER AND IS NOT OPTIONAL (Izzy, 2026-08-17).
 * 911 dispatch identifies the caller and their registered address from the
 * number presented. A blank one, or a shared Loopcom number, points the
 * ambulance at the wrong address. `resolveEmergencyCallerId` takes it from the
 * customer's OWN outbound route, and every builder here refuses to produce a
 * form without one.
 */

import { emergencyDialPatterns } from "./serviceInterruptionPlan";

/**
 * The panel's hidden template-row marker.
 * ⛔ Must stay identical to `PH` in `onboarding/pbxTenantBuild.ts`, which is a
 * module-local const there. `emergencyRouteBuilder.test.ts` reads that file's
 * source and fails if the two ever drift.
 */
export const PH = "{{row-count-placeholder}}";

/** Route description as it appears in the panel, per customer. */
export function emergencyRouteLabel(companyLabel: string): string {
  return `${companyLabel} — emergency only`;
}

export class EmergencyRouteInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmergencyRouteInputError";
  }
}

/** Digits of a usable North American caller ID, or null. */
function callerIdDigits(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

/**
 * Which number this customer's emergency calls present.
 *
 * Prefers the caller ID their normal outbound route already uses, because that
 * is the number their E911 record is registered against. Falls back to the
 * tenant's own DID. ⛔ Never falls back to a Loopcom number, and never returns
 * blank — it throws instead, so a customer cannot be given an emergency route
 * that misidentifies them.
 */
export function resolveEmergencyCallerId(input: {
  companyName: string;
  /** cid_number on the customer's existing outbound route. */
  existingRouteCidNumber?: string | null;
  /** cid_name on the customer's existing outbound route. */
  existingRouteCidName?: string | null;
  /** The tenant's own inbound DID, used only if the route carries no caller ID. */
  tenantDid?: string | null;
}): { cidNumber: string; cidName: string; source: "outbound_route" | "tenant_did" } {
  const fromRoute = callerIdDigits(input.existingRouteCidNumber);
  if (fromRoute) {
    return {
      cidNumber: fromRoute,
      cidName: input.existingRouteCidName?.trim() || input.companyName,
      source: "outbound_route",
    };
  }
  const fromDid = callerIdDigits(input.tenantDid);
  if (fromDid) {
    return { cidNumber: fromDid, cidName: input.companyName, source: "tenant_did" };
  }
  throw new EmergencyRouteInputError(
    `Refusing to build an emergency route for "${input.companyName}": no usable caller ID. ` +
      `911 dispatch reads the presented number to locate the caller, so this customer must be ` +
      `fixed by hand rather than given a route that misidentifies them.`,
  );
}

/**
 * The outbound route itself (panel class `trunk_group`).
 *
 * ⛔ `overwrite_cid` is "if_not_provided", matching the customer's normal
 * route: an extension's own caller ID wins when it has one, which is what lets
 * a desk phone present its own registered number to dispatch.
 */
export function buildEmergencyRoutePairs(input: {
  csrf: string;
  label: string;
  cidName: string;
  cidNumber: string;
  trunkId: string;
}): Array<[string, string]> {
  if (!callerIdDigits(input.cidNumber)) {
    throw new EmergencyRouteInputError(
      `Refusing to build an emergency route with caller ID "${input.cidNumber}".`,
    );
  }
  if (!input.trunkId) throw new EmergencyRouteInputError("Refusing to build an emergency route with no trunk.");
  if (!input.label.trim()) throw new EmergencyRouteInputError("Refusing to build an emergency route with no name.");

  const pairs: Array<[string, string]> = [
    ["class", "trunk_group"], ["method", "put"], ["mode", "add"], ["csfr_token", input.csrf],
    ["description", input.label], ["trklist[]", input.trunkId], ["pin_list_id", ""], ["csv", ""],
    ["cid_name", input.cidName], ["cid_number", input.cidNumber], ["overwrite_cid", "if_not_provided"],
    [`trkpattern[${PH}][prepend]`, ""], [`trkpattern[${PH}][prefix]`, ""], [`trkpattern[${PH}][pattern]`, ""], [`trkpattern[${PH}][cid_pattern]`, ""],
  ];

  // Exactly the emergency patterns and nothing else — no catch-all and no
  // 7-digit prepend rule, so this route can never carry an ordinary call even
  // while it is the only route left switched on.
  emergencyDialPatterns().forEach((pattern, i) => {
    pairs.push(
      [`trkpattern[${i}][prepend]`, ""],
      [`trkpattern[${i}][prefix]`, ""],
      [`trkpattern[${i}][pattern]`, pattern],
      [`trkpattern[${i}][cid_pattern]`, ""],
    );
  });

  pairs.push(["mod_dest", ""], ["destination", ""], ["destination_custom", ""]);
  return pairs;
}

export type ArsMember = {
  outboundRouteId: string;
  timeGroupId: string;
  enabled: string;
};

/**
 * Append the emergency route to an existing route selection.
 *
 * ⛔ THE EMERGENCY ROUTE GOES LAST — bottom of the list (Izzy, 2026-08-17).
 * Existing members keep their order and their enabled state exactly as found;
 * this only adds a row underneath them.
 */
export function buildArsAppendPairs(input: {
  csrf: string;
  arsId: string;
  description: string;
  existingMembers: ArsMember[];
  emergencyRouteId: string;
}): Array<[string, string]> {
  if (!input.emergencyRouteId) throw new EmergencyRouteInputError("No emergency route id to append.");
  if (!input.arsId) throw new EmergencyRouteInputError("No route selection to edit.");

  const already = input.existingMembers.some((m) => m.outboundRouteId === input.emergencyRouteId);
  const members = already
    ? input.existingMembers
    : [...input.existingMembers, { outboundRouteId: input.emergencyRouteId, timeGroupId: "", enabled: "1" }];

  const pairs: Array<[string, string]> = [
    ["class", "ars"], ["method", "put"], ["mode", "edit"], ["id", input.arsId],
    ["csfr_token", input.csrf], ["description", input.description],
    [`members[${PH}][outbound_route_id]`, ""], [`members[${PH}][time_group_id]`, ""], [`members[${PH}][enabled]`, "1"],
  ];
  members.forEach((m, i) => {
    pairs.push(
      [`members[${i}][outbound_route_id]`, m.outboundRouteId],
      [`members[${i}][time_group_id]`, m.timeGroupId],
      [`members[${i}][enabled]`, m.enabled],
    );
  });
  return pairs;
}

/** True when this ARS already carries the emergency route as its last member. */
export function arsHasEmergencyLast(members: ArsMember[], emergencyRouteId: string): boolean {
  if (members.length === 0) return false;
  return members[members.length - 1].outboundRouteId === emergencyRouteId;
}

/** Read the `members[N][...]` rows out of a parsed ARS edit form, in order. */
export function parseArsMembers(pairs: Array<[string, string]>): ArsMember[] {
  const byIndex = new Map<number, Partial<ArsMember>>();
  for (const [k, v] of pairs) {
    const m = /^members\[(\d+)\]\[(outbound_route_id|time_group_id|enabled)\]$/.exec(k);
    if (!m) continue; // skips the [PH] template row, which is what we want
    const i = Number(m[1]);
    const slot = byIndex.get(i) ?? {};
    if (m[2] === "outbound_route_id") slot.outboundRouteId = v;
    if (m[2] === "time_group_id") slot.timeGroupId = v;
    if (m[2] === "enabled") slot.enabled = v;
    byIndex.set(i, slot);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, s]) => ({
      outboundRouteId: s.outboundRouteId ?? "",
      timeGroupId: s.timeGroupId ?? "",
      enabled: s.enabled ?? "1",
    }))
    .filter((m) => m.outboundRouteId !== "");
}
