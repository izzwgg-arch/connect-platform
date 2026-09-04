/**
 * VoIP.ms trunk guardrail — catches a customer's number that VoIP.ms can no
 * longer deliver to us, from the CARRIER's own point of view.
 *
 * WHY THIS EXISTS (2026-09-04): inii mini's number 646-984-6023 handed every
 * caller a busy signal from 2026-09-02 15:49 EDT until the customer complained
 * two days later — about 146 lost calls. The mechanism: VoIP.ms held two
 * subaccount rows under one login name (created 2026-08-05, when their write
 * path timed out on our side and landed anyway — see NON_IDEMPOTENT_METHODS in
 * voipMsProvisioning.ts), their registrar started answering 403 to the PBX's
 * password, Asterisk gave up after `max_retries`, and NOTHING on the platform
 * watched the carrier side. Two hand-run watcher scripts died the next day
 * (one when a deploy recreated the api container, one at its 24 h cap) and
 * nobody was told. The PBX's own view is not enough: a trunk that has given
 * up retrying simply reads "Rejected" forever, silently.
 *
 * WHAT IT DOES, every sweep:
 *   1. getSubAccounts — any login name that exists more than once is an
 *      alarm on its own (that is the fault that starts this whole chain).
 *   2. getDIDsInfo — every number routed `account:<subaccount>`.
 *   3. getRegistrationStatus for each of those subaccounts (the master
 *      account itself is the spare pool and never registers).
 *   4. A subaccount holding a live number that reads `registered: no` on TWO
 *      consecutive sweeps is an alarm (one sweep can catch a refresh in
 *      flight; two, 30 minutes apart, cannot). State lives in the audit row
 *      of the previous sweep — never a module variable, the api restarts
 *      dozens of times a day.
 *   5. Alarms are AgentEscalation rows — the only channel that reaches a
 *      phone; ⛔ never ADMIN_ALERT, which is muted at the send door. Each key
 *      is de-duped over a bounded window (default 6 h) so a persistent fault
 *      texts once per shift, not every half hour, and re-arms by itself.
 *   6. Every run, clean or not, writes `voipms_trunk.sweep` to AgentAuditLog
 *      with `actor` + `hash` — the row IS the state, and a run that writes
 *      nothing leaves the next run unable to tell new from old.
 *
 * FAILS TOWARD SILENCE ON PROVIDER ERROR, LOUDLY: a sweep that cannot reach
 * VoIP.ms logs `sweep FAILED` and writes nothing — an outage at the carrier is
 * not "every trunk is down", and texting the owner 60 times during one is how
 * an alarm gets muted.
 */

import { createHash } from "node:crypto";
import { db } from "@connect/db";
import { loadMasterCreds, vms, type VmsCreds } from "./voipMsProvisioning";

export type Log = { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void };

export const UNREGISTERED_ALARM_KEY = "A phone number cannot receive calls — VoIP.ms trunk not registered";
export const DUPLICATE_ALARM_KEY = "VoIP.ms holds duplicate subaccount rows";
export const SWEEP_EVENT = "voipms_trunk.sweep";
/** Platform tenant the escalation is filed under (same as the other guardrails). */
const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

export type TrunkState = {
  /** login name → number of rows VoIP.ms holds under it */
  rowsByName: Map<string, number>;
  /** subaccount login → numbers routed to it (`account:<login>`) */
  didsByAccount: Map<string, string[]>;
  /** subaccount login → VoIP.ms `registered` ("yes"/"no"), or "error:<msg>" */
  registration: Map<string, string>;
  /** the master account number (routing `account:<master>` = the spare pool) */
  master: string;
};

export type Offender = { account: string; dids: string[]; tenant: string | null; registered: string };

export type TrunkVerdict = {
  duplicates: Array<{ account: string; rows: number }>;
  /** unregistered on THIS sweep (candidates for next time) */
  unregisteredNow: string[];
  /** unregistered now AND on the previous sweep — the ones that alarm */
  offenders: Offender[];
  unregisteredSummary: string;
  unregisteredSms: string;
  unregisteredReport: string;
  duplicateSummary: string;
  duplicateSms: string;
  duplicateReport: string;
};

/** Pure: decide what alarms, given this sweep's reading and the previous sweep's unregistered list. */
export function decideTrunkVerdict(input: {
  state: TrunkState;
  previousUnregistered: string[];
  tenantNameByDid?: Map<string, string>;
}): TrunkVerdict {
  const { state } = input;
  const duplicates = [...state.rowsByName]
    .filter(([, n]) => n > 1)
    .map(([account, rows]) => ({ account, rows }))
    .sort((a, b) => a.account.localeCompare(b.account));

  const unregisteredNow = [...state.didsByAccount]
    .filter(([acct]) => acct !== state.master)
    .filter(([acct]) => String(state.registration.get(acct) ?? "").toLowerCase() === "no")
    .map(([acct]) => acct)
    .sort();

  const prev = new Set(input.previousUnregistered);
  const offenders: Offender[] = unregisteredNow
    .filter((acct) => prev.has(acct))
    .map((acct) => {
      const dids = state.didsByAccount.get(acct) || [];
      const tenant = dids.map((d) => input.tenantNameByDid?.get(d)).find(Boolean) || null;
      return { account: acct, dids, tenant, registered: String(state.registration.get(acct)) };
    });

  const fmt = (d: string) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);
  const who = (o: Offender) => `${o.dids.map(fmt).join(", ")}${o.tenant ? ` (${o.tenant})` : ""}`;
  const plural = offenders.length === 1 ? "" : "s";
  const unregisteredSummary = offenders.length
    ? `${UNREGISTERED_ALARM_KEY} — ${offenders.length} number${plural}: ${offenders.map(who).join("; ")}`
    : `${UNREGISTERED_ALARM_KEY} — none`;
  const unregisteredSms = offenders.length
    ? `Calls are FAILING (busy signal) on ${offenders.map(who).join("; ")}: VoIP.ms says the trunk has no registration. Check "pjsip show registrations" on the PBX.`
    : "";
  const unregisteredReport = offenders.length
    ? [
        "ISSUE",
        `VoIP.ms reports no registration for ${offenders.length} subaccount${plural} that carry live numbers. Callers to those numbers get a busy signal — the carrier has nowhere to send the call.`,
        "",
        "AFFECTED",
        ...offenders.map((o) => `- ${o.account}: ${o.dids.map(fmt).join(", ")}${o.tenant ? ` — ${o.tenant}` : ""}`),
        "",
        "FINDINGS",
        "getRegistrationStatus read registered=no on two consecutive sweeps (30 min apart).",
        "The 2026-09-02 shape: the PBX's REGISTER answers 403 after a valid digest and Asterisk",
        "stops retrying after max_retries, so the PBX side reads Rejected forever and stays silent.",
        "",
        "PROPOSED FIX",
        "1. On the PBX: pjsip show registrations | grep <subaccount>; pjsip send register <subaccount> (bare name, not -oauth).",
        "2. If it still reads Rejected/403: rotate the subaccount to a NEW password at VoIP.ms (setSubAccount, full update,",
        "   carry default_e911), write it to ombu_trunk_parameters outgoing_remotesecret + the pjsip__50-1-trunks.conf",
        "   password= line (cat tmp > file, keep ACLs), module reload res_pjsip.so, send register. Store it on the",
        "   submission's voipmsSubaccountEncrypted. Recipe: AGENT_HANDOFF_VOIPMS_DUPLICATE_SUBACCOUNTS_2026-09-02.md §9.",
        "3. Prove it with a real call and the carrier CDR (ANSWERED), never from the PBX alone.",
      ].join("\n")
    : "";

  const dplural = duplicates.length === 1 ? "" : "s";
  const duplicateSummary = duplicates.length
    ? `${DUPLICATE_ALARM_KEY} — ${duplicates.length} login name${dplural}: ${duplicates.map((d) => `${d.account} x${d.rows}`).join(", ")}`
    : `${DUPLICATE_ALARM_KEY} — none`;
  const duplicateSms = duplicates.length
    ? `VoIP.ms holds ${duplicates.map((d) => `${d.rows} rows for ${d.account}`).join(", ")}. The trunk will stop registering after their next outage — delete the extra rows now.`
    : "";
  const duplicateReport = duplicates.length
    ? [
        "ISSUE",
        "VoIP.ms holds more than one subaccount row under a single login name. The PBX trunk can only hold one password,",
        "and VoIP.ms's registrar answers 403 for a login whose rows disagree (2026-09-02: Matamim and inii mini).",
        "",
        "AFFECTED",
        ...duplicates.map((d) => `- ${d.account}: ${d.rows} rows`),
        "",
        "FINDINGS",
        "Rows under one name are created when a createSubAccount times out on our side but lands at VoIP.ms and is",
        "retried (2026-08-05). vms() no longer retries creating writes, so a new set means the fault is elsewhere — find it.",
        "",
        "PROPOSED FIX",
        "getSubAccounts, keep the LOWEST id (the row the PBX trunk was built against — compare password hashes), delSubAccount the",
        "others, then re-assert setDIDRouting for every number on that name. If REGISTER still 403s afterwards, rotate the",
        "surviving row's password and apply it to the trunk (handoff §9).",
      ].join("\n")
    : "";

  return {
    duplicates,
    unregisteredNow,
    offenders,
    unregisteredSummary,
    unregisteredSms,
    unregisteredReport,
    duplicateSummary,
    duplicateSms,
    duplicateReport,
  };
}

/** Read the whole picture from VoIP.ms (read-only; three method families). */
export async function fetchTrunkState(creds: VmsCreds, call: typeof vms = vms): Promise<TrunkState> {
  const subs: any[] = ((await call(creds, "getSubAccounts"))?.accounts ?? []) as any[];
  const rowsByName = new Map<string, number>();
  for (const a of subs) {
    const name = String(a?.account || "");
    if (name) rowsByName.set(name, (rowsByName.get(name) || 0) + 1);
  }
  const master = String(subs[0]?.account || "").split("_")[0] || String(creds.username || "");

  const dids: any[] = ((await call(creds, "getDIDsInfo"))?.dids ?? []) as any[];
  const didsByAccount = new Map<string, string[]>();
  for (const d of dids) {
    const routing = String(d?.routing || "");
    if (!routing.startsWith("account:")) continue;
    const acct = routing.slice("account:".length);
    didsByAccount.set(acct, [...(didsByAccount.get(acct) || []), String(d?.did || "")]);
  }

  const registration = new Map<string, string>();
  for (const acct of didsByAccount.keys()) {
    if (acct === master) continue;
    try {
      const st = await call(creds, "getRegistrationStatus", { account: acct });
      registration.set(acct, String(st?.registered ?? "unknown"));
    } catch (e: any) {
      registration.set(acct, `error:${String(e?.message || e).slice(0, 80)}`);
    }
  }
  return { rowsByName, didsByAccount, registration, master };
}

/** Best-effort: number → company name, from Connect's mirror of the PBX inbound routes. */
export async function tenantNamesForDids(dids: string[], database: any = db): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!dids.length) return out;
  try {
    const rows: any[] = await database.pbxTenantInboundDid.findMany({
      where: { e164: { in: dids } },
      select: { e164: true, pbxTenantCode: true },
    });
    const codes = [...new Set(rows.map((r) => String(r.pbxTenantCode || "")).filter(Boolean))];
    if (!codes.length) return out;
    const links: any[] = await database.tenantPbxLink.findMany({
      where: { pbxTenantCode: { in: codes } },
      select: { pbxTenantCode: true, tenant: { select: { name: true, pbxRemovedAt: true } } },
    });
    const nameByCode = new Map<string, string>();
    for (const l of links) if (l.tenant?.name && !l.tenant?.pbxRemovedAt) nameByCode.set(String(l.pbxTenantCode), String(l.tenant.name));
    for (const r of rows) {
      const n = nameByCode.get(String(r.pbxTenantCode || ""));
      if (n) out.set(String(r.e164), n);
    }
  } catch {
    /* names are decoration on the alarm — never let a lookup failure silence it */
  }
  return out;
}

/** The previous sweep's unregistered list, read from its audit row (null = no previous sweep). */
export async function readPreviousUnregistered(database: any = db): Promise<string[] | null> {
  const row = await database.agentAuditLog.findFirst({
    where: { event: SWEEP_EVENT },
    orderBy: { ts: "desc" },
    select: { payload: true },
  });
  if (!row) return null;
  const list = (row.payload as any)?.unregisteredNow;
  return Array.isArray(list) ? list.map(String) : [];
}

/** Raise one escalation for a key unless one was raised inside the window. Returns true when raised. */
export async function raiseTrunkEscalation(
  key: string,
  text: { summary: string; sms: string; report: string },
  opts: { windowMs: number; log?: Log; database?: any },
): Promise<boolean> {
  const database = opts.database ?? db;
  const since = new Date(Date.now() - opts.windowMs);
  const recent = await database.agentEscalation.findFirst({
    where: { requestSummary: { startsWith: key }, createdAt: { gte: since } },
    select: { id: true },
  });
  if (recent) {
    opts.log?.info?.({ existing: recent.id, key }, "voipms-trunk: already alerted inside the window");
    return false;
  }
  await database.agentEscalation.create({
    data: {
      tenantId: ADMIN_ALERT_TENANT_ID,
      tenantName: "Loopcom platform",
      clientUserId: null,
      userName: "voipms trunk guardrail",
      userEmail: null,
      requestSummary: text.summary,
      smsBody: text.sms,
      report: text.report,
      proposedFix: "",
      researchDegraded: false,
      status: "QUEUED",
    },
  });
  opts.log?.warn?.({ key }, "voipms-trunk: escalation raised");
  return true;
}

export async function runVoipmsTrunkSweep(opts?: {
  log?: Log;
  database?: any;
  windowMs?: number;
  fetch?: () => Promise<TrunkState | null>;
  now?: () => number;
}): Promise<{ ran: boolean; offenders: number; duplicates: number; alerted: boolean }> {
  const log = opts?.log;
  const database = opts?.database ?? db;
  const windowMs = opts?.windowMs ?? Number(process.env.VOIPMS_TRUNK_ALERT_WINDOW_MS || 6 * 60 * 60 * 1000);
  try {
    let state: TrunkState | null;
    if (opts?.fetch) state = await opts.fetch();
    else {
      const creds = await loadMasterCreds();
      state = creds ? await fetchTrunkState(creds) : null;
    }
    if (!state) {
      log?.warn?.({}, "voipms-trunk: no VoIP.ms credentials — cannot check");
      return { ran: false, offenders: 0, duplicates: 0, alerted: false };
    }
    const previous = await readPreviousUnregistered(database);
    const allDids = [...state.didsByAccount].filter(([a]) => a !== state!.master).flatMap(([, d]) => d);
    const tenantNameByDid = await tenantNamesForDids(allDids, database);
    const verdict = decideTrunkVerdict({ state, previousUnregistered: previous ?? [], tenantNameByDid });

    let alerted = false;
    if (verdict.offenders.length) {
      alerted =
        (await raiseTrunkEscalation(
          UNREGISTERED_ALARM_KEY,
          { summary: verdict.unregisteredSummary, sms: verdict.unregisteredSms, report: verdict.unregisteredReport },
          { windowMs, log, database },
        )) || alerted;
    }
    if (verdict.duplicates.length) {
      alerted =
        (await raiseTrunkEscalation(
          DUPLICATE_ALARM_KEY,
          { summary: verdict.duplicateSummary, sms: verdict.duplicateSms, report: verdict.duplicateReport },
          { windowMs, log, database },
        )) || alerted;
    }

    const payload = {
      checked: [...state.didsByAccount.keys()].filter((a) => a !== state!.master).length,
      unregisteredNow: verdict.unregisteredNow,
      offenders: verdict.offenders.map((o) => `${o.account}:${o.dids.join(",")}`),
      duplicates: verdict.duplicates.map((d) => `${d.account}x${d.rows}`),
      firstSweep: previous === null,
      alerted,
    };
    await database.agentAuditLog.create({
      data: {
        event: SWEEP_EVENT,
        actor: "voipms-trunk-guardrail",
        hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32),
        payload,
      },
    });
    log?.info?.(payload, "voipms-trunk: sweep complete");
    return { ran: true, offenders: verdict.offenders.length, duplicates: verdict.duplicates.length, alerted };
  } catch (err) {
    log?.warn?.({ err: (err as Error)?.message }, "voipms-trunk: sweep FAILED");
    return { ran: false, offenders: 0, duplicates: 0, alerted: false };
  }
}

/** Arm the sweep: a boot kick (so a restart never leaves a blind gap) plus a 30-minute interval. */
export function startVoipmsTrunkGuardrail(log?: Log): void {
  if (String(process.env.VOIPMS_TRUNK_GUARDRAIL_DISABLED || "") === "1") {
    log?.info?.({}, "VOIPMS_TRUNK_GUARDRAIL_DISABLED=1 — not arming");
    return;
  }
  const intervalMs = Number(process.env.VOIPMS_TRUNK_SWEEP_INTERVAL_MS || 30 * 60 * 1000);
  const bootDelayMs = Number(process.env.VOIPMS_TRUNK_SWEEP_BOOT_DELAY_MS || 3 * 60 * 1000);
  setTimeout(() => {
    void runVoipmsTrunkSweep({ log });
  }, bootDelayMs);
  setInterval(() => {
    void runVoipmsTrunkSweep({ log });
  }, intervalMs);
  log?.info?.({ intervalMs, bootDelayMs }, "VOIPMS_TRUNK_GUARDRAIL_ARMED");
}
