/**
 * M3 (Option A) — internal inbound-route door helpers
 * (docs/ai-support-agent/specs/M3_INBOUND_ROUTE_DEST_SPEC.md §0).
 *
 * ROCK-SOLID contract: a DID may be retargeted ONLY to a destination VALUE the
 * tenant is ALREADY using (a destination_id currently bound to one of that
 * tenant's own inbound routes). That set is authoritative and tenant-scoped —
 * no ambiguous destination resolution, no creation, no guessing. Connect-mode
 * DIDs are hard-refused (protect Connect routing/MOH).
 *
 * Pure pieces here; the route + helper calls live in server.ts.
 */
import { z } from "zod";

export const AGENT_ROUTE_HEADER = "x-agent-internal-secret";

/**
 * Native VitalPBX object types a DID (or IVR option) may target. The helper
 * verifies tenant ownership of the target row and find-or-creates the
 * ombu_destinations row, so "proven in-use" is no longer the only safe set.
 */
export const NATIVE_TARGET_TYPES = ["extension", "queue", "ring_group", "ivr", "time_condition", "custom_application"] as const;
export type NativeTargetType = (typeof NATIVE_TARGET_TYPES)[number];

export const AgentRouteActionRequest = z
  .object({
    tenantId: z.string().min(1),
    action: z.enum(["list_targets", "list_catalog", "route_inspect", "route_retarget", "route_retarget_v2", "route_restore"]),
    /** DID to act on (retarget/restore/inspect). */
    did: z.string().min(1).optional(),
    /** Target destination VALUE for legacy retarget — MUST be in the tenant's in-use set. */
    destinationId: z.string().min(1).optional(),
    /** v2 retarget: tenant-owned target by type + primary key (helper-verified). */
    targetType: z.enum(NATIVE_TARGET_TYPES).optional(),
    targetId: z.string().min(1).optional(),
    reason: z.string().max(500).optional(),
    agentActionId: z.string().min(1),
  })
  .refine((v) => v.action === "list_targets" || v.action === "list_catalog" || !!v.did, { message: "did required" })
  .refine((v) => v.action !== "route_retarget" || !!v.destinationId, { message: "destinationId required for retarget" })
  .refine((v) => v.action !== "route_retarget_v2" || (!!v.targetType && !!v.targetId), { message: "targetType + targetId required for retarget_v2" });

export type AgentRouteActionRequest = z.infer<typeof AgentRouteActionRequest>;

/** A proven route target: a destination value in use, labeled by the DID(s) using it. */
export interface RouteTarget {
  destinationId: string;
  usedByDids: Array<{ did: string; description: string | null }>;
}

/**
 * Fold per-DID inspect results into the distinct in-use destination set. Only
 * PBX-mode routes are eligible targets; connect-mode DIDs are excluded (their
 * destination is the Connect router, never a valid retarget target).
 */
export function buildRouteTargets(
  rows: Array<{ did: string; description: string | null; destinationId: string | null; mode: "connect" | "pbx" | "unknown" }>,
): RouteTarget[] {
  const byDest = new Map<string, RouteTarget>();
  for (const r of rows) {
    if (r.mode !== "pbx") continue; // connect/unknown are not offerable targets
    if (!r.destinationId) continue;
    const t = byDest.get(r.destinationId) ?? { destinationId: r.destinationId, usedByDids: [] };
    t.usedByDids.push({ did: r.did, description: r.description });
    byDest.set(r.destinationId, t);
  }
  return [...byDest.values()];
}

/** THE FENCE: is destinationId a proven in-use target for this tenant? */
export function isProvenTarget(targets: RouteTarget[], destinationId: string): boolean {
  return targets.some((t) => t.destinationId === String(destinationId));
}
