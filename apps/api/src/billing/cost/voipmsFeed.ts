/**
 * VoIP.ms cost feed — pulls the carrier's OWN records into CarrierUsageRecord
 * so the cost card can say "Carrier CDR" and mean it.
 *
 * Built on the live response shapes probed 2026-09-17/18 (read-only, inside
 * app-api-1), not on the docs (the docs page is login-walled):
 *
 *  getCDR row   { date, callerid:'"NAME" <8457748366>', destination:"8452449666",
 *                 description:"Inbound DID", account:"344022" | "344022_gesheft",
 *                 disposition, seconds:"49", rate:"0.00900000", total:"0.00810000",
 *                 uniqueid:"4836113777", destination_type:"IN:USA"|"OUT:USA"|"OUT:INTL",
 *                 call_logs:"…\nDoing a CNAM lookup\nRouting to sub-account: 344022_gesheft\n…" }
 *  getSMS/getMMS row { id, date, type:"1"(received)|"0"(sent), did, contact, message, … }
 *  getTransactionHistory row { date, uniqueid, type:"DID8452136776"|"E911 8452136776"|"CNAM Queries",
 *                 description:"Frais mensuel de DID: 8452136776", ammount:"-1.10" }   (sic: ammount)
 *
 * Reconciliation proof: on 2026-09-17 the "CNAM Queries" transaction was
 * −$4.152 and 519 CDR rows carried "Doing a CNAM lookup" — 519 × $0.008 exactly.
 *
 * ⛔ Never store a message body, and NEVER call getSubAccounts here — it
 * returns every SIP password in the clear.
 * ⛔ Read-only against the carrier: every method used is a GET that changes
 * nothing on the account.
 */
import { db as realDb } from "@connect/db";
import { loadVoipMsAccountCreds, VOIPMS_PRIMARY_ACCOUNT_ID } from "../../voipMsAccounts";
import type { UsageKind } from "./costTypes";

export const VOIPMS_CARRIER = "VOIPMS";

export type UsageRecordInput = {
  carrier: string;
  accountId: string;
  externalId: string;
  kind: UsageKind;
  occurredAt: Date;
  numberE164: string | null;
  subAccount: string | null;
  tenantId: string | null;
  quantity: number;
  cost: number | null;
  description: string | null;
  raw: Record<string, unknown> | null;
};

export function toE164(raw: unknown): string | null {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  return `+1${d}`;
}

/** VoIP.ms dates are "YYYY-MM-DD HH:MM:SS" in the timezone we asked for (we ask for 0 = UTC). */
export function parseVoipmsDate(s: unknown): Date | null {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function subAccountFrom(row: any): string | null {
  const m = String(row?.call_logs ?? "").match(/Routing to sub-account:\s*(\S+)/i);
  if (m) return m[1];
  const acct = String(row?.account ?? "").trim();
  return acct.includes("_") ? acct : null;
}

/** One CDR row → the call record, plus a CNAM_LOOKUP record when the carrier logged one. */
export function parseVoipmsCdrRow(row: any, accountId: string): UsageRecordInput[] {
  const uniqueid = String(row?.uniqueid ?? "").trim();
  const occurredAt = parseVoipmsDate(row?.date);
  if (!uniqueid || !occurredAt) return [];
  const dtype = String(row?.destination_type ?? "").toUpperCase();
  const desc = String(row?.description ?? "");
  const isIn = dtype.startsWith("IN") || /inbound/i.test(desc);
  const kind: UsageKind = isIn ? "CALL_IN" : "CALL_OUT";
  const numberE164 = isIn ? toE164(row?.destination) : toE164(String(row?.callerid ?? "").match(/<([^>]+)>/)?.[1] ?? row?.callerid);
  const subAccount = subAccountFrom(row);
  const seconds = num(row?.seconds) ?? 0;
  const total = num(row?.total);
  const base: Omit<UsageRecordInput, "kind" | "externalId" | "quantity" | "cost" | "description"> = {
    carrier: VOIPMS_CARRIER,
    accountId,
    occurredAt,
    numberE164,
    subAccount,
    tenantId: null,
    raw: {
      disposition: row?.disposition ?? null,
      destination_type: row?.destination_type ?? null,
      rate: row?.rate ?? null,
      // the other party, digits only — never the CNAM name
      other: isIn ? toE164(String(row?.callerid ?? "").match(/<([^>]+)>/)?.[1]) : toE164(row?.destination),
    },
  };
  const out: UsageRecordInput[] = [
    { ...base, kind, externalId: uniqueid, quantity: seconds, cost: total, description: desc || null },
  ];
  if (/CNAM lookup/i.test(String(row?.call_logs ?? ""))) {
    out.push({ ...base, kind: "CNAM_LOOKUP", externalId: uniqueid, quantity: 1, cost: null, description: "CNAM lookup", raw: null });
  }
  return out;
}

/** getSMS / getMMS row → one message record. The body is never kept. */
export function parseVoipmsMessageRow(row: any, accountId: string, mms: boolean): UsageRecordInput | null {
  const id = String(row?.id ?? "").trim();
  const occurredAt = parseVoipmsDate(row?.date);
  if (!id || !occurredAt) return null;
  const received = String(row?.type ?? "") === "1";
  const kind: UsageKind = mms ? (received ? "MMS_IN" : "MMS_OUT") : received ? "SMS_IN" : "SMS_OUT";
  return {
    carrier: VOIPMS_CARRIER,
    accountId,
    externalId: `${mms ? "mms" : "sms"}:${id}`,
    kind,
    occurredAt,
    numberE164: toE164(row?.did),
    subAccount: null,
    tenantId: null,
    quantity: 1,
    cost: null,
    description: mms ? "Picture message" : "Text message",
    raw: { carrier_status: row?.carrier_status ?? null, other: toE164(row?.contact) },
  };
}

/** getTransactionHistory row → a fee record. Amounts are negative charges. */
export function parseVoipmsTransactionRow(row: any, accountId: string): UsageRecordInput | null {
  const type = String(row?.type ?? "").trim();
  const description = String(row?.description ?? "").trim();
  const amount = num(row?.ammount ?? row?.amount);
  if (amount === null) return null;
  const cost = -amount; // "-1.10" charged → cost 1.10; a credit becomes negative cost
  const dateStr = String(row?.date ?? "");
  const rangeMatch = dateStr.match(/^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/);
  const occurredAt = parseVoipmsDate(rangeMatch ? rangeMatch[1] : dateStr);
  if (!occurredAt) return null;
  let kind: UsageKind = "OTHER";
  let numberE164: string | null = null;
  if (/^DID\d{10,11}$/i.test(type)) {
    kind = "DID_MONTHLY";
    numberE164 = toE164(type.slice(3));
  } else if (/^E911\s*\d{10,11}$/i.test(type)) {
    kind = "E911_MONTHLY";
    numberE164 = toE164(type.replace(/^E911\s*/i, ""));
  } else if (/CNAM Queries/i.test(type) || /CNAM Queries/i.test(description)) {
    kind = "CNAM_DAILY";
  } else {
    numberE164 = toE164(description.match(/(\d{10,11})\b/)?.[1] ?? type.match(/(\d{10,11})\b/)?.[1]);
  }
  const uniqueid = String(row?.uniqueid ?? "").trim();
  const externalId =
    uniqueid && uniqueid !== "n/a"
      ? `tx:${uniqueid}`
      : `tx:${kind.toLowerCase()}:${rangeMatch ? rangeMatch[1] : dateStr.slice(0, 10)}:${type}`;
  return {
    carrier: VOIPMS_CARRIER,
    accountId,
    externalId,
    kind,
    occurredAt,
    numberE164,
    subAccount: null,
    tenantId: null,
    quantity: 1,
    cost,
    description: description.replace(/&[a-z]+;/g, "") || type,
    raw: { type },
  };
}

// ── tenant resolution ───────────────────────────────────────────────────────

export type NumberTenantMap = Map<string, string>;

type FeedDb = {
  tenantSmsNumber: { findMany: (args: any) => Promise<any[]> };
  pbxTenantInboundDid: { findMany: (args: any) => Promise<any[]> };
  carrierUsageRecord: {
    createMany: (args: any) => Promise<{ count: number }>;
    findMany: (args: any) => Promise<any[]>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  carrierSyncCursor: {
    findUnique: (args: any) => Promise<any>;
    upsert: (args: any) => Promise<any>;
  };
};

/**
 * number → Connect tenant. Texting assignment first (it is the number's owner
 * in Connect), then the PBX-synced inbound DID (unforgeable, PBX-synced — the
 * same signal the CDR ingest trusts).
 */
export async function buildNumberTenantMap(db: FeedDb): Promise<NumberTenantMap> {
  const map: NumberTenantMap = new Map();
  const dids = await db.pbxTenantInboundDid.findMany({
    where: { connectTenantId: { not: null } },
    select: { e164: true, connectTenantId: true, active: true, lastSeenAt: true },
    orderBy: { lastSeenAt: "asc" },
  });
  for (const d of dids) {
    const n = toE164(d.e164);
    if (n && d.connectTenantId) map.set(n, d.connectTenantId);
  }
  const sms = await db.tenantSmsNumber.findMany({
    where: { tenantId: { not: null } },
    select: { phoneE164: true, tenantId: true },
  });
  for (const s of sms) {
    const n = toE164(s.phoneE164);
    if (n && s.tenantId) map.set(n, s.tenantId);
  }
  return map;
}

export function resolveTenant(rec: UsageRecordInput, map: NumberTenantMap): string | null {
  if (rec.numberE164 && map.has(rec.numberE164)) return map.get(rec.numberE164)!;
  return null;
}

// ── the sync ────────────────────────────────────────────────────────────────

export type VoipmsApi = (method: string, params: Record<string, string>) => Promise<any>;

export function listOf(json: any, ...keys: string[]): any[] {
  for (const k of keys) if (Array.isArray(json?.[k])) return json[k];
  return [];
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export type DaySummary = { day: string; calls: number; cnam: number; messages: number; fees: number; inserted: number };

/**
 * Pull ONE day (UTC) of every record kind and insert what is new. Idempotent:
 * the unique (carrier, kind, externalId) makes a re-pull a no-op.
 * VoIP.ms `no_cdr` / "no_sms" statuses mean an empty day, not an error.
 */
export async function syncVoipmsDay(
  db: FeedDb,
  api: VoipmsApi,
  accountId: string,
  day: string,
  map: NumberTenantMap,
): Promise<DaySummary> {
  const recs: UsageRecordInput[] = [];
  const cdr = await api("getCDR", {
    date_from: day,
    date_to: day,
    answered: "1",
    noanswer: "1",
    busy: "1",
    failed: "1",
    timezone: "0",
    calltype: "all",
  });
  if (cdr?.status && cdr.status !== "success" && cdr.status !== "no_cdr") throw new Error(`getCDR ${cdr.status}`);
  let calls = 0;
  let cnam = 0;
  for (const row of listOf(cdr, "cdr")) {
    for (const r of parseVoipmsCdrRow(row, accountId)) {
      if (r.kind === "CNAM_LOOKUP") cnam += 1;
      else calls += 1;
      recs.push(r);
    }
  }
  const sms = await api("getSMS", { from: day, to: day, limit: "100000", timezone: "0" });
  if (sms?.status && sms.status !== "success" && sms.status !== "no_sms") throw new Error(`getSMS ${sms.status}`);
  const mms = await api("getMMS", { from: day, to: day, limit: "100000", timezone: "0" });
  if (mms?.status && mms.status !== "success" && mms.status !== "no_sms" && mms.status !== "no_mms") throw new Error(`getMMS ${mms.status}`);
  // getMMS returns MMS only on this account (probed: text-only rows appear
  // under getSMS with a different id space), so both lists are distinct.
  let messages = 0;
  for (const row of listOf(sms, "sms")) {
    const r = parseVoipmsMessageRow(row, accountId, false);
    if (r) {
      recs.push(r);
      messages += 1;
    }
  }
  for (const row of listOf(mms, "sms", "mms")) {
    const r = parseVoipmsMessageRow(row, accountId, true);
    if (r) {
      recs.push(r);
      messages += 1;
    }
  }
  const tx = await api("getTransactionHistory", { date_from: day, date_to: day });
  if (tx?.status && tx.status !== "success" && tx.status !== "no_transaction" && tx.status !== "no_transactions")
    throw new Error(`getTransactionHistory ${tx.status}`);
  let fees = 0;
  for (const row of listOf(tx, "transactions")) {
    const r = parseVoipmsTransactionRow(row, accountId);
    if (r) {
      recs.push(r);
      fees += 1;
    }
  }
  for (const r of recs) r.tenantId = resolveTenant(r, map);
  let inserted = 0;
  for (let i = 0; i < recs.length; i += 500) {
    const chunk = recs.slice(i, i + 500).map((r) => ({
      carrier: r.carrier,
      accountId: r.accountId,
      externalId: r.externalId,
      kind: r.kind,
      occurredAt: r.occurredAt,
      numberE164: r.numberE164,
      subAccount: r.subAccount,
      tenantId: r.tenantId,
      quantity: r.quantity,
      cost: r.cost,
      description: r.description,
      raw: r.raw ?? undefined,
    }));
    const res = await db.carrierUsageRecord.createMany({ data: chunk, skipDuplicates: true });
    inserted += res.count;
  }
  return { day, calls, cnam, messages, fees, inserted };
}

/** Rows that had no tenant when pulled get another chance (a number assigned since). */
export async function reresolveUnassigned(db: FeedDb, map: NumberTenantMap, since: Date): Promise<number> {
  const rows = await db.carrierUsageRecord.findMany({
    where: { tenantId: null, numberE164: { not: null }, occurredAt: { gte: since } },
    select: { id: true, numberE164: true },
    take: 20000,
  });
  const byTenant = new Map<string, string[]>();
  for (const r of rows) {
    const t = r.numberE164 ? map.get(r.numberE164) : undefined;
    if (!t) continue;
    if (!byTenant.has(t)) byTenant.set(t, []);
    byTenant.get(t)!.push(r.id);
  }
  let n = 0;
  for (const [tenantId, ids] of byTenant) {
    const res = await db.carrierUsageRecord.updateMany({ where: { id: { in: ids } }, data: { tenantId } });
    n += res.count;
  }
  return n;
}

export function cursorId(accountId: string): string {
  return `voipms:${accountId}`;
}

export type SyncResult = { accountId: string; days: DaySummary[]; reresolved: number; error: string | null };

/**
 * Sync a date range (inclusive, UTC days). Newest day first is NOT done —
 * oldest first so a failure leaves a contiguous covered range and the cursor
 * is honest. The cursor's lastDate = the last day fully pulled.
 */
export async function runVoipmsCostSync(
  db: FeedDb,
  api: VoipmsApi,
  opts: { accountId?: string; from: Date; to: Date; log?: (m: string) => void; pauseMs?: number },
): Promise<SyncResult> {
  const accountId = opts.accountId || VOIPMS_PRIMARY_ACCOUNT_ID;
  const map = await buildNumberTenantMap(db);
  const days: DaySummary[] = [];
  let error: string | null = null;
  const start = new Date(Date.UTC(opts.from.getUTCFullYear(), opts.from.getUTCMonth(), opts.from.getUTCDate()));
  const end = new Date(Date.UTC(opts.to.getUTCFullYear(), opts.to.getUTCMonth(), opts.to.getUTCDate()));
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) {
    const day = ymd(d);
    try {
      const s = await syncVoipmsDay(db, api, accountId, day, map);
      days.push(s);
      opts.log?.(`[CARRIER_COST] voipms ${day}: calls=${s.calls} cnam=${s.cnam} messages=${s.messages} fees=${s.fees} inserted=${s.inserted}`);
      await db.carrierSyncCursor.upsert({
        where: { id: cursorId(accountId) },
        create: { id: cursorId(accountId), lastDate: d, lastRunAt: new Date(), lastError: null, lastSummary: s },
        update: { lastDate: d, lastRunAt: new Date(), lastError: null, lastSummary: s },
      });
    } catch (e: any) {
      error = `${day}: ${e?.message || String(e)}`;
      opts.log?.(`[CARRIER_COST] voipms ${day} FAILED: ${error}`);
      await db.carrierSyncCursor.upsert({
        where: { id: cursorId(accountId) },
        create: { id: cursorId(accountId), lastRunAt: new Date(), lastError: error },
        update: { lastRunAt: new Date(), lastError: error },
      });
      break;
    }
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }
  const reresolved = await reresolveUnassigned(db, map, start);
  return { accountId, days, reresolved, error };
}

/** The real API, from the stored (encrypted) credentials of one account row. */
export function voipmsApiForAccount(accountId: string = VOIPMS_PRIMARY_ACCOUNT_ID, db: any = realDb): VoipmsApi {
  return async (method, params) => {
    const creds = await loadVoipMsAccountCreds(accountId, db);
    if (!creds) throw new Error("VOIPMS_NOT_CONFIGURED");
    const base = (creds.apiBaseUrl || "https://voip.ms/api/v1/rest.php").replace(/\/$/, "");
    const url = new URL(base);
    url.searchParams.set("api_username", creds.username);
    url.searchParams.set("api_password", creds.password);
    url.searchParams.set("method", method);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { method: "GET", signal: AbortSignal.timeout(90_000) });
    return res.json().catch(() => ({ status: "bad_json" }));
  };
}
