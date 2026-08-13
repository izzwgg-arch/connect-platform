// ── Re-bake Connect-routed numbers after a panel Apply Changes ───────────────
//
// Apply Changes regenerates tenant dialplan files, and VitalPBX's own
// regenerator cannot render the Connect doorway — it writes its generic
// `T<t>_custom-contexts,cc-<id>` form, an extension that exists nowhere, so
// every Connect-routed number in the regenerated file sends callers to dead
// air until something restores the helper's baked `Goto(connect-doorway,s,1)`.
//
// 2026-08-13, inii mini: a customer created two "ring an outside number"
// forwards from the Studio at midnight. Each createForward → Apply Changes
// regen wiped the bake on their number's inbound route; SEVEN consecutive
// inbound calls died with 0 seconds before the reconciler's sweep re-baked it
// (~6 minutes later — the second regen also hit the reconciler's 6h re-bake
// rate limit). The customer texted "our phone system is down", and they were
// right.
//
// So: every code path that fires Apply Changes MUST call this immediately
// after, closing the window from minutes to the seconds the apply itself
// takes. The reconciler stays as the backstop for regens Connect didn't cause
// (panel saves by a human), not as the primary repair for regens Connect DID
// cause.

import {
  rebakePbxRoute,
  resolvePbxRouteHelperConfig,
} from "../pbxInboundRouteHelperClient";

export interface ApplyRegenRebakeResult {
  attempted: number;
  rebaked: number;
  /** Lines actually rewritten across all routes (0 = everything was already
   *  correct, e.g. the regen never touched these renders). */
  linesChanged: number;
  failed: Array<{ e164: string; error: string }>;
}

export interface ApplyRegenRebakeDeps {
  db: any;
  log: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void; error: (o: any, m: string) => void };
  /** The PBX tenant the regenerated routes belong to (TenantPbxLink.pbxTenantId). */
  pbxTenantId: string;
  pbxInstanceId: string | null;
  /** Injectable for tests. */
  rebakeFn?: typeof rebakePbxRoute;
  resolveCfgFn?: typeof resolvePbxRouteHelperConfig;
}

/**
 * Re-assert the doorway bake on every enabled, Connect-routed number of one
 * tenant. Idempotent (a route already correct reports changed:0) and it NEVER
 * throws — a failed re-bake is logged and reported in the result, and the
 * reconciler sweep remains behind it. Callers treat a non-empty `failed` as
 * "the reconciler will finish this", not as a reason to fail their own
 * operation: the forward (or whatever fired the apply) was created fine.
 */
export async function rebakeConnectRoutesAfterRegen(
  tenantId: string,
  deps: ApplyRegenRebakeDeps,
): Promise<ApplyRegenRebakeResult> {
  const { db, log, pbxTenantId, pbxInstanceId } = deps;
  const rebakeFn = deps.rebakeFn ?? rebakePbxRoute;
  const resolveCfgFn = deps.resolveCfgFn ?? resolvePbxRouteHelperConfig;
  const result: ApplyRegenRebakeResult = { attempted: 0, rebaked: 0, linesChanged: 0, failed: [] };

  let mappings: Array<{ e164: string }> = [];
  try {
    mappings = await db.didRouteMapping.findMany({
      where: { tenantId, enabled: true, routingMode: "connect" },
      select: { e164: true },
    });
  } catch (err: any) {
    log.error({ tenantId, err: err?.message }, "[APPLY_REBAKE] could not list connect mappings — reconciler will cover");
    return result;
  }
  if (mappings.length === 0) return result;

  const cfg = resolveCfgFn(pbxInstanceId);
  if (!cfg) {
    log.error({ tenantId }, "[APPLY_REBAKE] route helper not configured — reconciler will cover");
    result.failed.push(...mappings.map((m) => ({ e164: m.e164, error: "route_helper_not_configured" })));
    return result;
  }

  for (const m of mappings) {
    result.attempted += 1;
    try {
      const r = await rebakeFn(cfg, { did: String(m.e164), tenantId: pbxTenantId });
      result.rebaked += 1;
      result.linesChanged += Number(r.changed ?? 0);
      if (Number(r.changed ?? 0) > 0) {
        log.warn(
          { tenantId, e164: m.e164, changed: r.changed },
          "[APPLY_REBAKE] Apply Changes had wiped this number's doorway routing — re-baked",
        );
      }
    } catch (err: any) {
      result.failed.push({ e164: m.e164, error: err?.message ?? "rebake_failed" });
      log.error({ tenantId, e164: m.e164, err: err?.message }, "[APPLY_REBAKE] re-bake failed — reconciler will cover");
    }
  }
  log.info(
    { tenantId, attempted: result.attempted, rebaked: result.rebaked, linesChanged: result.linesChanged, failed: result.failed.length },
    "[APPLY_REBAKE] post-apply route re-bake complete",
  );
  return result;
}
