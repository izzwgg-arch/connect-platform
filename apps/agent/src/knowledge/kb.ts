/**
 * Knowledge Base + learning loop (PLAN.md §11). The agent's growing intelligence
 * is engineered memory, not magic: every resolved ticket auto-drafts a KB
 * article (team-approved before the agent cites it), and diagnosis retrieves
 * relevant approved articles first. Weekly self-review proposes new entries.
 *
 * Retrieval v1 is keyword/overlap scoring (no embeddings dependency); a pgvector
 * upgrade is a drop-in later. Only APPROVED articles are ever surfaced to
 * customers — drafts stay internal until the team signs off.
 */
import type { AuditLog } from "../audit/audit";

export interface KbArticle {
  id: string;
  tenantId: string | null;
  title: string;
  problem: string;
  cause: string;
  fix: string;
  approved: boolean;
  sourceConversationId?: string | null;
}

const STOP = new Set(["the", "a", "an", "is", "to", "my", "on", "of", "and", "in", "it", "for", "with", "was", "are", "not", "no", "i", "we", "you"]);

export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}

export function scoreOverlap(query: string, article: KbArticle): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const doc = new Set(tokenize(`${article.title} ${article.problem} ${article.cause}`));
  let hits = 0;
  for (const w of q) if (doc.has(w)) hits++;
  return hits / q.size;
}

export class KnowledgeBase {
  constructor(
    private prisma: any,
    private audit: AuditLog,
  ) {}

  /** Draft an article from a resolved ticket (unapproved until team review). */
  async draftFromResolution(input: { tenantId: string | null; problem: string; cause: string; fix: string; sourceConversationId?: string; title?: string }): Promise<KbArticle> {
    const row = await this.prisma.agentKbArticle.create({
      data: {
        tenantId: input.tenantId,
        title: input.title ?? input.problem.slice(0, 80),
        problem: input.problem,
        cause: input.cause,
        fix: input.fix,
        approved: false,
        sourceConversationId: input.sourceConversationId ?? null,
      },
    });
    await this.audit.record({ actor: "agent", event: "kb.drafted", tenantId: input.tenantId ?? undefined, payload: { id: row.id, title: row.title } });
    return row;
  }

  /** Retrieve approved articles matching a query (own tenant + global), ranked. */
  async retrieve(query: string, tenantId: string | null, limit = 3): Promise<Array<KbArticle & { score: number }>> {
    let candidates: KbArticle[] = [];
    try {
      candidates = await this.prisma.agentKbArticle.findMany({
        where: { approved: true, OR: [{ tenantId }, { tenantId: null }] },
        take: 200,
      });
    } catch {
      return [];
    }
    return candidates
      .map((a) => ({ ...a, score: scoreOverlap(query, a) }))
      .filter((a) => a.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async approve(id: string, approvedBy: string): Promise<void> {
    await this.prisma.agentKbArticle.update({ where: { id }, data: { approved: true } });
    await this.audit.record({ actor: "owner", event: "kb.approved", payload: { id, approvedBy } });
  }
}
