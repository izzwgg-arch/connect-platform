/**
 * DID / IVR drift reconciler — the "won't break in 30 years" layer.
 *
 * The May→August 2026 outage taught us this system's failure mode is SILENT
 * DECAY: a panel delete, an AstDB wipe, a regen quirk, a human edit — nothing
 * crashes, callers just quietly stop reaching the configured menu, and nobody
 * finds out until a customer complains months later. The moving parts live in
 * three places that can each drift independently:
 *
 *   1. The PBX inbound route's destination (ombu DB + baked dialplan) — must
 *      point at the Connect doorway for every routingMode=connect mapping.
 *   2. The Connect doorway itself (custom-context rows + dialplan file).
 *   3. AstDB keys: per-DID `connect/didmap/<e164>/*` and the tenant menu
 *      family `connect/t_<slug>/*` — what callers actually hear.
 *
 * This reconciler re-verifies all three on a timer, repairs what is safely
 * repairable (AstDB republish is an idempotent replay of already-published
 * state; route re-assertion goes through the SAME switch route an admin
 * clicks), and emails an alert for every repair or unrepairable drift. The
 * philosophy is the wake-dial worker's: converge on the recorded intent every
 * few minutes, forever, and never rely on "nothing will touch it".
 *
 * Deliberate policies (don't "simplify" these away):
 *   - Repairs replay RECORDED intent (last successful publish, current
 *     mapping row). The reconciler must never compute fresh state from drafts
 *     — that would push unpublished edits live.
 *   - Route re-assertion is rate-limited per mapping so a human doing panel
 *     surgery gets an alert + one polite re-assert per window, not a fight.
 *   - Everything fails toward ALERTING. A reconciler crash must never take
 *     the api down (it wraps every tenant in its own try/catch), and a
 *     reconciler that cannot repair still emails exactly what it saw.
 */

export type AstDbKV = { family: string; key: string; value: string };

export interface ReconcilerMapping {
  id: string;
  tenantId: string;
  e164: string;
  enabled: boolean;
  routingMode: string;
  ivrProfileId: string | null;
}

export interface DidRouteReconcilerDeps {
  app: any;
  db: any;
  sendAdminAlert: (key: string, subject: string, lines: string[], minIntervalMs?: number) => Promise<void>;
  /** Live PBX truth for one mapping (helper /inspect).
   *
   *  `mode` is the route ROW. `renderedMode` is the Goto actually rendered in
   *  the generated dialplan — WHAT CALLERS FOLLOW. They can disagree, and when
   *  they do the render wins (2026-08-06: the row said connect for two live
   *  numbers while callers reached a PBX IVR, because a panel edit repurposed
   *  the shared doorway destination). renderedMode is undefined on helpers too
   *  old to report it — treated as "cannot verify", never as healthy. */
  inspectMapping: (mapping: ReconcilerMapping) => Promise<
    | { ok: true; mode: "pbx" | "connect"; renderedMode?: "connect" | "pbx" | "unknown"; renderedGotos?: string[] }
    | { ok: false; error: string }
  >;
  /** Re-bake one route's render from recorded intent (helper /route-rebake). */
  rebakeRoute?: (mapping: ReconcilerMapping) => Promise<{ ok: boolean; changed?: number; error?: string }>;
  /** Full doorway repair — valid destination pair + every route repointed and
   *  re-baked (helper /doorway-repair). */
  repairDoorway?: () => Promise<{ ok: boolean; error?: string; routes?: Array<{ did: string; rebaked: number; error: string | null }> }>;
  /** Global doorway health (helper /doorway-status). */
  doorwayStatus: () => Promise<{ ok: true; healthy: boolean; contextLive: boolean } | { ok: false; error: string }>;
  /** Read current AstDB values for a family (empty string = missing).
   *  didE164 MUST be passed for `connect/didmap/*` families — the telephony
   *  read endpoint scope-checks the family against the tenant slug and rejects
   *  a didmap family without it. Omitting it made every didmap key read back
   *  empty, so the reconciler "repaired" the same two keys on every cycle
   *  forever (2026-08-06). */
  readAstDbKeys: (tenantSlug: string, family: string, keyNames: string[], didE164?: string) => Promise<AstDbKV[]>;
  /** Republish the mapping's didmap keys from the mapping row (idempotent). */
  republishDidmap: (mapping: ReconcilerMapping, tenantSlug: string) => Promise<void>;
  /** Replay the tenant's last successful menu publish verbatim. */
  replayLastMenuPublish: (tenantId: string, tenantSlug: string, keys: AstDbKV[]) => Promise<void>;
  /** Latest successful publish: its id, when it landed, and the keys it wrote
   *  (null = never published). The id and timestamp are load-bearing — see the
   *  freshness guard in the cycle. */
  lastSuccessfulPublishKeys: (tenantId: string) => Promise<{ id: string; publishedAt: number; keys: AstDbKV[] } | null>;
  /** Re-assert a drifted route through the real switch-to-connect endpoint. */
  reassertRoute: (mappingId: string) => Promise<{ statusCode: number; body: any }>;
  getTenantSlug: (tenantId: string) => Promise<string>;
}

/** Compare expected AstDB keys against a live snapshot.
 *  Returns the expected entries whose live value differs. Pure — unit-tested. */
export function diffAstDbKeys(expected: AstDbKV[], live: AstDbKV[]): AstDbKV[] {
  const liveMap = new Map(live.map((kv) => [`${kv.family}\u0000${kv.key}`, kv.value]));
  return expected.filter((kv) => (liveMap.get(`${kv.family}\u0000${kv.key}`) ?? "") !== kv.value);
}

/** The didmap keys a connect-mode mapping must have live. Pure — unit-tested. */
export function expectedDidmapKeys(mapping: ReconcilerMapping, tenantSlug: string): AstDbKV[] {
  const digits = mapping.e164.replace(/\D/g, "");
  if (!digits) return [];
  const family = `connect/didmap/${digits}`;
  // Only the two keys the doorway dialplan cannot live without. moh/hold are
  // cosmetic overrides whose recorded intent lives on the mapping row and is
  // re-written whole by republishDidmap when these two drift.
  return [
    { family, key: "tenant", value: tenantSlug },
    { family, key: "profile_id", value: mapping.ivrProfileId ?? "" },
  ];
}

/** Decide whether a route re-assert is allowed now. Pure — unit-tested. */
export function reassertAllowed(
  lastAttemptMs: number | undefined,
  nowMs: number,
  minIntervalMs: number,
): boolean {
  return lastAttemptMs === undefined || nowMs - lastAttemptMs >= minIntervalMs;
}

/** How long a publish owns the truth. Inside this window the reconciler will
 *  not "repair" menu keys: it replays the LAST publish, so racing a fresh one
 *  writes older values over newer and the owner's change silently reverts. */
const PUBLISH_SETTLE_MS = 5 * 60 * 1000;
const REASSERT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // one polite re-assert per 6h per mapping
const ALERT_DEDUPE_MS = 6 * 60 * 60 * 1000;
const DOORWAY_ALERT_DEDUPE_MS = 60 * 60 * 1000; // doorway-down is critical — hourly

/** Cross-cycle state (re-assert rate limiting). In-memory on purpose: after a
 *  restart the worst case is one extra idempotent re-assert. */
export type ReconcilerState = { lastReassertAt: Map<string, number> };

/** One reconciliation pass. Exported so tests drive it directly. */
export async function runReconcilerCycle(
  deps: DidRouteReconcilerDeps,
  state: ReconcilerState,
): Promise<void> {
  const { app, db, sendAdminAlert } = deps;
  const { lastReassertAt } = state;
  try {
      const mappings: ReconcilerMapping[] = await db.didRouteMapping.findMany({
        where: { routingMode: "connect", enabled: true },
        select: { id: true, tenantId: true, e164: true, enabled: true, routingMode: true, ivrProfileId: true },
      });
      if (mappings.length === 0) return;

      // ── 1. Doorway health (one global check per cycle). A noop re-assert on
      // any connect mapping self-heals the doorway (retarget ensures the
      // dialplan file + rows before its noop check), so an unhealthy doorway
      // gets one repair attempt plus a loud alert.
      const doorway = await deps.doorwayStatus();
      if (!doorway.ok || !doorway.healthy || !doorway.contextLive) {
        const detail = doorway.ok
          ? `healthy=${doorway.healthy} contextLive=${doorway.contextLive}`
          : `unreachable: ${doorway.error}`;
        app.log.error({ detail }, "[RECONCILER] doorway unhealthy");
        // Prefer the real repair (rebuilds the destination pair and re-bakes
        // every Connect-owned render) over a single route re-assert: a
        // hijacked/missing doorway is a platform-wide condition, and a
        // re-assert on one number cannot fix the others.
        let repair = "no repair attempted";
        if (reassertAllowed(lastReassertAt.get("doorway"), Date.now(), REASSERT_MIN_INTERVAL_MS)) {
          lastReassertAt.set("doorway", Date.now());
          try {
            if (deps.repairDoorway) {
              const r = await deps.repairDoorway();
              const failed = (r.routes ?? []).filter((x) => x.error);
              repair = r.ok
                ? `doorway repair ran — ${(r.routes ?? []).length} route(s) checked, ${failed.length} failed`
                : `doorway repair failed: ${r.error}`;
            } else {
              const r = await deps.reassertRoute(mappings[0].id);
              repair = r.statusCode < 300 ? "self-heal re-assert succeeded" : `self-heal re-assert failed: ${r.statusCode}`;
            }
          } catch (err: any) {
            repair = `automatic repair threw: ${err?.message}`;
          }
        }
        await sendAdminAlert(
          "reconciler-doorway",
          "Connect doorway unhealthy — published numbers may not reach their menus",
          [`Doorway status: ${detail}`, `Automatic repair: ${repair}`, "The reconciler re-checks every cycle."],
          DOORWAY_ALERT_DEDUPE_MS,
        );
      }

      // ── 2. Per-mapping route + didmap verification.
      const menuCheckedTenants = new Set<string>();
      for (const mapping of mappings) {
        try {
          const slug = await deps.getTenantSlug(mapping.tenantId);
          // Read the tenant's last publish ONCE per mapping and reuse it for
          // both repair paths below. A publish owns the truth for a while: it
          // is the owner acting deliberately, while every repair here is a
          // guess made from state read seconds ago.
          const publishedRec = await deps.lastSuccessfulPublishKeys(mapping.tenantId);
          const publishIsFresh =
            publishedRec !== null && Date.now() - publishedRec.publishedAt < PUBLISH_SETTLE_MS;

          // 2a-i. Does the RENDER still enter the doorway? This is checked
          // FIRST and separately from the row, because a row that reads
          // "connect" while the render points at a PBX menu is the failure
          // that shipped past this reconciler on 2026-08-06 — callers follow
          // the render. Repair is a re-bake: recorded intent is already
          // correct, only the generated dialplan drifted.
          const inspect = await deps.inspectMapping(mapping);
          if (inspect.ok && inspect.mode === "connect" && inspect.renderedMode && inspect.renderedMode !== "connect") {
            app.log.error({ e164: mapping.e164, rendered: inspect.renderedGotos }, "[RECONCILER] render drifted off the doorway");
            // ⛔ NOT rate-limited, deliberately (changed 2026-08-13). A drifted
            // render means callers to this number are getting DEAD AIR at this
            // moment, and the re-bake writes only the generated dialplan from
            // recorded intent — it cannot fight a human's decision, because a
            // human moving the number changes the ROW, which is the (still
            // rate-limited) re-assert branch below. The old 6h limit turned
            // inii mini's second regen of the night into six minutes of dead
            // calls: the first regen used up the allowance, the second hit
            // "rate-limited" and callers stayed broken until the slower
            // doorway-repair path happened to run.
            let repair: string;
            if (deps.rebakeRoute) {
              try {
                const r = await deps.rebakeRoute(mapping);
                repair = r.ok ? `re-baked the live routing (${r.changed ?? 0} line(s) rewritten)` : `re-bake failed: ${r.error}`;
              } catch (err: any) {
                repair = `re-bake threw: ${err?.message}`;
              }
            } else {
              repair = "no re-bake available on this helper — upgrade the PBX helper";
            }
            await sendAdminAlert(
              `reconciler-render-${mapping.id}`,
              `${mapping.e164} was sending callers to the old phone-system menu`,
              [
                `Connect owns this number, but the phone system's live routing pointed at: ${(inspect.renderedGotos ?? []).join(", ") || "something else"}.`,
                "This happens when something regenerates the phone system's config (a panel save, a tenant edit).",
                `Automatic repair: ${repair}.`,
                "No action needed unless the repair failed.",
              ],
              ALERT_DEDUPE_MS,
            );
          }

          // 2a-ii. Route row still points at the doorway?
          if (inspect.ok && inspect.mode !== "connect") {
            app.log.error({ e164: mapping.e164 }, "[RECONCILER] route drifted off Connect");
            let repair = "re-assert rate-limited (already attempted recently)";
            if (reassertAllowed(lastReassertAt.get(mapping.id), Date.now(), REASSERT_MIN_INTERVAL_MS)) {
              lastReassertAt.set(mapping.id, Date.now());
              const r = await deps.reassertRoute(mapping.id);
              repair = r.statusCode < 300 ? "re-asserted through the real switch route" : `re-assert failed: ${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`;
            }
            await sendAdminAlert(
              `reconciler-route-${mapping.id}`,
              `Number ${mapping.e164} drifted off its Connect menu`,
              [
                `Connect says this number should ring its menu, but the PBX route was pointing somewhere else.`,
                `Automatic repair: ${repair}.`,
                "If a person moved this number on purpose, switch it properly in the IVR Studio so Connect knows.",
              ],
              ALERT_DEDUPE_MS,
            );
          } else if (!inspect.ok) {
            // PBX unreachable — nothing to repair from here; alert with dedupe.
            await sendAdminAlert(
              `reconciler-inspect-${mapping.id}`,
              `Reconciler cannot verify ${mapping.e164} (PBX helper unreachable)`,
              [`Error: ${inspect.error}`, "Retrying every cycle."],
              ALERT_DEDUPE_MS,
            );
          }

          // 2b. didmap keys intact? (Asterisk restarts keep AstDB, but a PBX
          // rebuild or stray `database del` does not.)
          //
          // ⛔ Skipped right after a publish. This repair writes the number's
          // menu assignment; racing a publish means writing the PREVIOUS menu
          // back over the one the owner just chose, which reads as "I pointed
          // the number at a menu and it went somewhere else". Reproduced live
          // 2026-08-06: DB said menu 3, publish succeeded, AstDB still held
          // menu 1 because this repair landed after it.
          const expected = publishIsFresh ? [] : expectedDidmapKeys(mapping, slug);
          if (publishIsFresh) {
            app.log.info({ e164: mapping.e164 }, "[RECONCILER] skipping didmap check — a publish just landed");
          }
          if (expected.length > 0) {
            const live = await deps.readAstDbKeys(slug, expected[0].family, expected.map((k) => k.key), mapping.e164);
            const drifted = diffAstDbKeys(expected, live);
            if (drifted.length > 0) {
              await deps.republishDidmap(mapping, slug);
              app.log.warn({ e164: mapping.e164, drifted: drifted.map((d) => d.key) }, "[RECONCILER] didmap keys repaired");
              await sendAdminAlert(
                `reconciler-didmap-${mapping.id}`,
                `Repaired lost routing keys for ${mapping.e164}`,
                [
                  `These per-number keys were missing or wrong on the PBX and were republished: ${drifted.map((d) => d.key).join(", ")}.`,
                  "No action needed — this email exists so silent decay is never silent.",
                ],
                ALERT_DEDUPE_MS,
              );
            }
          }

          // 2c. Tenant menu keys intact? Once per tenant per cycle; replays
          // the last successful publish verbatim (never recomputes drafts).
          if (!menuCheckedTenants.has(mapping.tenantId)) {
            menuCheckedTenants.add(mapping.tenantId);
            // ⛔ NEVER fight a fresh publish. This replays the LAST publish's
            // keys; if an owner publishes while a cycle is mid-flight, the
            // replay writes the OLDER values over the new ones and the change
            // silently reverts — indistinguishable from "I published and it
            // didn't take". Caught by the e2e suite on 2026-08-06 (a greeting
            // change reverted between the publish and the call). A publish is
            // authoritative for its first minutes; drift repair can wait.
            if (publishIsFresh && publishedRec) {
              app.log.info(
                { tenantId: mapping.tenantId },
                "[RECONCILER] skipping menu check — a publish just landed and is authoritative",
              );
            } else if (publishedRec && publishedRec.keys.length > 0) {
              const published = publishedRec.keys;
              const byFamily = new Map<string, AstDbKV[]>();
              for (const kv of published) {
                const list = byFamily.get(kv.family) ?? [];
                list.push(kv);
                byFamily.set(kv.family, list);
              }
              const drifted: AstDbKV[] = [];
              let readLooksBroken = false;
              for (const [family, kvs] of byFamily) {
                // ⛔ The telephony read endpoint rejects >32 keys per call. A
                // per-menu family carries ~58, so an unchunked read 400s, every
                // key reads back "", and the whole family looks drifted — which
                // had this reconciler "repairing" healthy tenants every cycle
                // and emailing about it (2026-08-06).
                const live: AstDbKV[] = [];
                for (let i = 0; i < kvs.length; i += 32) {
                  const batch = kvs.slice(i, i + 32);
                  live.push(...(await deps.readAstDbKeys(slug, family, batch.map((k) => k.key))));
                }
                const familyDrift = diffAstDbKeys(kvs, live);
                // A read failure is indistinguishable from "everything missing"
                // at this layer (snapshotAstDbFamily returns "" on error). If a
                // family that should be fully populated comes back entirely
                // empty, assume the READ failed and repair nothing — a false
                // repair is a write to live routing based on no evidence.
                const expectedNonEmpty = kvs.filter((k) => k.value !== "").length;
                const liveNonEmpty = live.filter((k) => k.value !== "").length;
                if (expectedNonEmpty >= 3 && liveNonEmpty === 0) {
                  readLooksBroken = true;
                  app.log.warn({ tenantId: mapping.tenantId, family }, "[RECONCILER] AstDB read returned nothing — treating as unreadable, not drifted");
                  continue;
                }
                drifted.push(...familyDrift);
              }
              // Last line of defence against the same race: a publish may have
              // landed while we were reading. Re-check before writing, and
              // stand down if the tenant published in the meantime.
              const stillCurrent = await deps.lastSuccessfulPublishKeys(mapping.tenantId);
              const publishMovedUnderUs = !stillCurrent || stillCurrent.id !== publishedRec.id;
              if (drifted.length > 0 && !readLooksBroken && publishMovedUnderUs) {
                app.log.info({ tenantId: mapping.tenantId }, "[RECONCILER] a publish landed mid-cycle — standing down");
              } else if (drifted.length > 0 && !readLooksBroken) {
                await deps.replayLastMenuPublish(mapping.tenantId, slug, published);
                app.log.warn({ tenantId: mapping.tenantId, driftedCount: drifted.length }, "[RECONCILER] menu keys repaired");
                await sendAdminAlert(
                  `reconciler-menu-${mapping.tenantId}`,
                  `Repaired the published phone menu for a tenant`,
                  [
                    `Tenant: ${mapping.tenantId}`,
                    `${drifted.length} published menu key(s) were missing or wrong on the PBX (first: ${drifted[0].family}/${drifted[0].key}).`,
                    "The last published menu was replayed. No action needed.",
                  ],
                  ALERT_DEDUPE_MS,
                );
              }
            }
          }
        } catch (err: any) {
          app.log.error({ e164: mapping.e164, err: err?.message }, "[RECONCILER] mapping cycle error");
        }
      }
  } catch (err: any) {
    app.log.error({ err: err?.message }, "[RECONCILER] cycle crashed");
  }
}

export function startDidRouteReconciler(
  deps: DidRouteReconcilerDeps,
  intervalMs = 10 * 60 * 1000,
): NodeJS.Timeout {
  let running = false;
  const state: ReconcilerState = { lastReassertAt: new Map() };
  const cycle = async () => {
    if (running) return; // a slow PBX must not stack cycles
    running = true;
    try {
      await runReconcilerCycle(deps, state);
    } finally {
      running = false;
    }
  };

  // First pass shortly after boot (let telephony + helper come up), then steady.
  const bootTimer = setTimeout(() => { void cycle(); }, 90 * 1000);
  (bootTimer as any).unref?.();
  const timer = setInterval(() => { void cycle(); }, intervalMs);
  (timer as any).unref?.();
  return timer as any;
}
