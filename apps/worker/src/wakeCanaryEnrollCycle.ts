// Autonomous mobile wake auto-enroll worker cycle.
//
// Goal: keep cold-mobile wake enabled for the WHOLE eligible fleet and
// auto-enroll any newly-active mobile device — with no human in the loop at
// runtime. It REUSES the proven pure logic from the wake-canary reconciler
// (scripts/pbx/wake-canary-reconcile.mjs): `loadRecordsFromDb` (DB read) +
// `reconcile` (eligibility + diff). No logic is duplicated here.
//
// IN-LANE PUBLISH CHANNEL: this cycle NEVER shells `asterisk -rx` and never
// SSH-mutates the PBX. It publishes wake keys through Connect's normal channel —
// the telephony service's internal route POST /telephony/internal/wake-canary-publish,
// which writes the four Connect-owned `connect/wake_canary*` AstDB families via
// AMI DBPut (the same mechanism ivr-publish / dnd-publish already use in prod).
//
// SAFETY (fail-closed, append-only):
//   • Gated OFF by default. It does nothing unless WAKE_AUTOENROLL_ENABLED="1".
//   • It reconciles against an EMPTY current-state, so it only ever ENABLEs
//     eligible extensions — it never emits a DISABLE. Disable / rollback stays a
//     human-run, owner-initiated `wake-canary-reconcile.mjs apply` operation.
//   • Coded SAFETY VALVE (assessWakeEnrollSafety): before publishing anything it
//     bails (logs + does nothing) if the plan is unexpectedly destructive, the
//     ENABLE count exceeds a sane cap, or any target key is malformed — so it can
//     only ever touch well-formed keys in the wake_canary space it owns.
//   • Publish is idempotent: re-writing "1" for an already-enabled extension is a
//     harmless no-op, so every cycle safely re-asserts the desired state.

// The reconciler is ESM .mjs; import its proven pure exports directly (same
// pattern as scripts/pbx/wake-canary-reconcile.test.ts). tsx resolves it at
// runtime and `COPY . .` ships it in the worker image.
import {
  ACTIONS,
  loadRecordsFromDb,
  reconcile,
  // @ts-expect-error — plain JS module, no type declarations
} from "../../../scripts/pbx/wake-canary-reconcile.mjs";

const NUMERIC_RE = /^\d{1,10}$/;

export type WakeEnableTarget = { pbxTenantId: string; extNumber: string; key: string };

export type WakeEnrollSafety = {
  safe: boolean;
  reasons: string[];
  warnings: string[];
};

export type WakeEnrollSafetyOpts = {
  /** Absolute upper bound on how many extensions one cycle may enable. */
  maxEnable?: number;
  /** Canary key that must never silently drop out of the enable set. */
  requireCanaryKey?: string | null;
};

/**
 * Pure: pick the ENABLE targets out of a reconcile() result. Only rows the
 * reconciler decided to ENABLE, and only those whose tenant id + extension are
 * bare digit strings (so the closed-scope publish route will accept them).
 * Anything malformed is surfaced separately so the valve can fail closed.
 */
export function selectWakeEnableTargets(result: any): {
  targets: WakeEnableTarget[];
  malformed: Array<{ pbxTenantId: unknown; extNumber: unknown; key: unknown }>;
} {
  const targets: WakeEnableTarget[] = [];
  const malformed: Array<{ pbxTenantId: unknown; extNumber: unknown; key: unknown }> = [];
  for (const row of result?.rows ?? []) {
    if (row.action !== ACTIONS.ENABLE) continue;
    const pbxTenantId = row.pbxTenantId == null ? "" : String(row.pbxTenantId);
    const extNumber = row.extNumber == null ? "" : String(row.extNumber);
    if (NUMERIC_RE.test(pbxTenantId) && NUMERIC_RE.test(extNumber)) {
      targets.push({ pbxTenantId, extNumber, key: `T${pbxTenantId}_${extNumber}` });
    } else {
      malformed.push({ pbxTenantId: row.pbxTenantId, extNumber: row.extNumber, key: row.key });
    }
  }
  return { targets, malformed };
}

/**
 * Pure coded safety valve. Given a reconcile() result and the selected enable
 * targets, decide whether it is safe to publish. Fails CLOSED on anything
 * unexpected — an unsafe verdict means the cycle publishes nothing at all.
 */
export function assessWakeEnrollSafety(
  result: any,
  targets: WakeEnableTarget[],
  malformed: Array<unknown>,
  opts: WakeEnrollSafetyOpts = {},
): WakeEnrollSafety {
  const maxEnable = opts.maxEnable ?? 1000;
  const reasons: string[] = [];
  const warnings: string[] = [];

  const counts = result?.counts ?? {};
  const byAction = counts.byAction ?? {};
  const totalRecords = Number(counts.totalRecords ?? (result?.rows?.length ?? 0));

  // 1. This autonomous path is append-only. If reconcile produced ANY destructive
  //    action (a DISABLE row or an owned-orphan clear), something fed it real
  //    current-state — refuse rather than risk removing anyone's wake access.
  const disableCount = Number(byAction[ACTIONS.DISABLE] ?? 0);
  const orphanCount = Number(counts.orphanDisable ?? (result?.orphans?.length ?? 0));
  if (disableCount > 0 || orphanCount > 0) {
    reasons.push(`unexpected_destructive_action disable=${disableCount} orphan=${orphanCount}`);
  }

  // 2. Any malformed enable target ⇒ fail closed on the whole batch.
  if (malformed.length > 0) {
    reasons.push(`malformed_enable_key count=${malformed.length}`);
  }

  // 3. "Wildly larger than the real number of mobile extensions" guard.
  if (targets.length > maxEnable) {
    reasons.push(`enable_count_exceeds_cap ${targets.length}>${maxEnable}`);
  }

  // 4. Impossible-sanity: cannot enable more extensions than records examined.
  if (totalRecords > 0 && targets.length > totalRecords) {
    reasons.push(`enable_exceeds_total_records ${targets.length}>${totalRecords}`);
  }

  // 5. Never silently drop the proven canary. Soft warning (do not bail): if the
  //    canary extension is among the records but not in the enable set, flag it.
  const canary = opts.requireCanaryKey ?? null;
  if (canary) {
    const inRecords = (result?.rows ?? []).some((r: any) => r.key === canary);
    const inTargets = targets.some((t) => t.key === canary);
    if (inRecords && !inTargets) warnings.push(`canary_not_enabled ${canary}`);
  }

  return { safe: reasons.length === 0, reasons, warnings };
}

let _wakeEnrollRunning = false;

export async function runWakeCanaryEnrollCycle(): Promise<void> {
  if ((process.env.WAKE_AUTOENROLL_ENABLED || "").trim() !== "1") return;
  if (_wakeEnrollRunning) return;
  _wakeEnrollRunning = true;
  try {
    const base = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
    const secret = process.env.CDR_INGEST_SECRET?.trim() ?? "";
    const maxEnable = Math.max(1, Number(process.env.WAKE_AUTOENROLL_MAX_ENABLE || 1000) || 1000);
    const canaryKey = (process.env.WAKE_AUTOENROLL_CANARY_KEY || "T2_110").trim() || null;

    let records: any[];
    try {
      records = await loadRecordsFromDb();
    } catch (err: any) {
      console.error(JSON.stringify({ msg: "wake-autoenroll-cycle", phase: "db_read", ok: false, error: String(err?.message || err) }));
      return; // fail closed
    }

    // Reconcile against an EMPTY current-state ⇒ enable-forward only, never disable.
    const result = reconcile(records, { value: {}, owner: {} }, {});
    const { targets, malformed } = selectWakeEnableTargets(result);
    const safety = assessWakeEnrollSafety(result, targets, malformed, { maxEnable, requireCanaryKey: canaryKey });

    if (!safety.safe) {
      console.error(JSON.stringify({
        msg: "wake-autoenroll-cycle",
        phase: "safety_valve",
        ok: false,
        published: 0,
        enable_targets: targets.length,
        reasons: safety.reasons,
        warnings: safety.warnings,
      }));
      return; // fail closed — publish nothing
    }

    const ts = String(Math.floor(Date.now() / 1000));
    let published = 0;
    let failed = 0;
    for (const t of targets) {
      try {
        const resp = await fetch(`${base}/telephony/internal/wake-canary-publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
          body: JSON.stringify({ pbxTenantId: t.pbxTenantId, extension: t.extNumber, enable: "1", ts }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) throw new Error(`wake-canary-publish HTTP ${resp.status}`);
        published++;
      } catch (pubErr: any) {
        failed++;
        console.error(JSON.stringify({ msg: "wake-autoenroll-publish", ok: false, key: t.key, error: String(pubErr?.message || pubErr) }));
      }
    }

    console.log(JSON.stringify({
      msg: "wake-autoenroll-cycle",
      phase: "publish",
      ok: failed === 0,
      records: records.length,
      enable_targets: targets.length,
      published,
      failed,
      warnings: safety.warnings,
    }));

    // ── Wake-dial bridge (second half of enrollment) ─────────────────────────
    // The canary key above only arms [connect-wake-core] for calls that travel
    // Connect's own IVR/tenant-router contexts. Calls on NATIVE VitalPBX paths
    // (VitalPBX IVRs, ring groups, direct dials) resolve the extension's AstDB
    // `dial` string instead — this pass rewrites its mobile leg to route through
    // [connect-mobile-wake-dial] (fleet rollout mandated by Izzy 2026-08-05).
    // Separately gated so either half can be turned off alone. Idempotent: the
    // publish route returns changed=false when already enrolled, and re-asserts
    // enrollment if a VitalPBX panel edit reverted the dial key. Typed
    // not-applicable outcomes (no mobile leg, unknown tenant hash, missing dial
    // key) are SKIPS — expected for desk-only or not-yet-mapped extensions —
    // never failures.
    if ((process.env.WAKE_DIAL_AUTOENROLL_ENABLED || "").trim() === "1") {
      const SKIP_REASONS = new Set([
        "no_mobile_leg",
        "extension_not_enrollable",
        "ambiguous_extension",
        "dial_key_missing",
        "empty_dial_value",
      ]);
      let dialEnrolled = 0;
      let dialAlready = 0;
      let dialSkipped = 0;
      let dialFailed = 0;
      for (const t of targets) {
        try {
          const resp = await fetch(`${base}/telephony/internal/wake-dial-publish`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(secret ? { "x-cdr-secret": secret } : {}) },
            body: JSON.stringify({ pbxTenantId: t.pbxTenantId, extension: t.extNumber, enable: "1" }),
            signal: AbortSignal.timeout(10_000),
          });
          const body: any = await resp.json().catch(() => ({}));
          if (resp.ok && body?.ok) {
            if (body.changed) {
              dialEnrolled++;
              console.log(JSON.stringify({
                msg: "wake-dial-autoenroll",
                ok: true,
                key: t.key,
                before: body.before,
                after: body.after,
              }));
            } else {
              dialAlready++;
            }
          } else if (SKIP_REASONS.has(String(body?.error))) {
            dialSkipped++;
          } else {
            throw new Error(`wake-dial-publish HTTP ${resp.status} ${String(body?.error ?? "")}`.trim());
          }
        } catch (pubErr: any) {
          dialFailed++;
          console.error(JSON.stringify({ msg: "wake-dial-autoenroll", ok: false, key: t.key, error: String(pubErr?.message || pubErr) }));
        }
      }
      console.log(JSON.stringify({
        msg: "wake-autoenroll-cycle",
        phase: "wake_dial_publish",
        ok: dialFailed === 0,
        targets: targets.length,
        enrolled: dialEnrolled,
        already: dialAlready,
        skipped: dialSkipped,
        failed: dialFailed,
      }));
    }
  } finally {
    _wakeEnrollRunning = false;
  }
}
