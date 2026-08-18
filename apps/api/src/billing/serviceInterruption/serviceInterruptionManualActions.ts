/**
 * The two manual controls Izzy asked for: put a customer back on now, or take
 * them off now. Pure decision layer — the caller performs the PBX work and the
 * audit write.
 *
 * ⛔ RESTORE AND FORCE ARE NOT SYMMETRICAL, AND MUST NOT BE TREATED AS SUCH.
 * Restore turns a phone system back ON: it is safe, it is what you reach for
 * when something has gone wrong, and it should be hard to get refused.
 * Force turns a working phone system OFF on the spot, for a customer who has
 * not yet run out of days. It is the dangerous one and needs a reason on the
 * record.
 */

import { readServiceInterruption } from "./serviceInterruptionSettings";

export type ManualActor = { userId: string; email: string };

export type ManualRestoreDecision =
  | { ok: true; membersToEnable: Array<{ arsId: string; outboundRouteId: string }>; wasInterrupted: true }
  | { ok: false; reason: string };

export type ManualForceDecision = { ok: true } | { ok: false; reason: string };

/**
 * Put a customer back on now, whether or not they have paid.
 *
 * ⛔ Deliberately permissive: the only refusal is "they are not switched off",
 * because every other reason to say no ends with a customer sitting without
 * phones while somebody argues about policy.
 */
export function decideManualRestore(metadata: unknown): ManualRestoreDecision {
  const s = readServiceInterruption(metadata);
  const interrupted = Boolean(s.interruptedAt) && !s.restoredAt;
  if (!interrupted) return { ok: false, reason: "this customer's service is not switched off" };
  if (s.disabledArsMembers.length === 0) {
    // Interrupted, but we recorded nothing to put back. Restoring the flag
    // alone would leave them off with the system believing they are on.
    return {
      ok: false,
      reason:
        "marked interrupted but no disabled routes were recorded — put the routes back by hand, " +
        "then clear the flag, rather than letting this report a restore that did nothing",
    };
  }
  return { ok: true, membersToEnable: s.disabledArsMembers, wasInterrupted: true };
}

/**
 * Take a customer off now, before their days have run out.
 * ⛔ Requires a written reason. A cutoff with no recorded reason is
 * indistinguishable from an accident when someone asks a week later.
 */
export function decideManualForce(metadata: unknown, params: { reason: string }): ManualForceDecision {
  const s = readServiceInterruption(metadata);
  const interrupted = Boolean(s.interruptedAt) && !s.restoredAt;
  if (interrupted) return { ok: false, reason: "this customer's service is already switched off" };
  if (!params.reason || params.reason.trim().length < 8) {
    return { ok: false, reason: "a reason is required before switching a working phone system off" };
  }
  return { ok: true };
}

/** Audit action names, so both paths are greppable in one search. */
export const SERVICE_INTERRUPTION_AUDIT = {
  restored: "SERVICE_INTERRUPTION_RESTORED_MANUALLY",
  forced: "SERVICE_INTERRUPTION_FORCED_MANUALLY",
  switchChanged: "SERVICE_INTERRUPTION_SWITCH_CHANGED",
} as const;
