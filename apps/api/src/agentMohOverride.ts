/**
 * M1 (AI agent) — internal MOH-override endpoint helpers
 * (docs/ai-support-agent/specs/M1_MOH_TENANT_SPEC.md §2).
 *
 * The agent's ONLY door into hold-music changes: a shared-secret internal
 * endpoint that drives the SAME functions the portal override routes use
 * (mohOverrideState upsert + doMohPublish). It can do MOH override and
 * nothing else. Every change is attributable: activatedBy "agent:<actionId>".
 *
 * This module holds the pure, unit-testable pieces; the route itself is
 * registered in server.ts (it needs the doMohPublish closure).
 */
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const AGENT_MOH_HEADER = "x-agent-internal-secret";

export const AgentMohOverrideRequest = z
  .object({
    /** Connect tenant id or vital tenant id — resolved server-side (resolveMohTenantId). */
    tenantId: z.string().min(1),
    action: z.enum(["read", "activate", "deactivate"]),
    profileId: z.string().min(1).optional(),
    reason: z.string().max(500).optional(),
    /** ISO datetime; null clears. Only meaningful for activate. */
    expiresAt: z.string().datetime().nullable().optional(),
    /** The AgentAction driving this change — REQUIRED for attribution. */
    agentActionId: z.string().min(1),
  })
  .refine((v) => v.action !== "activate" || !!v.profileId, { message: "profileId required for activate" });

export type AgentMohOverrideRequest = z.infer<typeof AgentMohOverrideRequest>;

/** Fail-closed shared-secret check: unset secret ⇒ endpoint disabled. */
export function agentMohSecretOk(headerValue: unknown, secret = process.env.AGENT_INTERNAL_SECRET): boolean {
  const s = String(secret || "").trim();
  if (!s) return false;
  if (typeof headerValue !== "string" || headerValue.length === 0) return false;
  const a = Buffer.from(s);
  const b = Buffer.from(headerValue);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Shape the read/snapshot payload the agent's M1 op consumes. */
export function shapeMohSnapshot(input: {
  tenantId: string;
  override: any | null;
  profiles: Array<{ id: string; name: string; type: string; vitalPbxMohClassName: string; isActive: boolean }>;
  latestPublish: any | null;
}): {
  tenantId: string;
  override: { isActive: boolean; profileId: string | null; expiresAt: string | null } | null;
  profiles: Array<{ id: string; name: string; type: string; vitalPbxMohClassName: string }>;
  latestPublish: { id: string; status: string; newMohClass: string; queuePatch: unknown; queuesTotal: number | null } | null;
} {
  const o = input.override;
  const lp = input.latestPublish;
  return {
    tenantId: input.tenantId,
    override: o
      ? {
          isActive: !!o.isActive,
          profileId: o.profileId ?? null,
          expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
        }
      : null,
    profiles: input.profiles.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name, type: p.type, vitalPbxMohClassName: p.vitalPbxMohClassName })),
    latestPublish: lp
      ? {
          id: lp.id,
          status: lp.status,
          newMohClass: lp.newMohClass,
          queuePatch: lp.nativeSync?.helperResponse?.queuePatch ?? null,
          queuesTotal: typeof lp.nativeSync?.queuesTotal === "number" ? lp.nativeSync.queuesTotal : null,
        }
      : null,
  };
}
