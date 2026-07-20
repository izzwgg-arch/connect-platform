/**
 * Scheduled jobs (PLAN.md §11, §13). DB-backed, restart-safe.
 *  - dailyDigest: 7am summary email — actions, tickets, security, health.
 *  - weeklySelfReview: proposes KB drafts from the week's resolved/escalated
 *    conversations; emails Izzy the proposals (team approves before the agent
 *    cites them). This is the engineered "learning loop".
 */
import type { AuditLog } from "../audit/audit";
import type { Notifier } from "../notify/notifier";

export class DigestJobs {
  constructor(
    private prisma: any,
    private audit: AuditLog,
    private notifier: Notifier,
  ) {}

  async dailyDigest(now = new Date()): Promise<{ sent: boolean }> {
    const since = new Date(now.getTime() - 24 * 3600 * 1000);
    const [convos, executed, escalated, incidents, diags] = await Promise.all([
      this.count("agentConversation", { startedAt: { gte: since } }),
      this.count("agentAction", { status: "EXECUTED", updatedAt: { gte: since } }),
      this.count("agentAuditLog", { event: "diag.completed", ts: { gte: since } }),
      this.prisma.agentIncident?.findMany?.({ where: { createdAt: { gte: since } }, orderBy: { severity: "desc" }, take: 20 }).catch(() => []) ?? [],
      this.count("agentDiagReport", { createdAt: { gte: since } }),
    ]);
    const crit = (incidents ?? []).filter((i: any) => i.severity === "critical");
    const text =
      `Connect Agent — daily digest (${now.toISOString().slice(0, 10)})\n\n` +
      `Conversations: ${convos}\n` +
      `Actions executed: ${executed}\n` +
      `Diagnoses run: ${diags}\n` +
      `Security/health signals: ${(incidents ?? []).length}${crit.length ? ` (⚠ ${crit.length} critical)` : ""}\n\n` +
      ((incidents ?? []).length ? "Signals:\n" + (incidents ?? []).map((i: any) => `  [${i.severity}] ${i.type}`).join("\n") : "No security or health signals.") +
      `\n\n(Detection + alert only — no automated remediation.)`;
    await this.audit.record({ actor: "system", event: "digest.daily", payload: { convos, executed, incidents: (incidents ?? []).length } });
    const r = await this.notifier.send({ kind: "daily_digest", to: this.notifier.ownerRecipients(), subject: `[Connect Agent] Daily digest — ${now.toISOString().slice(0, 10)}`, text });
    return { sent: r.sent };
  }

  async weeklySelfReview(now = new Date()): Promise<{ proposals: number }> {
    const since = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    // Escalations + diagnoses are the raw material for KB proposals.
    let diags: any[] = [];
    try {
      diags = await this.prisma.agentDiagReport.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 50 });
    } catch {
      diags = [];
    }
    // Group by top hypothesis cause → candidate KB article.
    const byCause = new Map<string, number>();
    for (const d of diags) {
      const cause = Array.isArray(d.hypotheses) && d.hypotheses[0]?.cause ? String(d.hypotheses[0].cause) : "unclassified";
      byCause.set(cause, (byCause.get(cause) ?? 0) + 1);
    }
    const proposals = [...byCause.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    const text =
      `Connect Agent — weekly self-review (${now.toISOString().slice(0, 10)})\n\n` +
      `Diagnoses reviewed: ${diags.length}\n` +
      `Recurring patterns worth a KB article:\n` +
      (proposals.length ? proposals.map(([c, n]) => `  • ${c} — seen ${n}×`).join("\n") : "  (none recurring enough yet)") +
      `\n\nReply to approve any as a knowledge-base article the agent can cite.`;
    await this.audit.record({ actor: "agent", event: "self_review.weekly", payload: { diags: diags.length, proposals: proposals.length } });
    await this.notifier.send({ kind: "daily_digest", to: this.notifier.ownerRecipients(), subject: `[Connect Agent] Weekly self-review — ${proposals.length} KB proposal(s)`, text });
    return { proposals: proposals.length };
  }

  private async count(model: string, where: any): Promise<number> {
    try {
      return await (this.prisma as any)[model].count({ where });
    } catch {
      return 0;
    }
  }
}
