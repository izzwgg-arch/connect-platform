/**
 * M11 — Extension feature toggle (DND / call-forward)
 * (docs/ai-support-agent/specs/M11_EXTENSION_FEATURES_SPEC.md).
 *
 * Sets/clears an extension's real DND or call-forward via a LIVE AstDB diversion
 * write (helper `database put` — NOT gen-conf, no regen). Same safe class as MOH.
 * The api door enforces protected-ext + ownership; this op adds
 * snapshot/verify/revert.
 *
 * Simulate mode: NO HTTP. Snapshot in sim returns an empty prior (the executor
 * still runs the full gate chain); live snapshot reads via the door's `get`.
 */
import { z } from "zod";
import type { ModifyOp, ModifyOpCtx, ModifyClientLike, ModifyCatalogDeps } from "../modifyCatalog";

const nonEmpty = z.string().min(1);
export const EXT_FEATURES = ["DND", "CFU", "CFB", "CFN", "CFI"] as const;

export const M11_SCHEMA = z
  .object({
    tenantId: nonEmpty,
    /** objectId is the extension number (protected-ext gate keys on it). */
    objectId: nonEmpty,
    feature: z.enum(EXT_FEATURES),
    enable: z.enum(["yes", "no"]),
    destination: z.string().regex(/^\+?\d{1,20}$/).optional(),
  })
  .refine((v) => v.feature === "DND" || v.enable === "no" || !!v.destination, { message: "destination required to enable a call-forward" });

export interface M11Snapshot {
  extension: string;
  feature: string;
  before: { enable: string; destination: string };
}

export function makeM11Op(deps: ModifyCatalogDeps & { extFeatureApi: { call(body: Record<string, unknown>): Promise<any> } }): ModifyOp {
  const api = deps.extFeatureApi;

  return {
    id: "M11",
    capabilityId: "pbx.M11",
    kind: "extension", // reuses the X2 extension scope mapping + protected-ext G5
    title: "Set an extension's DND / call-forward",
    schema: M11_SCHEMA,
    feasibility: "helper",
    risk: "medium",

    async snapshot(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { state: { extension: String(params.objectId), feature: params.feature, before: { enable: "no", destination: "" } } as M11Snapshot };
      const resp = await api.call({ tenantId: String(params.tenantId), action: "get", extension: String(params.objectId), feature: params.feature, agentActionId: ctx.actionId ?? "read" });
      return { state: { extension: String(params.objectId), feature: params.feature, before: { enable: resp.state?.enable ?? "no", destination: resp.state?.destination ?? "" } } as M11Snapshot };
    },

    async dispatch(_client: ModifyClientLike, params: Record<string, any>, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { simulated: true, extension: String(params.objectId), feature: params.feature, enable: params.enable };
      const resp = await api.call({ tenantId: String(params.tenantId), action: "set", extension: String(params.objectId), feature: params.feature, enable: params.enable, destination: params.destination ?? "", agentActionId: ctx.actionId ?? "unknown" });
      return { extension: String(params.objectId), feature: params.feature, enable: params.enable, destination: params.destination ?? "", after: resp.after ?? null };
    },

    async verify(_client: ModifyClientLike, params: Record<string, any>, _written: any, ctx: ModifyOpCtx) {
      if (ctx.simulate) return { ok: true, observed: { simulated: true } };
      const resp = await api.call({ tenantId: String(params.tenantId), action: "get", extension: String(params.objectId), feature: params.feature, agentActionId: ctx.actionId ?? "verify" });
      const wantEnable = params.enable;
      const wantDest = params.enable === "yes" ? (params.destination ?? "") : "";
      const gotEnable = resp.state?.enable ?? "no";
      const gotDest = resp.state?.destination ?? "";
      if (gotEnable !== wantEnable) return { ok: false, observed: resp.state, detail: `enable is '${gotEnable}', wanted '${wantEnable}'` };
      if (params.feature !== "DND" && String(gotDest) !== String(wantDest)) return { ok: false, observed: resp.state, detail: "forward destination did not take" };
      return { ok: true, observed: { feature: params.feature, enable: gotEnable } };
    },

    async revert(_client: ModifyClientLike, params: Record<string, any>, snapshotState: any, ctx: ModifyOpCtx) {
      const before = (snapshotState as M11Snapshot)?.before ?? { enable: "no", destination: "" };
      if (ctx.simulate) return { restored: before };
      return api.call({ tenantId: String(params.tenantId), action: "set", extension: String(params.objectId), feature: (snapshotState as M11Snapshot).feature, enable: before.enable, destination: before.destination, agentActionId: ctx.actionId ?? "revert" });
    },
  };
}
