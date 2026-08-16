/**
 * "Fix it!" by text — the owner approves a fix by replying to the escalation SMS.
 *
 * The loop: the assistant prepares a DRAFT action during the chat → the
 * escalation SMS carries that fix plus a one-time code → the owner replies
 * `FIX 481203` from his own phone → the fix is carried out once → he gets a
 * text back saying what happened.
 *
 * ⛔ WHAT THIS FILE IS ALLOWED TO DO IS DELIBERATELY NARROW. It never invents
 * an action: it can only spend a DRAFT `AgentAction` that already exists, whose
 * capability is in the registry, whose params were hashed when it was written,
 * and whose capability re-authorises itself at execution time. A text message
 * can therefore only ever say YES to something already written down — it can
 * never describe new work.
 *
 * ⛔ FOUR THINGS MUST ALL HOLD before anything happens, and each one is checked
 * here rather than trusted from the message:
 *   1. the sender is one of the owner's own numbers (`AGENT_ESCALATION_SMS_TO`);
 *   2. the code matches a live offer — hashed lookup, so a stolen database row
 *      is not a working approval;
 *   3. the offer has not expired (24h) and has not been claimed;
 *   4. the claim is atomic, so two texts (or a retried sweep) act once.
 * Only then does `applyConfirmedAction` run, with every one of ITS gates intact.
 */
import { createHash, randomInt } from "node:crypto";
import { db } from "@connect/db";
import {
  parseFixReply,
  renderFixOfferLine,
  renderFixOutcomeSms,
  truncateSms,
  FIX_CODE_LENGTH,
  type FixOutcomeKind,
} from "@connect/shared";
import { resolvePlatformSmsSender, normalizeUsPhone } from "./billing/billingSmsSender";
import { applyAgentFixAction, confirmCapabilityRegistry } from "./agentGrantRoutes";
import { FIX_CODE_TTL_MS } from "./agentFixPolicy";

export { FIX_CODE_TTL_MS };

/** How far back each sweep reads inbound texts. Comfortably over the poll gap. */
const REPLY_LOOKBACK_MS = Number(process.env.AGENT_FIX_REPLY_LOOKBACK_MS || 30 * 60 * 1000);
/** Refused attempts allowed against ONE escalation before it is burned. */
const MAX_FIX_ATTEMPTS = 5;

const ESCALATION_SMS_FROM = () => normalizeUsPhone(process.env.AGENT_ESCALATION_SMS_FROM) || "+18455577768";

/** The phones allowed to approve. Same list the escalation is sent TO. */
export function fixApproverNumbers(): string[] {
  return (process.env.AGENT_ESCALATION_SMS_TO || "+15622096644,+18457231213")
    .split(",")
    .map((v) => normalizeUsPhone(v))
    .filter((v): v is string => !!v);
}

export function hashFixCode(code: string): string {
  return createHash("sha256").update(`agent-fix:${code}`).digest("hex");
}

/** A fresh code. Digits only — it is read off a screen and typed by a human. */
export function generateFixCode(): string {
  let out = "";
  for (let i = 0; i < FIX_CODE_LENGTH; i++) out += String(randomInt(0, 10));
  return out;
}

/**
 * Attach a one-time code to an escalation that has an executable draft.
 * Returns the code IN THE CLEAR — the only time it exists — for the SMS body,
 * or null when this escalation is information only.
 */
export async function offerFixCode(escalation: { id: string; fixActionId: string | null }): Promise<string | null> {
  if (!escalation.fixActionId) return null;
  // The draft must still be a DRAFT and still be a capability we can run.
  const action = await (db as any).agentAction.findUnique({
    where: { id: escalation.fixActionId },
    select: { id: true, status: true, capabilityId: true },
  });
  if (!action || action.status !== "DRAFT" || !confirmCapabilityRegistry.ids().includes(action.capabilityId)) {
    return null;
  }
  const code = generateFixCode();
  await (db as any).agentEscalation.update({
    where: { id: escalation.id },
    data: {
      fixCodeHash: hashFixCode(code),
      fixCodeExpiresAt: new Date(Date.now() + FIX_CODE_TTL_MS),
      fixStatus: "offered",
    },
  });
  return code;
}

export function fixOfferLine(code: string): string {
  return renderFixOfferLine(code);
}

/**
 * Who the approval acts as. ⛔ A text message carries no session, so the actor
 * is resolved from configuration and re-read from the database — never from
 * anything in the message. It must be a live SUPER_ADMIN.
 */
async function resolveApprover(): Promise<{ sub: string; tenantId: string; role: string; email?: string } | null> {
  const configured = String(process.env.AGENT_FIX_APPROVER_EMAIL || "").trim().toLowerCase();
  const where: any = configured
    ? { email: configured, role: "SUPER_ADMIN", status: { not: "DISABLED" } }
    : { role: "SUPER_ADMIN", status: { not: "DISABLED" } };
  const users = await (db as any).user.findMany({
    where,
    select: { id: true, tenantId: true, role: true, email: true },
    orderBy: { createdAt: "asc" },
    take: 2,
  });
  if (users.length === 0) return null;
  // ⛔ With several super-admins and no AGENT_FIX_APPROVER_EMAIL set, refuse
  // rather than pick one: the audit trail would name the wrong person.
  if (users.length > 1 && !configured) return null;
  const u = users[0];
  return { sub: u.id, tenantId: u.tenantId, role: u.role, email: u.email };
}

async function sendOutcomeSms(to: string, tenantId: string, body: string): Promise<void> {
  try {
    const sender = await resolvePlatformSmsSender(ESCALATION_SMS_FROM());
    if (!sender.ok) return;
    await sender.send({ tenantId, to, body: truncateSms(body) });
  } catch {
    // A missing confirmation text must never turn a completed fix into an error.
  }
}

export interface FixSweepSummary {
  read: number;
  approvals: number;
  applied: number;
  refused: number;
  ignored: number;
}

let running = false;

/**
 * One pass over recent inbound texts on the escalation number.
 *
 * ⛔ Reads only the escalation number's threads. The admin inbox carries
 * ordinary customer conversation too, and a `FIX` in one of those must never be
 * an approval — the sender allow-list is what makes that safe, but reading the
 * narrow set first makes it cheap as well.
 */
export async function sweepFixRepliesBatch(log?: {
  info: (o: any, m: string) => void;
  warn: (o: any, m: string) => void;
}): Promise<FixSweepSummary> {
  const summary: FixSweepSummary = { read: 0, approvals: 0, applied: 0, refused: 0, ignored: 0 };
  if (running) return summary;
  running = true;
  try {
    const approvers = fixApproverNumbers();
    if (approvers.length === 0) return summary;

    const since = new Date(Date.now() - REPLY_LOOKBACK_MS);
    const messages = await (db as any).connectChatMessage.findMany({
      where: {
        direction: "INBOUND",
        createdAt: { gte: since },
        thread: {
          tenantSmsE164: ESCALATION_SMS_FROM(),
          externalSmsE164: { in: approvers },
        },
      },
      select: { id: true, body: true, createdAt: true, thread: { select: { externalSmsE164: true } } },
      orderBy: { createdAt: "asc" },
      take: 50,
    });
    summary.read = messages.length;

    for (const msg of messages) {
      const parsed = parseFixReply(msg.body);
      if (!parsed) {
        summary.ignored++;
        continue;
      }
      summary.approvals++;
      const from = msg.thread?.externalSmsE164 ?? "";
      const outcome = await applyFixByCode({ code: parsed.code, from });
      if (outcome.kind === "applied") summary.applied++;
      else summary.refused++;
      if (outcome.replyTo) {
        await sendOutcomeSms(outcome.replyTo, outcome.tenantId ?? "", outcome.message);
      }
    }

    if (summary.approvals > 0) {
      log?.info({ fixSweep: summary }, "agent fix-by-text replies processed");
    }
    return summary;
  } finally {
    running = false;
  }
}

export interface FixApplyOutcome {
  kind: FixOutcomeKind;
  message: string;
  replyTo: string | null;
  tenantId: string | null;
}

/**
 * Spend one code. Exported so the whole gate order can be driven directly in
 * tests — a route-level test cannot see the claim's atomicity.
 */
export async function applyFixByCode(input: { code: string; from: string }): Promise<FixApplyOutcome> {
  const from = normalizeUsPhone(input.from) || input.from;
  const reply = (kind: FixOutcomeKind, extra?: { tenantName?: string | null; summary?: string | null; detail?: string | null; tenantId?: string | null }): FixApplyOutcome => ({
    kind,
    message: renderFixOutcomeSms({ kind, ...extra }),
    replyTo: from || null,
    tenantId: extra?.tenantId ?? null,
  });

  // 1 ─ Sender. Checked before the code is even looked up, so an unknown number
  // learns nothing about which codes exist.
  if (!fixApproverNumbers().includes(from)) {
    return { kind: "unknown_code", message: "", replyTo: null, tenantId: null };
  }

  const escalation = await (db as any).agentEscalation.findUnique({
    where: { fixCodeHash: hashFixCode(input.code) },
    select: {
      id: true, tenantId: true, tenantName: true, fixActionId: true,
      fixCodeExpiresAt: true, fixCodeUsedAt: true, fixAttempts: true, fixStatus: true,
    },
  });
  if (!escalation || !escalation.fixActionId) return reply("unknown_code");
  if (escalation.fixCodeUsedAt) return reply("already_used", { tenantId: escalation.tenantId });
  if (escalation.fixCodeExpiresAt && escalation.fixCodeExpiresAt.getTime() < Date.now()) {
    return reply("expired", { tenantId: escalation.tenantId });
  }
  if ((escalation.fixAttempts ?? 0) >= MAX_FIX_ATTEMPTS) {
    return reply("refused", { tenantId: escalation.tenantId, detail: "too many attempts on this request." });
  }

  const approver = await resolveApprover();
  if (!approver) {
    return reply("refused", {
      tenantId: escalation.tenantId,
      detail: "no approving account is configured (set AGENT_FIX_APPROVER_EMAIL).",
    });
  }

  // 2 ─ Claim the code BEFORE doing the work. The unique hash plus the
  // "still null" condition makes this atomic: a second text updates 0 rows.
  const claimed = await (db as any).agentEscalation.updateMany({
    where: { id: escalation.id, fixCodeUsedAt: null },
    data: { fixCodeUsedAt: new Date(), fixApprovedFrom: from },
  });
  if (claimed.count !== 1) return reply("already_used", { tenantId: escalation.tenantId });

  // 3 ─ Every remaining gate belongs to the confirmation machinery: role,
  // tenant scope, params hash, the capability's own authorisation, the atomic
  // action claim, the audit. Nothing is restated here.
  const action = await (db as any).agentAction.findUnique({
    where: { id: escalation.fixActionId },
    select: { summary: true },
  });
  let result: any;
  try {
    result = await applyAgentFixAction({
      actor: approver,
      actionId: escalation.fixActionId,
      verifiedFrom: from,
    });
  } catch (err: any) {
    const detail = String(err?.message || err).slice(0, 160);
    await (db as any).agentEscalation.update({
      where: { id: escalation.id },
      data: { fixStatus: "failed", fixResult: detail, fixAttempts: { increment: 1 } },
    });
    return reply("failed", { tenantId: escalation.tenantId, tenantName: escalation.tenantName, detail });
  }

  if (result?.ok) {
    await (db as any).agentEscalation.update({
      where: { id: escalation.id },
      data: { fixStatus: "applied", fixResult: action?.summary ?? "Applied." },
    });
    return reply("applied", {
      tenantId: escalation.tenantId,
      tenantName: escalation.tenantName,
      summary: action?.summary ?? null,
    });
  }

  // Refused by a gate. ⛔ The code stays spent: a refusal is an answer, and a
  // re-usable code would turn a rate limit into a retry loop over SMS.
  const detail = String(result?.message || result?.error || "the change was refused.").slice(0, 160);
  await (db as any).agentEscalation.update({
    where: { id: escalation.id },
    data: { fixStatus: "refused", fixResult: detail, fixAttempts: { increment: 1 } },
  });
  return reply("refused", { tenantId: escalation.tenantId, tenantName: escalation.tenantName, detail });
}
