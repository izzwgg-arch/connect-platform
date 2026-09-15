/**
 * The support agent tells the owner what it is doing — and he can stop it.
 *
 *   POST /admin/support/escalations/:reference/owner-notice   { scope, summary }
 *   GET  /admin/support/escalations/:reference/owner-notices
 *
 * Izzy, 2026-09-14: a change that only affects the ticket's company → text him
 * what is being done and keep going; he interferes if he wants to. A change
 * that affects the whole system → text him and wait for his go-ahead.
 *
 * ⛔⛔ ENFORCED, NOT REQUESTED. `checkOwnerNoticeGate` is called by the
 * act-as-filer route before EVERY write: no write goes through without a notice
 * whose text actually reached his phone, and once he has replied STOP on a
 * ticket, every further write on that ticket is refused and no new notice can
 * be posted to get around it.
 *
 * ⛔ The reply half rides the ONE existing reader — `sweepFixRepliesBatch` in
 * agentFixByText.ts — with the same allow-list (his numbers only), hashed
 * single-use codes and atomic claims. There is no second inbox reader.
 * ⛔ The code is never returned to the caller: the agent must not be holding
 * the thing that approves its own request.
 */
import { createHash, randomInt } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  NOTICE_CODE_LENGTH,
  renderNoticeOutcomeSms,
  renderOwnerNoticeSms,
  supportReportReference,
  type NoticeOutcomeKind,
  type NoticeReplyKind,
  type NoticeScope,
} from "@connect/shared";
import { resolvePlatformSmsSender, normalizeUsPhone } from "../billing/billingSmsSender";
import { resolveEscalationId } from "./customerUpdateRoutes";

/** A notice covers the agent's work on a ticket for a day; a GO request waits a day. */
export const NOTICE_TTL_MS = 24 * 60 * 60 * 1000;
/** Owner updates (ship results) per ticket per UTC day. */
export const OWNER_UPDATES_PER_TICKET_PER_DAY = 12;

export function hashNoticeCode(code: string): string {
  return createHash("sha256").update(`support-notice:${code}`).digest("hex");
}

export function generateNoticeCode(): string {
  let out = "";
  for (let i = 0; i < NOTICE_CODE_LENGTH; i++) out += String(randomInt(0, 10));
  return out;
}

export type OwnerSmsSender = (input: { tenantId: string; body: string }) => Promise<{ delivered: number; error?: string }>;

/** Texts every owner number from the escalation number — the same sender the escalation dispatcher uses. */
export async function sendOwnerSmsViaPlatform(input: { tenantId: string; body: string; to: string[] }): Promise<{ delivered: number; error?: string }> {
  const from = normalizeUsPhone(process.env.AGENT_ESCALATION_SMS_FROM) || "+18455577768";
  const sender = await resolvePlatformSmsSender(from);
  if (!sender.ok) return { delivered: 0, error: `sms_unavailable: ${String((sender as any).error ?? "unknown")}` };
  let delivered = 0;
  const errors: string[] = [];
  for (const to of input.to) {
    try {
      await sender.send({ tenantId: input.tenantId, to, body: input.body });
      delivered++;
    } catch (err: any) {
      errors.push(`${to}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
  return { delivered, error: errors.length ? errors.join(" | ") : undefined };
}

export type GateResult = { ok: true } | { ok: false; error: string; message: string };

/** May the agent change something on this ticket right now? */
export async function checkOwnerNoticeGate(db: any, escalationId: string, now: number = Date.now()): Promise<GateResult> {
  const rows = await db.supportAgentNotice.findMany({
    where: { escalationId },
    select: { scope: true, status: true, smsSentAt: true, expiresAt: true },
  });
  if (rows.some((r: any) => r.status === "stopped")) {
    return { ok: false, error: "stopped_by_owner", message: "The owner replied STOP on this ticket. No more changes may be made." };
  }
  const live = rows.some(
    (r: any) =>
      r.smsSentAt &&
      new Date(r.expiresAt).getTime() > now &&
      ((r.scope === "tenant" && r.status === "proceeding") || (r.scope === "system" && r.status === "approved")),
  );
  if (!live) {
    return {
      ok: false,
      error: "owner_not_notified",
      message: "Post an owner notice for this ticket first (owner-notice); no change is made before the owner has been texted what is happening.",
    };
  }
  return { ok: true };
}

export async function createOwnerNotice(
  db: any,
  sendOwnerSms: OwnerSmsSender,
  input: { escalationId: string; tenantId: string; reference: string; tenantName: string; userName: string; scope: NoticeScope; summary: string },
  now: number = Date.now(),
): Promise<{ id: string; status: string; smsDelivered: number; error?: string }> {
  const code = generateNoticeCode();
  const status = input.scope === "tenant" ? "proceeding" : "awaiting_go";
  const row = await db.supportAgentNotice.create({
    data: {
      escalationId: input.escalationId,
      tenantId: input.tenantId,
      scope: input.scope,
      summary: input.summary,
      codeHash: hashNoticeCode(code),
      status,
      expiresAt: new Date(now + NOTICE_TTL_MS),
    },
    select: { id: true },
  });
  const body = renderOwnerNoticeSms({ ...input, code });
  const sent = await sendOwnerSms({ tenantId: input.tenantId, body });
  await db.supportAgentNotice.update({
    where: { id: row.id },
    data: { smsSentAt: sent.delivered > 0 ? new Date(now) : null, lastError: sent.error ?? null },
  });
  return { id: row.id, status, smsDelivered: sent.delivered, error: sent.error };
}

export type NoticeReplyOutcome = {
  /** False when the sender is not an owner number — say nothing, change nothing. */
  handled: boolean;
  /** True only the one time a reply actually changed a notice. */
  changed: boolean;
  kind: NoticeOutcomeKind | null;
  message: string | null;
  replyTo: string | null;
  tenantId: string | null;
};

export async function applyNoticeReply(
  db: any,
  input: { kind: NoticeReplyKind; code: string; from: string; approvers: string[] },
  now: number = Date.now(),
): Promise<NoticeReplyOutcome> {
  const from = normalizeUsPhone(input.from) || input.from;
  if (!input.approvers.includes(from)) {
    return { handled: false, changed: false, kind: null, message: null, replyTo: null, tenantId: null };
  }
  const row = await db.supportAgentNotice.findUnique({
    where: { codeHash: hashNoticeCode(input.code) },
    select: { id: true, escalationId: true, tenantId: true, scope: true, status: true, expiresAt: true },
  });
  const answer = (kind: NoticeOutcomeKind, changed = false): NoticeReplyOutcome => ({
    handled: true,
    changed,
    kind,
    message: renderNoticeOutcomeSms(kind, row ? supportReportReference(row.escalationId) : null),
    replyTo: from,
    tenantId: row?.tenantId ?? null,
  });
  if (!row) return answer("unknown_code");

  if (input.kind === "stop") {
    // ⛔ STOP always works, expired or not — stopping is the safe direction.
    const claimed = await db.supportAgentNotice.updateMany({
      where: { id: row.id, status: { not: "stopped" } },
      data: { status: "stopped", decidedAt: new Date(now), decidedFrom: from },
    });
    return claimed.count === 1 ? answer("stopped", true) : answer("already_stopped");
  }

  if (row.scope !== "system") return answer("not_needed");
  if (row.status !== "awaiting_go") return answer("already_decided");
  if (new Date(row.expiresAt).getTime() <= now) return answer("expired");
  const claimed = await db.supportAgentNotice.updateMany({
    where: { id: row.id, status: "awaiting_go" },
    data: { status: "approved", decidedAt: new Date(now), decidedFrom: from },
  });
  return claimed.count === 1 ? answer("approved", true) : answer("already_decided");
}

export type SupportAgentNoticeDeps = {
  db: any;
  requireSuper: (req: any, reply: any) => Promise<any> | any;
  sendOwnerSms: OwnerSmsSender;
  now?: () => number;
  log?: { info?: (o: any, m?: string) => void; warn?: (o: any, m?: string) => void };
};

const noticeSchema = z.object({
  scope: z.enum(["tenant", "system"]),
  summary: z.string().trim().min(10).max(400),
});

export function registerSupportAgentNoticeRoutes(app: FastifyInstance, deps: SupportAgentNoticeDeps): void {
  const { db } = deps;
  const now = deps.now ?? (() => Date.now());

  app.post("/admin/support/escalations/:reference/owner-notice", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;

    const reference = String((req.params as any)?.reference ?? "").trim();
    const parsed = noticeSchema.safeParse(req.body || {});
    if (!reference || !parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Send { scope: 'tenant' | 'system', summary } — a plain sentence saying what will change." });
    }
    const escalationId = await resolveEscalationId(db, reference);
    const esc = escalationId
      ? await db.agentEscalation.findUnique({
          where: { id: escalationId },
          select: { id: true, tenantId: true, tenantName: true, userName: true, clientUserId: true },
        })
      : null;
    if (!esc) return reply.status(404).send({ error: "not_found", message: `No recent ticket with reference ${reference}.` });
    if (parsed.data.scope === "tenant" && !esc.clientUserId) {
      return reply.status(409).send({ error: "not_applicable", message: "A platform alarm has no customer to act for; use scope 'system'." });
    }
    const gate = await checkOwnerNoticeGate(db, esc.id, now());
    if (!gate.ok && gate.error === "stopped_by_owner") {
      return reply.status(409).send({ error: gate.error, message: gate.message });
    }

    const result = await createOwnerNotice(
      db,
      deps.sendOwnerSms,
      {
        escalationId: esc.id,
        tenantId: esc.tenantId,
        reference: supportReportReference(esc.id),
        tenantName: esc.tenantName,
        userName: esc.userName,
        scope: parsed.data.scope,
        summary: parsed.data.summary,
      },
      now(),
    );
    deps.log?.info?.({ reference, scope: parsed.data.scope, smsDelivered: result.smsDelivered }, "support-notice: owner texted");
    if (result.smsDelivered === 0) {
      return reply.status(502).send({
        error: "owner_not_reached",
        message: "The owner could not be texted, so nothing may change yet.",
        detail: result.error ?? null,
        noticeId: result.id,
      });
    }
    return reply.send({
      ok: true,
      noticeId: result.id,
      status: result.status,
      next: parsed.data.scope === "tenant" ? "You may proceed; check owner-notices before each change for a STOP." : "Wait: nothing may happen until the owner replies GO.",
    });
  });

  /**
   * A plain update to the OWNER about a ticket (the support agent's ship results).
   * ⛔ Owner numbers only — never the customer — and capped per ticket per day so
   * a looping watcher cannot text his phone all night.
   */
  const ownerUpdatesToday = new Map<string, { day: string; count: number }>();
  app.post("/admin/support/escalations/:reference/owner-update", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;
    const reference = String((req.params as any)?.reference ?? "").trim();
    const parsed = z.object({ message: z.string().trim().min(5).max(320) }).safeParse(req.body || {});
    if (!reference || !parsed.success) {
      return reply.status(400).send({ error: "invalid_request", message: "Send { message } — one plain sentence for the owner." });
    }
    const escalationId = await resolveEscalationId(db, reference);
    const esc = escalationId
      ? await db.agentEscalation.findUnique({ where: { id: escalationId }, select: { id: true, tenantId: true, tenantName: true } })
      : null;
    if (!esc) return reply.status(404).send({ error: "not_found", message: `No recent ticket with reference ${reference}.` });
    const day = new Date(now()).toISOString().slice(0, 10);
    const used = ownerUpdatesToday.get(esc.id);
    const count = used && used.day === day ? used.count : 0;
    if (count >= OWNER_UPDATES_PER_TICKET_PER_DAY) {
      return reply.status(429).send({ error: "too_many", message: "That ticket already texted the owner the maximum times today." });
    }
    ownerUpdatesToday.set(esc.id, { day, count: count + 1 });
    const body = `Loopcom agent — ticket ${supportReportReference(esc.id)} (${esc.tenantName}): ${parsed.data.message}`;
    const sent = await deps.sendOwnerSms({ tenantId: esc.tenantId, body });
    deps.log?.info?.({ reference, delivered: sent.delivered }, "support-notice: owner update texted");
    if (sent.delivered === 0) return reply.status(502).send({ error: "owner_not_reached", detail: sent.error ?? null });
    return reply.send({ ok: true, delivered: sent.delivered });
  });

  app.get("/admin/support/escalations/:reference/owner-notices", async (req: any, reply: any) => {
    const actor = await deps.requireSuper(req, reply);
    if (!actor) return reply;
    const reference = String((req.params as any)?.reference ?? "").trim();
    const escalationId = reference ? await resolveEscalationId(db, reference) : null;
    if (!escalationId) return reply.status(404).send({ error: "not_found", message: `No recent ticket with reference ${reference}.` });
    const rows = await db.supportAgentNotice.findMany({
      where: { escalationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, scope: true, summary: true, status: true, smsSentAt: true,
        decidedAt: true, expiresAt: true, createdAt: true, lastError: true,
      },
    });
    const gate = await checkOwnerNoticeGate(db, escalationId, now());
    return reply.send({ notices: rows, mayChange: gate.ok, blockedBecause: gate.ok ? null : gate.error });
  });
}
