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

export const AgentRouteActionRequest = z
  .object({
    tenantId: z.string().min(1),
    action: z.enum(["list_targets", "route_inspect", "route_retarget", "route_restore"]),
    /** DID to act on (retarget/restore/inspect). */
    did: z.string().min(1).optional(),
    /** Target destination VALUE for retarget — MUST be in the tenant's in-use set. */
    destinationId: z.string().min(1).optional(),
    reason: z.string().max(500).optional(),
    agentActionId: z.string().min(1),
  })
  .refine((v) => v.action === "list_targets" || !!v.did, { message: "did required" })
  .refine((v) => v.action !== "route_retarget" || !!v.destinationId, { message: "destinationId required for retarget" });

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
