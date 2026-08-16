/**
 * Standing knowledge loader — the system document plus THIS company's document,
 * read before every answer.
 *
 * Why two documents and not one corpus: the assistant serves ~30 companies and
 * will serve hundreds. Loading everything would make every conversation pay for
 * every customer's details, and would put other companies' facts one prompt
 * injection away from the wrong reader. Splitting per tenant means a
 * conversation reads exactly two documents, whatever the customer base does.
 *
 * ⛔ The rows come from `docs/agent-knowledge/*.md`, published by the API at
 * boot (`apps/api/src/agentKnowledgeSync.ts`). This service only READS them —
 * so knowledge can change without rebuilding this container, which is the whole
 * reason the publishing lives on the other side.
 *
 * ⛔ Everything here is failure-safe. A database hiccup, a missing table, an
 * empty corpus: the loader returns null and the conversation proceeds exactly
 * as it did before this feature existed. Knowledge makes answers better; its
 * absence must never make the assistant silent.
 */
import { renderKnowledgeBlock, DEFAULT_KNOWLEDGE_CHARS_PER_DOC, type KnowledgeAudience } from "@connect/shared";

export interface KnowledgeDocRow {
  title: string;
  body: string;
  internalBody: string | null;
  updatedAt: Date;
}

interface CacheEntry {
  at: number;
  row: KnowledgeDocRow | null;
}

/**
 * Documents change when someone deploys the api, not per message — but a stale
 * answer after an edit is confusing, so the cache is short. Module scope on
 * purpose: it must survive across conversations, and the agent process is
 * long-lived.
 */
const TTL_MS = Number(process.env.AGENT_KNOWLEDGE_CACHE_MS || 60_000);
const cache = new Map<string, CacheEntry>();

export function clearKnowledgeCache(): void {
  cache.clear();
}

function maxChars(): number {
  const v = Number(process.env.AGENT_KNOWLEDGE_MAX_CHARS || 0);
  return v > 0 ? v : DEFAULT_KNOWLEDGE_CHARS_PER_DOC;
}

async function load(prisma: any, key: string, where: any): Promise<KnowledgeDocRow | null> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return hit.row;
  let row: KnowledgeDocRow | null = null;
  try {
    row = await prisma.agentKnowledgeDoc.findFirst({
      where,
      select: { title: true, body: true, internalBody: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
  } catch {
    // Table missing (pre-migration) or database blip. Cache the miss briefly so
    // a broken database does not add a query to every single message.
    row = null;
  }
  cache.set(key, { at: now, row });
  return row;
}

export interface StandingKnowledgeInput {
  prisma: any;
  tenantId: string | null | undefined;
  tenantName?: string | null;
  audience: KnowledgeAudience;
}

/**
 * The system-prompt block for this conversation, or null when there is nothing
 * to say. ⛔ The tenant document is fetched BY tenantId — the server-verified
 * one from the session, never anything the chat text claims.
 */
export async function loadStandingKnowledgeBlock(input: StandingKnowledgeInput): Promise<string | null> {
  if (!input.prisma) return null;
  const system = await load(input.prisma, "system", { scope: "system" });
  const tenant = input.tenantId
    ? await load(input.prisma, `tenant:${input.tenantId}`, { scope: "tenant", tenantId: input.tenantId })
    : null;
  if (!system && !tenant) return null;
  return renderKnowledgeBlock({
    system,
    tenant,
    audience: input.audience,
    maxCharsPerDoc: maxChars(),
    tenantName: input.tenantName ?? null,
  });
}
