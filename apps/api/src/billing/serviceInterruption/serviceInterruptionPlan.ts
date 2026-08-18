/**
 * Turns "this tenant is interrupted" into the exact set of PBX changes, and
 * back again when they pay.
 *
 * Pure: builds and returns a plan, executes nothing. The caller applies it.
 *
 * ⛔⛔ THE EMERGENCY OUTBOUND ROUTE IS PERMANENT AND BELONGS TO EVERY CUSTOMER.
 * The owner's design (2026-08-17): a separate outbound route that matches
 * nothing but 911 and 845-783-1212 is attached to every account when the
 * account is created, and is NEVER deactivated. Interruption switches off all
 * the OTHER outbound routes; this one carries emergency calls out.
 *
 * That is what makes "deactivate all their outbound routes" and "911 always
 * works" both true at once. Taken literally, the first cancels the second —
 * 911 leaves the building through an outbound route, so switching every one of
 * them off would silently disconnect emergency calling for a customer who is
 * behind on a phone bill.
 *
 * ⛔ Therefore `buildInterruptionPlan` FAILS CLOSED: a tenant whose emergency
 * route is missing or switched off is NOT interrupted at all. Refusing to cut
 * someone off is recoverable; cutting off their 911 is not.
 */

import { EMERGENCY_ALLOWED_DESTINATIONS } from "./serviceInterruptionPolicy";

/** Name of the permanent per-customer outbound route. */
export const EMERGENCY_OUTBOUND_ROUTE_NAME = "connect-emergency-only";

/** Dial patterns the emergency route matches — and only these. */
export function emergencyDialPatterns(): string[] {
  const patterns: string[] = [];
  for (const d of EMERGENCY_ALLOWED_DESTINATIONS) {
    patterns.push(d);
    // North American dialling: some handsets send a leading 1.
    if (d.length === 10) patterns.push(`1${d}`);
  }
  return patterns;
}

/** The route every customer gets at creation. */
export function emergencyRouteSpec(): { name: string; patterns: string[]; neverDeactivate: true } {
  return { name: EMERGENCY_OUTBOUND_ROUTE_NAME, patterns: emergencyDialPatterns(), neverDeactivate: true };
}

export type OutboundRouteRef = {
  /** `ombu_outbound_routes` row id. */
  id: number;
  name: string;
  /** Whether the route is currently active on the PBX. */
  active: boolean;
};

export type InboundRouteRef = {
  /** `ombu_inbound_routes` row id. */
  id: number;
  did: string;
  /** True when the route already points at the Connect doorway. */
  pointsAtConnectDoorway: boolean;
};

export type InterruptionPlan = {
  /** Outbound routes to switch off. Never contains the emergency route. */
  deactivateOutbound: OutboundRouteRef[];
  /** The emergency route that is being left alone — recorded so the audit
   *  trail shows which route kept 911 alive. */
  emergencyRouteKept: OutboundRouteRef;
  /**
   * Inbound routes that must be re-pointed at the Connect doorway first,
   * because a call can only be answered with a busy signal once it reaches us.
   */
  repointInboundToDoorway: InboundRouteRef[];
  /** Inbound routes already on the doorway — Connect answers these itself. */
  inboundHandledInConnect: InboundRouteRef[];
};

export type RestorePlan = {
  reactivateOutbound: OutboundRouteRef[];
  restoreInbound: InboundRouteRef[];
};

export class EmergencyRouteMissingError extends Error {
  constructor(readonly reason: "absent" | "inactive") {
    super(
      `Refusing to interrupt this tenant: the ${EMERGENCY_OUTBOUND_ROUTE_NAME} outbound route is ` +
        `${reason}. Deactivating the remaining outbound routes would disconnect ` +
        `${EMERGENCY_ALLOWED_DESTINATIONS.join(" and ")}. Provision the emergency route first.`,
    );
    this.name = "EmergencyRouteMissingError";
  }
}

/** Find the tenant's permanent emergency route, if it has one. */
export function findEmergencyRoute(outboundRoutes: OutboundRouteRef[]): OutboundRouteRef | undefined {
  return outboundRoutes.find((r) => r.name === EMERGENCY_OUTBOUND_ROUTE_NAME);
}

/**
 * What must change on the PBX to interrupt this tenant.
 * @throws EmergencyRouteMissingError when 911 would be lost — see the header.
 */
export function buildInterruptionPlan(params: {
  outboundRoutes: OutboundRouteRef[];
  inboundRoutes: InboundRouteRef[];
}): InterruptionPlan {
  const emergency = findEmergencyRoute(params.outboundRoutes);
  if (!emergency) throw new EmergencyRouteMissingError("absent");
  if (!emergency.active) throw new EmergencyRouteMissingError("inactive");

  return {
    // Filtering by name as well as by identity: the emergency route cannot end
    // up in this list however the caller assembled its input.
    deactivateOutbound: params.outboundRoutes.filter(
      (r) => r.active && r.name !== EMERGENCY_OUTBOUND_ROUTE_NAME,
    ),
    emergencyRouteKept: emergency,
    repointInboundToDoorway: params.inboundRoutes.filter((r) => !r.pointsAtConnectDoorway),
    inboundHandledInConnect: params.inboundRoutes.filter((r) => r.pointsAtConnectDoorway),
  };
}

/**
 * What must change to put the tenant back exactly as they were.
 * ⛔ The emergency route is NOT touched — it is permanent, and it was never
 * switched off, so there is nothing to undo.
 */
export function buildRestorePlan(params: {
  /** The routes recorded as deactivated when service was switched off. */
  deactivatedOutbound: OutboundRouteRef[];
  /** The routes recorded as re-pointed when service was switched off. */
  repointedInbound: InboundRouteRef[];
}): RestorePlan {
  return {
    // Reactivate only what WE switched off, and never the emergency route.
    reactivateOutbound: params.deactivatedOutbound.filter((r) => r.name !== EMERGENCY_OUTBOUND_ROUTE_NAME),
    restoreInbound: params.repointedInbound,
  };
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
