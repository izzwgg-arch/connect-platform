/**
 * Escalations that actually go somewhere.
 *
 * For weeks the assistant told customers "I've passed this to the human team"
 * — and that sentence was prompt text with NOTHING behind it. No ticket, no
 * email, no record; 40+ customer requests (2026-07-19 → 08-10) reached nobody.
 *
 * This service is the something. After every conversation turn it looks at the
 * assistant's reply; when the assistant promised to pass a request along (or
 * took a message because it was degraded), it:
 *
 *   1. RESEARCHES the problem with the same tool-calling LLM the chat uses —
 *      tenant-bound, read-only tools — and drafts the exact proposed fix, so
 *      the owner only has to say "okay", per Izzy's directive (2026-08-12).
 *   2. Writes an AgentEscalation row (status QUEUED) carrying the tenant name,
 *      the user's name, a compact SMS body and the full report.
 *
 * The API's dispatcher does the actual sending (SMS from Connect's escalation
 * number to the owner's phones + the email report). Deliberately split: the
 * agent container is a manual rebuild, the api redeploys freely — delivery
 * policy must live where it can be fixed quickly.
 *
 * FAILURE DIRECTION: an escalation must never be lost because research failed.
 * No LLM → the row is still written, flagged researchDegraded, with the raw
 * request as the report.
 */

import type { AuditLog } from "../audit/audit";
import type { ModelRouter, ChatMessage } from "../llm/router";
import type { ToolSpec } from "../tools/toolRegistry";

/**
 * The assistant's escalation phrasings. These are OUR OWN strings — the system
 * prompt instructs the model to say "passed to the human team", and the
 * orchestrator/engine fallbacks use the fixed sentences matched here. Matched
 * against the ENGLISH text (contentEn for bridged Yiddish replies).
 */
const ESCALATION_RE = new RegExp(
  [
    // "pass/passed/sent/forwarded/escalated <up to 60 chars> to our/the [human] [support] team"
    String.raw`\b(?:pass(?:ed|ing)?|sent|forward(?:ed|ing)?|escalat(?:ed|ing)|submitt?(?:ed|ing)?|flagged)\b[^.!?\n]{0,60}?\bto\s+(?:our|the)\s+(?:human\s+)?(?:support\s+)?team\b`,
    String.raw`\brecorded\s+(?:and\s+passed\s+to|for)\s+the\s+team\b`,
    String.raw`\bflagged\s+(?:it|this|that)?\s*for\s+(?:our|the)\s+team\b`,
    // "I've passed along: **…**" — caught LIVE on the first post-deploy test
    // (2026-08-12): the model promised an escalation without naming a team
    // after the verb. The transcript-derived patterns above missed it; the
    // model free-forms, so the idiom itself must match, target or not.
    String.raw`\bpass(?:ed|ing)?\s+(?:\w+\s+){0,2}?along\b`,
    // "passed this to a human" / "escalated to a human"
    String.raw`\b(?:passed|sent|forwarded|escalated)\b[^.!?\n]{0,40}?\bto\s+a\s+human\b`,
    // "our team will follow up / look into / reach out / get back" — a promise
    // that the team now owns it, phrased from the team's side.
    String.raw`\b(?:our|the)\s+(?:human\s+)?(?:support\s+)?team\s+will\s+(?:follow\s+up|look\s+into|reach\s+out|get\s+back|review|handle|take\s+(?:it|this|care))\b`,
  ].join("|"),
  "i",
);

export function isEscalationReply(englishText: string): boolean {
  return ESCALATION_RE.test(String(englishText || ""));
}

/** One escalation per conversation per window — a customer restating the same
 *  problem three ways must not fire three SMS. */
const DEDUPE_WINDOW_MS = 30 * 60 * 1000;

const RESEARCH_SYSTEM_PROMPT = `You are the Connect phone-platform assistant preparing an ESCALATION REPORT for the platform owner (Connect staff, not the customer).
A customer asked for something the chat assistant could not do itself. Your job: research the situation with the read-only tools available, then produce a report so complete that the owner only has to reply "okay" to approve the fix.
Rules:
- Use tools to look up this account's real data (extensions, users, calls, settings) before guessing. Never invent data.
- The PROPOSED FIX must be exact and actionable: name the screen or setting, the extension or user, and the precise change. If the fix needs information you could not obtain, say exactly what is missing and how to get it.
- Plain English. No jargon the owner would have to decode. Short sentences.
Answer in EXACTLY this format (keep the headings):
ISSUE: <one or two sentences — what the customer needs, in their terms>
FINDINGS: <what you looked up and what you found, 2-6 short lines>
PROPOSED FIX: <the exact change to make, step by step>
APPROVAL: <one line — what saying "okay" will authorize>`;

export interface EscalationTurnCtx {
  tenantId: string;
  clientUserId: string | null;
  role: "owner" | "customer";
  conversationId: string;
}

export class EscalationService {
  constructor(
    private prisma: any,
    private llm: ModelRouter | null,
    private tools: ToolSpec[] | null,
    private audit: AuditLog,
  ) {}

  /**
   * Fire-and-forget per conversation turn. Never throws — an escalation
   * pipeline error must not break the customer's chat.
   */
  considerTurn(ctx: EscalationTurnCtx): void {
    void this.considerTurnInner(ctx).catch(async (err) => {
      await this.audit
        .record({ actor: "system", event: "escalation.consider_failed", tenantId: ctx.tenantId, conversationId: ctx.conversationId, payload: { error: String(err) } })
        .catch(() => undefined);
    });
  }

  private async considerTurnInner(ctx: EscalationTurnCtx): Promise<void> {
    // The owner chatting with the assistant escalating to... the owner, is noise.
    if (ctx.role === "owner") return;
    if (!this.prisma) return;

    const messages = await this.prisma.agentMessage.findMany({
      where: { conversationId: ctx.conversationId },
      orderBy: { createdAt: "desc" },
      take: 12,
    });
    if (!messages.length) return;
    const lastAssistant = messages.find((m: any) => m.role === "assistant");
    if (!lastAssistant) return;
    const assistantEn = String(lastAssistant.contentEn ?? lastAssistant.content ?? "");
    if (!isEscalationReply(assistantEn)) return;

    // Dedupe: one escalation per conversation per window.
    const recent = await this.prisma.agentEscalation.findFirst({
      where: { conversationId: ctx.conversationId, createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) } },
      select: { id: true },
    });
    if (recent) return;

    // Who is this? Names ride in the SMS (Izzy's requirement, 2026-08-12).
    const [tenant, user] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: ctx.tenantId }, select: { name: true } }).catch(() => null),
      ctx.clientUserId
        ? this.prisma.user.findUnique({ where: { id: ctx.clientUserId }, select: { firstName: true, lastName: true, email: true } }).catch(() => null)
        : Promise.resolve(null),
    ]);
    const tenantName = String(tenant?.name || ctx.tenantId);
    const userName =
      [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
      String(user?.email || "").split("@")[0] ||
      "Unknown user";
    const userEmail = user?.email ? String(user.email) : null;

    // Chronological transcript (English mirror when bridged) for the researcher.
    const transcript = [...messages]
      .reverse()
      .map((m: any) => `${m.role === "assistant" ? "ASSISTANT" : "CUSTOMER"}: ${String(m.contentEn ?? m.content ?? "").slice(0, 1500)}`)
      .join("\n");
    const lastUser = messages.find((m: any) => m.role === "user");
    const requestSummary = String(lastUser?.contentEn ?? lastUser?.content ?? assistantEn).slice(0, 500);

    const research = await this.research(ctx, tenantName, userName, transcript);

    const smsBody = buildEscalationSms({
      tenantName,
      userName,
      userEmail,
      issue: research.issue,
      proposedFix: research.proposedFix,
      degraded: research.degraded,
    });

    const row = await this.prisma.agentEscalation.create({
      data: {
        conversationId: ctx.conversationId,
        tenantId: ctx.tenantId,
        tenantName,
        clientUserId: ctx.clientUserId,
        userName,
        userEmail,
        requestSummary,
        smsBody,
        report: research.report,
        proposedFix: research.proposedFix,
        researchDegraded: research.degraded,
      },
    });
    await this.audit.record({
      actor: "agent",
      event: "escalation.queued",
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      payload: { escalationId: row.id, tenantName, userName, researchDegraded: research.degraded },
    });
  }

  private async research(
    ctx: EscalationTurnCtx,
    tenantName: string,
    userName: string,
    transcript: string,
  ): Promise<{ issue: string; findings: string; proposedFix: string; report: string; degraded: boolean }> {
    const fallbackIssue = transcript.split("\n").find((l) => l.startsWith("CUSTOMER:"))?.slice(10, 300).trim() || "See transcript.";
    const fallback = {
      issue: fallbackIssue,
      findings: "Research was unavailable — the report below is the raw conversation.",
      proposedFix: "Review the transcript and decide the fix.",
      report: `ISSUE: ${fallbackIssue}\n\nFINDINGS: research unavailable (assistant LLM not reachable).\n\nTRANSCRIPT:\n${transcript}`,
      degraded: true,
    };
    if (!this.llm || this.llm.available().length === 0) return fallback;

    const msgs: ChatMessage[] = [
      { role: "system", content: RESEARCH_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Company (tenant): ${tenantName}\nCustomer: ${userName}\n\nConversation transcript (most recent last):\n${transcript}\n\nPrepare the escalation report.`,
      },
    ];
    try {
      // role "internal": the researcher acts for Connect staff, but the tenant
      // binding still scopes every tool to THIS customer's data only.
      const res = this.tools?.length
        ? await this.llm.completeWithTools("diagnostics", msgs, this.tools, { tenantId: ctx.tenantId, role: "internal", clientUserId: ctx.clientUserId }, { maxTokens: 8000, conversationId: ctx.conversationId })
        : await this.llm.complete("diagnostics", msgs, { maxTokens: 8000, conversationId: ctx.conversationId });
      const text = res.text?.trim();
      if (!text) return fallback;
      const sections = parseReportSections(text);
      return {
        issue: sections.issue || fallbackIssue,
        findings: sections.findings || "",
        proposedFix: sections.proposedFix || "See report.",
        report: text,
        degraded: false,
      };
    } catch (err) {
      await this.audit
        .record({ actor: "system", event: "escalation.research_failed", tenantId: ctx.tenantId, conversationId: ctx.conversationId, payload: { error: String(err) } })
        .catch(() => undefined);
      return fallback;
    }
  }
}

export function parseReportSections(text: string): { issue: string; findings: string; proposedFix: string; approval: string } {
  const grab = (name: string): string => {
    const re = new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=^(?:ISSUE|FINDINGS|PROPOSED FIX|APPROVAL):|\\s*$)`, "im");
    return (re.exec(text)?.[1] || "").trim();
  };
  return { issue: grab("ISSUE"), findings: grab("FINDINGS"), proposedFix: grab("PROPOSED FIX"), approval: grab("APPROVAL") };
}

/**
 * The SMS the owner receives. Requirements (Izzy, 2026-08-12): tenant name and
 * user name attached, a full picture of what's going on, and the fix already
 * worked out — approval is the only thing left. Kept under ~4 SMS segments.
 */
export function buildEscalationSms(input: {
  tenantName: string;
  userName: string;
  userEmail: string | null;
  issue: string;
  proposedFix: string;
  degraded: boolean;
}): string {
  const clamp = (s: string, n: number) => {
    const v = String(s || "").replace(/\s+/g, " ").trim();
    return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  };
  const lines = [
    `Connect Assistant escalation`,
    `Company: ${clamp(input.tenantName, 60)}`,
    `User: ${clamp(input.userName, 40)}${input.userEmail ? ` (${clamp(input.userEmail, 40)})` : ""}`,
    `Issue: ${clamp(input.issue, 220)}`,
    input.degraded
      ? `Fix: research was unavailable — full transcript emailed.`
      : `Fix ready: ${clamp(input.proposedFix, 260)}`,
    `Full report emailed. Reply OK here (or tell the assistant) to approve.`,
  ];
  return lines.join("\n");
}
