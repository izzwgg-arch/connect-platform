/**
 * Turns "this tenant is interrupted" into the exact set of PBX changes, and
 * back again when they pay. Pure: builds a plan, executes nothing.
 *
 * ⛔⛔ THE LEVER IS `ombu_ars_members.enabled`, NOT THE ROUTE.
 * `ombu_outbound_routes` has no enabled column, and a route can be referenced
 * by more than one tenant's route selection — switching the ROUTE off could
 * take out somebody else. Disabling the tenant's ARS *members* is per-tenant,
 * per-profile and precisely reversible.
 *
 * ⛔ EVERY PROFILE, NOT JUST THE FIRST. Several customers run multiple
 * businesses off one account, each an outbound profile with its own caller ID
 * (Trust Bookkeepings has 9, A plus center 4, Displaydex 3). An extension is
 * assigned ONE profile, so disabling only the first leaves most of their
 * extensions dialling out normally.
 *
 * ⛔ 911 IS NOT HANDLED HERE AND MUST NOT BE. Emergency calls are matched by
 * VitalPBX's native `T<n>_emergency-calls` context, which the dialplan reaches
 * BEFORE it reads the outbound profile — proven live 2026-08-17, each number
 * ending in `Gosub(trk-<id>)` straight to the trunk. So emergency dialling is
 * unaffected by everything in this file, by construction rather than by a
 * carve-out somebody has to remember to maintain.
 */

export type ArsMemberRef = {
  /** `ombu_ars.ars_id` — the outbound profile. */
  arsId: string;
  /** `ombu_ars_members.outbound_route_id`. */
  outboundRouteId: string;
  /** Current state, as read from the panel form ("1" / "0"). */
  enabled: boolean;
  /** `ombu_ars_members.sort` — preserved so the order never shifts. */
  sort: number;
};

export type InboundRouteRef = {
  id: number;
  did: string;
  /** True when the route already points at the Connect doorway. */
  pointsAtConnectDoorway: boolean;
};

export type InterruptionPlan = {
  /** Members to switch off, across every profile. */
  disable: ArsMemberRef[];
  /** Members already off — left alone, and NOT recorded for restore. */
  alreadyDisabled: ArsMemberRef[];
  /** Profiles touched, so the caller knows how many form posts to make. */
  arsIds: string[];
  /** Inbound routes needing a re-point so Connect can answer them busy. */
  repointInboundToDoorway: InboundRouteRef[];
  /** Inbound routes Connect already answers. */
  inboundHandledInConnect: InboundRouteRef[];
};

export type RestorePlan = {
  /** Exactly what we disabled — nothing else. */
  enable: Array<{ arsId: string; outboundRouteId: string }>;
  arsIds: string[];
  restoreInbound: InboundRouteRef[];
};

export class NothingToInterruptError extends Error {
  constructor() {
    super("Refusing to interrupt: this tenant has no enabled outbound members, so there is nothing to switch off.");
    this.name = "NothingToInterruptError";
  }
}

/**
 * What must change to interrupt this tenant.
 * @throws NothingToInterruptError when there is nothing enabled — better to
 *   report that than to record an empty interruption and later "restore" it.
 */
export function buildInterruptionPlan(params: {
  members: ArsMemberRef[];
  inboundRoutes: InboundRouteRef[];
}): InterruptionPlan {
  const disable = params.members.filter((m) => m.enabled);
  if (disable.length === 0) throw new NothingToInterruptError();

  return {
    disable,
    // ⛔ A member the customer had already switched off is not ours to restore.
    alreadyDisabled: params.members.filter((m) => !m.enabled),
    arsIds: [...new Set(disable.map((m) => m.arsId))],
    repointInboundToDoorway: params.inboundRoutes.filter((r) => !r.pointsAtConnectDoorway),
    inboundHandledInConnect: params.inboundRoutes.filter((r) => r.pointsAtConnectDoorway),
  };
}

/** What must change to put the tenant back exactly as they were. */
export function buildRestorePlan(params: {
  /** Recorded when service was switched off. */
  disabledMembers: Array<{ arsId: string; outboundRouteId: string }>;
  repointedInbound: InboundRouteRef[];
}): RestorePlan {
  return {
    enable: params.disabledMembers,
    arsIds: [...new Set(params.disabledMembers.map((m) => m.arsId))],
    restoreInbound: params.repointedInbound,
  };
}

/**
 * Flip the enabled flag on the named members. Input order is preserved — this
 * only changes flags.
 *
 * ⛔ It does NOT sort. `sort` is per-profile, so ordering a list that spans
 * profiles by `sort` alone interleaves them. Use `membersForProfile` to get
 * one profile's rows in their real order before posting.
 */
export function applyEnabledState(
  members: ArsMemberRef[],
  change: { arsId: string; outboundRouteIds: Set<string>; enabled: boolean },
): ArsMemberRef[] {
  return members.map((m) =>
    m.arsId === change.arsId && change.outboundRouteIds.has(m.outboundRouteId)
      ? { ...m, enabled: change.enabled }
      : m,
  );
}

/**
 * One profile's members, in the order the panel expects them back.
 * The ARS form is a full replace: anything left out of the post is deleted,
 * so this must return every member of that profile, not just changed ones.
 */
export function membersForProfile(members: ArsMemberRef[], arsId: string): ArsMemberRef[] {
  return members.filter((m) => m.arsId === arsId).sort((a, b) => a.sort - b.sort);
}

/**
 * What a caller hears on an interrupted tenant's number.
 * Busy, not the IVR, and never dead air — dead air is indistinguishable from
 * an outage, which is exactly what the forward-save incident looked like.
 */
export const INTERRUPTED_INBOUND_TREATMENT = "busy" as const;

export function inboundTreatmentFor(params: { interrupted: boolean }): "busy" | "normal" {
  return params.interrupted ? INTERRUPTED_INBOUND_TREATMENT : "normal";
}
