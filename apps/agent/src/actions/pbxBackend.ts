/**
 * ExecuteBackend adapter bridging the ActionService to the Scoped PBX Executor.
 * Maps an approved agent action (capabilityId "pbx.P#") to an executor call.
 *
 * Live-write gating (belt-and-suspenders):
 *   - `live` only passes through when BOTH the ActionService is configured for
 *     live writes AND the capability's manifest entry has liveEnabled:true.
 *   - Otherwise the executor runs in simulate mode. Certified-in-sim capabilities
 *     therefore stay non-destructive until liveEnabled is explicitly turned on.
 */
import type { ExecuteBackend } from "./service";
import type { ScopedPbxExecutor } from "../pbx/executor";
import { capabilityById } from "../manifest/manifest";

export function makePbxBackend(executor: ScopedPbxExecutor): ExecuteBackend {
  return {
    async execute(action: any, opts: { live: boolean }) {
      const opId = action.capabilityId.split(".")[1]; // "pbx.P4" -> "P4"
      const cap = capabilityById(action.capabilityId);
      const liveEnabled = cap?.liveEnabled === true;
      const live = opts.live && liveEnabled;
      const res = await executor.execute({
        opId,
        params: action.params as Record<string, unknown>,
        requestedBy: `${action.requestedRole}:${action.requestedBy}`,
        actionId: action.id,
        mode: live ? "live" : "simulate",
        ownerConfirmed: live, // approval already happened at the action layer
      });
      return { ok: res.ok, snapshot: res, error: res.refusedReason };
    },
  };
}
