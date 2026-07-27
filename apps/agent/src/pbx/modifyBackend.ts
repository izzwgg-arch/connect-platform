/**
 * ExecuteBackend adapter bridging the ActionService to the Modify Executor
 * (X1). Mirrors pbxBackend.ts's belt-and-suspenders live gating: live only
 * when the service is live-enabled AND the capability's manifest entry has
 * liveEnabled:true — and the executor then re-runs its own full gate chain.
 *
 * With MODIFY_CATALOG empty (X1) every call refuses at G1 by design.
 */
import type { ExecuteBackend } from "../actions/service";
import type { ModifyPbxExecutor } from "./modifyExecutor";
import { capabilityById } from "../manifest/manifest";

export function makeModifyBackend(executor: ModifyPbxExecutor): ExecuteBackend {
  return {
    async execute(action: any, opts: { live: boolean }) {
      const cap = capabilityById(action.capabilityId);
      const live = opts.live && cap?.liveEnabled === true;
      const res = await executor.execute({
        capabilityId: action.capabilityId,
        params: action.params as Record<string, unknown>,
        requestedBy: `${action.requestedRole}:${action.requestedBy}`,
        requestedRole: action.requestedRole === "owner" ? "owner" : "customer",
        actionId: action.id,
        mode: live ? "live" : "simulate",
      });
      return { ok: res.ok, snapshot: res, error: res.refusedReason };
    },
    async revert(action: any) {
      const res = await executor.revert(action.id, "scheduler_or_owner");
      return { ok: res.ok, error: res.refusedReason, permanent: res.permanent };
    },
  };
}
