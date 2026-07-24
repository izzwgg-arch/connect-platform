/**
 * M5 — IVR greeting / recording selection change
 * (docs/ai-support-agent/specs/M5_IVR_PROMPT_SPEC.md).
 *
 * Changes which recording an IVR profile plays for one prompt slot (greeting /
 * invalid / timeout / retry), from the tenant's OWN synced VitalPBX library, via
 * the same AstDB publish path as M4. Live, no dialplan regen, M1-safety-class.
 * The api door enforces the dead-air guard (recording must exist in the tenant's
 * catalog); this op adds snapshot/verify/revert.
 *
 * Simulate mode: DB reads only via injected prisma; ZERO HTTP.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);
export const IVR_PROMPT_SLOTS = ["greeting", "invalid", "timeout", "retry"] as const;
const SLOT_FIELD: Record<string, "pbxPromptRef" | "pbxInvalidPromptRef" | "pbxTimeoutPromptRef" | "pbxRetryPromptRef"> = {
  greeting: "pbxPromptRef", invalid: "pbxInvalidPromptRef", timeout: "pbxTimeoutPromptRef", retry: "pbxRetryPromptRef",
};

export const M5_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** objectId is "<profileId>:<slot>". */
    objectId: nonEmpty,
    profileId: nonEmpty,
    promptSlot: z.enum(IVR_PROMPT_SLOTS),
    /** null clears back to default. */
    promptRef: z.string().max(128).nullable().optional(),
  })
  .refine((v) => v.objectId === `${v.profileId}:${v.promptSlot}`, { message: "objectId must be '<profileId>:<slot>'" });

export interface M5Snapshot {
  connectTenantId: string;
  profileId: string;
  promptSlot: string;
  /** Prior ref for this slot (may be null = default). */
  promptRef: string | null;
}

async function resolveConnectTenant(prisma: any, vitalTenantId: string): Promise<string | null> {
  const link = await prisma.tenantPbxLink.findFirst({ where: { pbxTenantId: String(vitalTenantId) }, select: { tenantId: true } });
  return link?.tenantId ?? null;
}

export function makeM5Op(deps: ModifyCatalogDeps & { ivrApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const ivrApi = deps.ivrApi;
  return {
    id: "M5",
    capabilityId: "pbx.M5",
    kind: "ivr_prompt",
    title: "Change an IVR profile's greeting / prompt recording",
    schema: M5_SCHEMA,
    feasibility: "astdb",
    risk: "low",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, _ctx: ModifyOpCtx) {
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return null;
      const field = SLOT_FIELD[params.promptSlot];
      const profile = await deps.prisma.ivrRouteProfile.findFirst({
        where: { id: params.profileId, tenantId: connectTenantId },
        select: { id: true, pbxPromptRef: true, pbxInvalidPromptRef: true, pbxTimeoutPromptRef: true, pbxRetryPromptRef: true },
      });
      if (!profile) throw new Error(`IVR profile '${params.profileId}' not found in tenant — refusing (ownership fence)`);
      const state: M5Snapshot = {
        connectTenantId,
        profileId: params.profileId,
        promptSlot: params.promptSlot,
        promptRef: (profile as any)[field] ?? null,
      };
      return { state };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { simulated: true, profileId: params.profileId, promptSlot: params.promptSlot, promptRef: params.promptRef ?? null };
      const resp = await ivrApi.call({
        tenantId: String(params.tenantId),
        action: "set_prompt",
        profileId: params.profileId,
        promptSlot: params.promptSlot,
        promptRef: params.promptRef ?? null,
        agentActionId: ctx.actionId ?? "unknown",
      });
      return { profileId: params.profileId, promptSlot: params.promptSlot, promptRef: params.promptRef ?? null, publish: resp.publishResult ?? null, publishError: resp.publishError ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      if (written?.publishError) return { ok: false, detail: `publish failed: ${written.publishError}` };
      const connectTenantId = await resolveConnectTenant(deps.prisma, params.tenantId);
      if (!connectTenantId) return { ok: false, detail: "tenant link vanished during execution" };
      const field = SLOT_FIELD[params.promptSlot];
      const profile = await deps.prisma.ivrRouteProfile.findFirst({ where: { id: params.profileId, tenantId: connectTenantId }, select: { [field]: true } as any });
      const want = params.promptRef && String(params.promptRef).trim() ? String(params.promptRef).trim() : null;
      const got = profile ? ((profile as any)[field] ?? null) : undefined;
      if (got !== want) return { ok: false, observed: { got }, detail: "prompt slot does not reflect the requested recording" };
      return { ok: true, observed: { slot: params.promptSlot } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      const prev = (snapshotState as M5Snapshot)?.promptRef ?? null;
      if (ctx.simulate) return { restored: prev };
      return ivrApi.call({
        tenantId: String(params.tenantId),
        action: "set_prompt",
        profileId: params.profileId,
        promptSlot: params.promptSlot,
        promptRef: prev,
        agentActionId: ctx.actionId ?? "revert",
      });
    },
  };
}
