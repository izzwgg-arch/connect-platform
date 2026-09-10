/**
 * The arrival watcher — the piece that makes "zero downtime" real rather than
 * hoped for.
 *
 * A port completes at the carrier at a moment nobody tells us about. From that
 * moment the number is on the SignalWire account with NO routing on it, so an
 * incoming call has nowhere to go. Pointing it at our trunk closes that gap,
 * and the size of the gap is the whole promise: this sweep looks every 30
 * seconds on the day a number is due, and points it the moment it appears.
 *
 * ⛔⛔ THE SAFETY RULE: this is the only code in the platform that writes to a
 * live carrier's routing on a timer, so it FAILS CLOSED. It touches a number
 * ONLY when a person has filed that exact number and it is still waiting
 * (`decideClaim`). A number that turns up on the SignalWire account without a
 * filed row — a test number, a number somebody bought by hand — is ignored,
 * because we do not own the intent behind it.
 *
 * ⛔ It never moves texting. `TenantSmsNumber.provider` decides both who sends
 * and whether the VoIP.ms poll still reads the number, and SignalWire refuses
 * to send from a number that is not on an approved campaign — so flipping it
 * automatically would take a customer's outbound texting away. That is an
 * explicit action behind a gate (`decideSmsSwitch`).
 *
 * ⛔ The proof it ran is the `carrier_migration.sweep` audit row, written on
 * EVERY completed pass including quiet ones — never the boot line (the
 * "ARMED is not working" rule). State lives in the database, never a module
 * variable: the api restarts dozens of times a day.
 *
 * Kill switch: CARRIER_MIGRATION_WATCH_DISABLED=1.
 */

import { createHash } from "node:crypto";
import { decideClaim, carrierMigrationE164, formatDid, normalizeDid } from "./board";

const DEFAULT_INTERVAL_MS = 30_000;
/** Beside the interval, never instead of it — a bare setInterval is starved to
 *  nothing on a busy deploy day (the watchdog lesson). */
const DEFAULT_BOOT_DELAY_MS = 45_000;

export interface WatchDeps {
  db: any;
  /** Resolved SignalWire credentials, or null when none are stored. */
  resolveCredentials: () => Promise<any | null>;
  /** Every number on the SignalWire project. */
  listNumbers: (creds: any) => Promise<Array<{ id: string; number: string }>>;
  /** Point a number's call + message handlers at us. */
  updateNumberHandlers: (creds: any, id: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** The PBX SIP endpoint every SignalWire number's voice routes to. */
  resolvePbxSipEndpointId: (creds: any, deps: { listNumbers: (c: any) => Promise<any[]> }, owned?: any[]) => Promise<string | null>;
  /** The URL SignalWire posts inbound texts to. */
  inboundSmsWebhookUrl: () => string;
  log?: { info?: (o: any) => void; warn?: (o: any) => void; error?: (o: any) => void };
}

export interface SweepResult {
  considered: number;
  promotedToLanding: number;
  claimed: number;
  errors: Array<{ did: string; error: string }>;
  skippedNoCredentials: boolean;
  /** True when nothing was awaiting arrival, so no carrier call was made. */
  quiet: boolean;
}

function audit(db: any, event: string, payload: Record<string, unknown>): Promise<void> {
  const body = { actor: "system", event, payload };
  return db.agentAuditLog
    .create({
      data: {
        actor: body.actor,
        event: body.event,
        payload: body.payload as any,
        // ⛔ `hash` and `actor` are both REQUIRED columns — without them Prisma
        // rejects the write and a monitor goes blind while still looking armed.
        hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      },
    })
    .then(() => undefined)
    .catch(() => undefined);
}

/**
 * Rows whose confirmed date has arrived move `filed` → `landing`, so the board
 * reads "landing today" rather than a date in the past. Purely cosmetic to the
 * carrier, load-bearing to the person watching.
 */
function isDue(focDate: Date | null, now: Date): boolean {
  if (!focDate) return true; // no date recorded — assume it could land any time
  return focDate.getTime() <= now.getTime();
}

export async function runCarrierMigrationSweep(deps: WatchDeps, now: Date = new Date()): Promise<SweepResult> {
  const { db } = deps;
  const out: SweepResult = {
    considered: 0,
    promotedToLanding: 0,
    claimed: 0,
    errors: [],
    skippedNoCredentials: false,
    quiet: true,
  };

  const waiting: any[] = await db.carrierMigration.findMany({
    where: { status: { in: ["filed", "landing"] } },
    orderBy: { focDate: "asc" },
    take: 200,
  });
  out.considered = waiting.length;
  if (waiting.length === 0) {
    await audit(db, "carrier_migration.sweep", { ...out, quiet: true });
    return out;
  }

  // Only rows that could actually land today cost a carrier call.
  const due = waiting.filter((r) => isDue(r.focDate ? new Date(r.focDate) : null, now));
  if (due.length === 0) {
    await audit(db, "carrier_migration.sweep", { ...out, quiet: true, waiting: waiting.length });
    return out;
  }
  out.quiet = false;

  const creds = await deps.resolveCredentials().catch(() => null);
  if (!creds) {
    out.skippedNoCredentials = true;
    await audit(db, "carrier_migration.sweep", { ...out, reason: "no_credentials" });
    return out;
  }

  let owned: Array<{ id: string; number: string }> = [];
  try {
    owned = await deps.listNumbers(creds);
  } catch (e: any) {
    const msg = String(e?.message || e || "unknown");
    out.errors.push({ did: "*", error: msg });
    await audit(db, "carrier_migration.sweep", { ...out, reason: "list_failed" });
    deps.log?.warn?.({ event: "carrier_migration_list_failed", error: msg });
    return out;
  }

  // Index the account's numbers by bare 10 digits, once.
  const onAccount = new Map<string, { id: string; number: string }>();
  for (const n of owned) {
    const d = normalizeDid(n.number);
    if (d) onAccount.set(d, n);
  }

  let endpointId: string | null = null;

  for (const row of due) {
    const did = normalizeDid(row.did);
    if (!did) continue;
    const hit = onAccount.get(did);

    // Promote a due row so the board says "landing today".
    if (row.status === "filed") {
      await db.carrierMigration.update({ where: { id: row.id }, data: { status: "landing" } }).catch(() => undefined);
      out.promotedToLanding += 1;
      row.status = "landing";
    }

    const decision = decideClaim(row, Boolean(hit));
    if (!decision.claim) {
      await db.carrierMigration
        .update({ where: { id: row.id }, data: { lastCheckedAt: now } })
        .catch(() => undefined);
      continue;
    }

    // ⛔ Resolved lazily and once per sweep: without an endpoint we must not
    // touch the number at all — a number pointed at the wrong endpoint is a
    // customer whose calls go somewhere else.
    if (!endpointId) {
      endpointId = await deps
        .resolvePbxSipEndpointId(creds, { listNumbers: deps.listNumbers }, owned)
        .catch(() => null);
    }
    if (!endpointId) {
      const error = "signalwire_pbx_endpoint_not_found";
      out.errors.push({ did, error });
      await db.carrierMigration
        .update({ where: { id: row.id }, data: { lastCheckedAt: now, lastError: error } })
        .catch(() => undefined);
      continue;
    }

    // The number is here. Claim it — this is the moment the gap closes.
    const landedAt = row.landedAt ? new Date(row.landedAt) : now;
    try {
      await deps.updateNumberHandlers(creds, hit!.id, {
        name: `Loopcom ${formatDid(did)}`.slice(0, 80),
        callHandler: "relay_sip_endpoint",
        callSipEndpointId: endpointId,
        messageHandler: "laml_webhooks",
        messageRequestUrl: deps.inboundSmsWebhookUrl(),
      });
      const pointedAt = new Date();
      await db.carrierMigration.update({
        where: { id: row.id },
        data: {
          status: "live",
          voiceCarrier: "signalwire",
          swNumberId: hit!.id,
          landedAt,
          pointedAt,
          lastCheckedAt: now,
          lastError: null,
        },
      });
      out.claimed += 1;
      await audit(db, "carrier_migration.claimed", {
        did,
        e164: carrierMigrationE164(did),
        swNumberId: hit!.id,
        endpointId,
        landedAt: landedAt.toISOString(),
        pointedAt: pointedAt.toISOString(),
        gapSeconds: Math.round((pointedAt.getTime() - landedAt.getTime()) / 1000),
      });
      deps.log?.info?.({ event: "carrier_migration_claimed", did, swNumberId: hit!.id });
    } catch (e: any) {
      const error = String(e?.message || e || "unknown");
      out.errors.push({ did, error });
      // Record that we SAW it even though pointing failed — the next sweep
      // retries the pointing, and the gap measurement stays honest.
      await db.carrierMigration
        .update({ where: { id: row.id }, data: { landedAt, lastCheckedAt: now, lastError: error } })
        .catch(() => undefined);
      await audit(db, "carrier_migration.claim_failed", { did, error });
      deps.log?.warn?.({ event: "carrier_migration_claim_failed", did, error });
    }
  }

  await audit(db, "carrier_migration.sweep", out as unknown as Record<string, unknown>);
  return out;
}

export function carrierMigrationWatchDisabled(): boolean {
  return String(process.env.CARRIER_MIGRATION_WATCH_DISABLED || "").trim() === "1";
}

export function startCarrierMigrationWatch(deps: WatchDeps): void {
  if (carrierMigrationWatchDisabled()) {
    deps.log?.info?.({ event: "CARRIER_MIGRATION_WATCH_DISABLED" });
    return;
  }
  const intervalMs = Number(process.env.CARRIER_MIGRATION_WATCH_MS || DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const bootMs = Number(process.env.CARRIER_MIGRATION_WATCH_BOOT_MS || DEFAULT_BOOT_DELAY_MS) || DEFAULT_BOOT_DELAY_MS;

  const tick = () => {
    runCarrierMigrationSweep(deps).catch((e) => deps.log?.error?.({ event: "carrier_migration_sweep_threw", error: String(e?.message || e) }));
  };

  // Cast: the api's lib includes DOM, whose setTimeout returns a number.
  const boot = setTimeout(tick, bootMs) as unknown as { unref?: () => void };
  const loop = setInterval(tick, intervalMs) as unknown as { unref?: () => void };
  boot.unref?.();
  loop.unref?.();
  deps.log?.info?.({ event: "CARRIER_MIGRATION_WATCH_ARMED", intervalMs, bootMs });
}
