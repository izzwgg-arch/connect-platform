/**
 * M10 (AI agent) — queue config edit: request schema + pure allow-list
 * validation. The agent may only patch a FIXED set of queue fields, each
 * range/enum-checked — it can never send an arbitrary VitalPBX queue payload.
 */
import { z } from "zod";

export const QUEUE_STRATEGIES = [
  "ringall", "leastrecent", "fewestcalls", "random", "rrmemory", "linear", "wrandom", "rrordered",
] as const;

/** The ONLY queue fields the agent may change (M10 hardening). */
export const AgentQueuePatch = z
  .object({
    strategy: z.enum(QUEUE_STRATEGIES).optional(),
    timeout: z.number().int().min(0).max(600).optional(),
    wrapuptime: z.number().int().min(0).max(600).optional(),
    retry: z.number().int().min(0).max(60).optional(),
    maxlen: z.number().int().min(0).max(1000).optional(),
    servicelevel: z.number().int().min(0).max(3600).optional(),
    ringinuse: z.enum(["yes", "no"]).optional(),
    skip_busy: z.enum(["yes", "no"]).optional(),
    answered_elsewhere: z.enum(["yes", "no"]).optional(),
  })
  .strict() // any unknown field ⇒ reject (no arbitrary payload)
  .refine((v) => Object.keys(v).length > 0, { message: "patch must change at least one field" });

export type AgentQueuePatch = z.infer<typeof AgentQueuePatch>;
export const AGENT_QUEUE_FIELDS = ["strategy", "timeout", "wrapuptime", "retry", "maxlen", "servicelevel", "ringinuse", "skip_busy", "answered_elsewhere"] as const;

export const AgentQueueActionRequest = z
  .object({
    tenantId: z.string().min(1),
    action: z.enum(["list", "update"]),
    queueId: z.string().min(1).optional(),
    patch: AgentQueuePatch.optional(),
    agentActionId: z.string().min(1),
  })
  .refine((v) => v.action !== "update" || (!!v.queueId && !!v.patch), { message: "queueId + patch required for update" });

export type AgentQueueActionRequest = z.infer<typeof AgentQueueActionRequest>;

/** Pull just the allow-listed fields out of a full queue object (for snapshot/compare). */
export function pickQueueFields(q: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of AGENT_QUEUE_FIELDS) if (q && q[k] !== undefined) out[k] = q[k];
  return out;
}
