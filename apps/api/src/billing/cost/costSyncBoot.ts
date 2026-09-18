/**
 * The VoIP.ms cost feed's timer. Runs shortly after boot (a timer with no boot
 * run is starved by deploys — [[interval-timer-with-no-boot-run-is-starved-by-deploys]])
 * and then every 6 hours: re-pulls from two days before the cursor (late
 * rows) through today. Idempotent, read-only against the carrier.
 *
 * Off switch: CARRIER_COST_SYNC_DISABLED=1.
 */
import { db } from "@connect/db";
import { VOIPMS_PRIMARY_ACCOUNT_ID } from "../../voipMsAccounts";
import { cursorId, runVoipmsCostSync, voipmsApiForAccount } from "./voipmsFeed";

type Log = { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };

const SIX_HOURS = 6 * 60 * 60 * 1000;
const BOOT_DELAY = 90_000;
/** With no cursor, how far back the first run reaches. History is backfilled by hand via POST /admin/billing/cost/sync. */
const FIRST_RUN_DAYS = 14;

export function computeSyncWindow(cursorLastDate: Date | null, now: Date): { from: Date; to: Date } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = cursorLastDate
    ? new Date(Date.UTC(cursorLastDate.getUTCFullYear(), cursorLastDate.getUTCMonth(), cursorLastDate.getUTCDate()) - 2 * 86_400_000)
    : new Date(today.getTime() - FIRST_RUN_DAYS * 86_400_000);
  return { from, to: today };
}

let running = false;

export async function runCarrierCostSyncOnce(log: Log): Promise<void> {
  if (running) {
    log.warn({}, "[CARRIER_COST] sync already running — skipped");
    return;
  }
  running = true;
  try {
    const d = db as any;
    const cursor = await d.carrierSyncCursor.findUnique({ where: { id: cursorId(VOIPMS_PRIMARY_ACCOUNT_ID) } });
    const { from, to } = computeSyncWindow(cursor?.lastDate ? new Date(cursor.lastDate) : null, new Date());
    const res = await runVoipmsCostSync(d, voipmsApiForAccount(VOIPMS_PRIMARY_ACCOUNT_ID), {
      accountId: VOIPMS_PRIMARY_ACCOUNT_ID,
      from,
      to,
      pauseMs: 250,
      log: (m) => log.info({}, m),
    });
    const inserted = res.days.reduce((s, x) => s + x.inserted, 0);
    log.info({ days: res.days.length, inserted, reresolved: res.reresolved, error: res.error }, "[CARRIER_COST] voipms sync done");
  } catch (e: any) {
    log.warn({ err: e?.message || String(e) }, "[CARRIER_COST] voipms sync failed");
  } finally {
    running = false;
  }
}

export function startCarrierCostSync(log: Log): NodeJS.Timeout | null {
  if (process.env.CARRIER_COST_SYNC_DISABLED === "1") {
    log.info({}, "[CARRIER_COST] sync disabled by CARRIER_COST_SYNC_DISABLED=1");
    return null;
  }
  const boot = setTimeout(() => void runCarrierCostSyncOnce(log), BOOT_DELAY);
  boot.unref?.();
  const t = setInterval(() => void runCarrierCostSyncOnce(log), SIX_HOURS);
  t.unref?.();
  return t;
}
