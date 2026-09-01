/**
 * Voicemail mailbox guardrail — catches a customer who cannot receive a voicemail.
 *
 * WHY THIS EXISTS (2026-08-23): Fixup Group ext 103 "Office" and McNamara Lion
 * ext 101 "Juda Poisner" had each been unable to take a voicemail since the day
 * they were created — two months and four months. Neither customer reported it,
 * because it never worked once: there is no "it stopped" to notice, Connect's
 * voicemail screen shows an empty list either way, and unanswered calls may
 * follow-me to a mobile whose own voicemail answers instead.
 *
 * The fault is a schema default: `ombu_extensions_vm.enabled` defaults to 'no',
 * so an extension created without somebody explicitly switching voicemail on
 * gets no mailbox in Asterisk, no spool directory, and no way for a caller to
 * leave a message. The sign-up wizard is immune (it sends vm_enabled: "yes"
 * explicitly); hand-creation through the VitalPBX panel never was.
 *
 * ⛔⛔ THE CHECK THAT LOOKS OBVIOUS DOES NOT WORK, AND THAT IS THE WHOLE POINT.
 * Comparing "mailboxes intended" against "mailboxes Asterisk loaded" read
 * 122 == 122 before the repair — the two casualties matched perfectly BY BEING
 * EXCLUDED FROM BOTH SIDES. A guardrail built that way would have watched this
 * happen for four months and reported OK every time. The signal that actually
 * catches it is a non-allowlisted `enabled='no'`, which is what this sweeps for.
 *
 * Deliberate exclusions go in the allowlist — a reviewed record of "we meant
 * this", never silence. Today that is Gesheft 898 "Order Tracking".
 */

import { db } from "@connect/db";
import { decryptJson } from "@connect/security";
import { createHash } from "node:crypto";

export type Log = { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void };

/** One extension whose voicemail is switched off on the phone system. */
export type DisabledMailbox = { tenant: string; extension: string; extensionName: string };

export const ALARM_KEY = "A customer cannot receive voicemail";
export const DEFAULT_ALLOWLIST = "gesheft:898";
/** Platform tenant the escalation is filed under (same as the email guardrails). */
const ADMIN_ALERT_TENANT_ID = "connect-admin-tenant-v1";

export function parseAllowlist(raw: string | null | undefined): Set<string> {
  return new Set(
    String(raw ?? DEFAULT_ALLOWLIST)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function keyOf(row: DisabledMailbox): string {
  return String(row.tenant).trim().toLowerCase() + ":" + String(row.extension).trim();
}

export type MailboxVerdict = {
  shouldAlert: boolean;
  offenders: DisabledMailbox[];
  allowlisted: DisabledMailbox[];
  summary: string;
  sms: string;
  report: string;
};

/**
 * Pure decision. `disabled` is every extension with voicemail switched off;
 * anything not on the allowlist is a customer who cannot receive a voicemail.
 */
export function decideVoicemailMailboxAlert(input: {
  disabled: DisabledMailbox[];
  allowlist: Set<string>;
}): MailboxVerdict {
  const allowlisted: DisabledMailbox[] = [];
  const offenders: DisabledMailbox[] = [];
  for (const row of input.disabled) {
    (input.allowlist.has(keyOf(row)) ? allowlisted : offenders).push(row);
  }
  offenders.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

  const plural = offenders.length === 1 ? "" : "s";
  const names = offenders.map((o) => o.tenant + " ext " + o.extension).join(", ");
  const summary = offenders.length
    ? ALARM_KEY + " — " + offenders.length + " extension" + plural + ": " + names
    : ALARM_KEY + " — none";
  const sms = offenders.length
    ? "Voicemail is switched off for " +
      offenders.length +
      " extension" +
      plural +
      ": " +
      names +
      ". Callers cannot leave a message."
    : "";
  const report = offenders.length
    ? [
        "ISSUE",
        "Voicemail is switched off on " +
          offenders.length +
          " extension" +
          plural +
          ", so callers cannot leave a message there.",
        "",
        "AFFECTED",
        ...offenders.map((o) => "- " + o.tenant + ", extension " + o.extension + " (" + o.extensionName + ")"),
        "",
        "FINDINGS",
        "ombu_extensions_vm.enabled is 'no' for these. That column defaults to 'no',",
        "so an extension created without explicitly switching voicemail on gets none —",
        "no mailbox in Asterisk, no spool directory, and nothing logged anywhere.",
        "Extensions created by the sign-up wizard are unaffected; this is the",
        "hand-created-in-the-panel path.",
        "",
        "PROPOSED FIX",
        "Either switch voicemail on for each extension, or, if it is deliberate,",
        "add it to VOICEMAIL_MAILBOX_ALLOWLIST as tenant:extension so this stops",
        "alerting and the decision is on the record.",
      ].join("\n")
    : "";

  return { shouldAlert: offenders.length > 0, offenders, allowlisted, summary, sms, report };
}

/** Read every extension whose voicemail is switched off, from the PBX database. */
export async function fetchDisabledMailboxes(database: any = db): Promise<DisabledMailbox[] | null> {
  const inst: any = await database.pbxInstance.findFirst({ where: { isEnabled: true } });
  if (!inst?.ombuMysqlUrlEncrypted) return null;
  const parsed: any = decryptJson(String(inst.ombuMysqlUrlEncrypted).trim());
  const url = String(parsed.mysqlUrl || parsed.url || "").trim();
  if (!url) return null;
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection(url);
  try {
    const [rows]: any = await conn.query(
      "SELECT t.name AS tenant, e.extension AS extension, e.name AS extensionName" +
        " FROM ombutel.ombu_extensions_vm v" +
        " JOIN ombutel.ombu_extensions e ON e.extension_id = v.extension_id" +
        " JOIN ombutel.ombu_tenants  t ON t.tenant_id     = e.tenant_id" +
        " WHERE v.enabled = 'no'" +
        " ORDER BY t.name, e.extension",
    );
    return (rows || []).map((r: any) => ({
      tenant: String(r.tenant ?? ""),
      extension: String(r.extension ?? ""),
      extensionName: String(r.extensionName ?? ""),
    }));
  } finally {
    await conn.end().catch(() => {});
  }
}

/**
 * Raise the alarm, de-duped over a WINDOW rather than for ever.
 *
 * ⛔ Deliberately NOT the shared raiseGuardrailEscalation: that de-dupes on any
 * open escalation with no time bound, and AgentEscalationStatus has no RESOLVED
 * value, so each alarm key can fire exactly ONCE, ever. For "a customer cannot
 * receive voicemail" that is the wrong trade — it must keep nagging while the
 * problem stands, and must be able to fire again if it recurs.
 */
export async function raiseMailboxEscalation(
  verdict: MailboxVerdict,
  opts: { windowMs: number; log?: Log; database?: any },
): Promise<boolean> {
  const database = opts.database ?? db;
  const since = new Date(Date.now() - opts.windowMs);
  const recent = await database.agentEscalation.findFirst({
    where: { requestSummary: { startsWith: ALARM_KEY }, createdAt: { gte: since } },
    select: { id: true },
  });
  if (recent) {
    opts.log?.info?.({ existing: recent.id }, "voicemail-mailbox: already alerted inside the window");
    return false;
  }
  await database.agentEscalation.create({
    data: {
      tenantId: ADMIN_ALERT_TENANT_ID,
      tenantName: "Loopcom platform",
      clientUserId: null,
      userName: "voicemail mailbox guardrail",
      userEmail: null,
      requestSummary: verdict.summary,
      smsBody: verdict.sms,
      report: verdict.report,
      // ⛔ `proposedFix` is a REQUIRED column. `null` here was a
      // PrismaClientValidationError the caller's catch swallowed — the alarm
      // could never fire, silently (found 2026-09-01).
      proposedFix: "",
      researchDegraded: false,
      status: "QUEUED",
    },
  });
  opts.log?.warn?.({ offenders: verdict.offenders.length }, "voicemail-mailbox: escalation raised");
  return true;
}

/**
 * One pass. Writes an audit row EVERY run, including clean ones.
 *
 * ⛔ The row is the point: a boot line saying "armed" proves nothing — a monitor
 * whose state write silently fails looks identical to a healthy one. Query
 * AgentAuditLog event='voicemail_mailbox.sweep' to prove this really ran.
 * ⛔ AgentAuditLog requires `actor` AND `hash`; omitting either makes Prisma
 * reject every write, which is exactly how a previous monitor went blind.
 */
export async function runVoicemailMailboxSweep(opts?: {
  log?: Log;
  database?: any;
  allowlistRaw?: string | null;
  windowMs?: number;
  fetch?: () => Promise<DisabledMailbox[] | null>;
}): Promise<{ ran: boolean; offenders: number; alerted: boolean }> {
  const log = opts?.log;
  const database = opts?.database ?? db;
  const windowMs =
    opts?.windowMs ?? Number(process.env.VOICEMAIL_MAILBOX_ALERT_WINDOW_MS || 24 * 60 * 60 * 1000);
  try {
    const disabled = await (opts?.fetch ? opts.fetch() : fetchDisabledMailboxes(database));
    if (disabled == null) {
      log?.warn?.({}, "voicemail-mailbox: no reachable PBX database — cannot check");
      return { ran: false, offenders: 0, alerted: false };
    }
    const verdict = decideVoicemailMailboxAlert({
      disabled,
      allowlist: parseAllowlist(opts?.allowlistRaw ?? process.env.VOICEMAIL_MAILBOX_ALLOWLIST),
    });
    let alerted = false;
    if (verdict.shouldAlert) {
      alerted = await raiseMailboxEscalation(verdict, { windowMs, log, database });
    }
    const payload = {
      offenders: verdict.offenders.map(keyOf),
      allowlisted: verdict.allowlisted.map(keyOf),
      alerted,
    };
    await database.agentAuditLog.create({
      data: {
        event: "voicemail_mailbox.sweep",
        actor: "voicemail-mailbox-guardrail",
        hash: createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32),
        payload,
      },
    });
    log?.info?.(payload, "voicemail-mailbox: sweep complete");
    return { ran: true, offenders: verdict.offenders.length, alerted };
  } catch (err) {
    // Loud, never swallowed — a guardrail that fails quietly is not a guardrail.
    log?.warn?.({ err: (err as Error)?.message }, "voicemail-mailbox: sweep FAILED");
    return { ran: false, offenders: 0, alerted: false };
  }
}

/** Arm the hourly sweep, with a boot kick so a restart never leaves a blind gap. */
export function startVoicemailMailboxSweep(log?: Log): void {
  if (String(process.env.VOICEMAIL_MAILBOX_SWEEP_DISABLED || "") === "1") {
    log?.info?.({}, "VOICEMAIL_MAILBOX_SWEEP_DISABLED=1 — not arming");
    return;
  }
  const intervalMs = Number(process.env.VOICEMAIL_MAILBOX_SWEEP_INTERVAL_MS || 60 * 60 * 1000);
  const bootDelayMs = Number(process.env.VOICEMAIL_MAILBOX_SWEEP_BOOT_DELAY_MS || 4 * 60 * 1000);
  setTimeout(() => {
    void runVoicemailMailboxSweep({ log });
  }, bootDelayMs);
  setInterval(() => {
    void runVoicemailMailboxSweep({ log });
  }, intervalMs);
  log?.info?.({ intervalMs, bootDelayMs }, "VOICEMAIL_MAILBOX_SWEEP_ARMED");
}
