/**
 * TranslationCache — makes the Yiddish Labs bridge feel instant.
 *
 * Yiddish Labs' English→Yiddish leg has a fixed ~7–10s cost regardless of
 * length (confirmed empirically; `rapid`/`fast` flags have no effect). The only
 * way to beat that floor is to not call YL when we already know the answer:
 *   - Fixed templates (canned/triage/fallback replies, greetings) are
 *     pre-warmed once → served instantly forever.
 *   - Any repeated phrase is cached on first sight → instant next time.
 *
 * Two tiers: an in-process LRU (0ms) backed by a persistent DB table (survives
 * restarts). A miss falls through to the live YL call, whose result is stored.
 */
import { createHash } from "node:crypto";

export type TranslateAction =
  | "translate-yiddish"
  | "translate-english"
  | "translate-hebrew"
  | "translate-lk";

export interface TranslationCacheStats {
  memEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
}

export class TranslationCache {
  private mem = new Map<string, string>();
  private hits = 0;
  private misses = 0;

  constructor(private prisma: any, private maxMem = 5000) {}

  /** Normalize so trivial whitespace/case differences share a cache slot. */
  private norm(text: string): string {
    return (text ?? "").trim().replace(/\s+/g, " ");
  }
  private hash(text: string): string {
    return createHash("sha256").update(this.norm(text)).digest("hex").slice(0, 40);
  }
  private key(action: string, hash: string): string {
    return `${action}|${hash}`;
  }

  /** Return the cached translation, or null on miss. Never throws. */
  async get(action: TranslateAction, text: string): Promise<string | null> {
    const norm = this.norm(text);
    if (!norm) return "";
    const hash = this.hash(norm);
    const k = this.key(action, hash);
    const memHit = this.mem.get(k);
    if (memHit !== undefined) {
      this.hits++;
      return memHit;
    }
    try {
      const row = await this.prisma.agentTranslation.findUnique({ where: { action_srcHash: { action, srcHash: hash } } });
      if (row?.outText != null) {
        this.memSet(k, row.outText);
        this.hits++;
        // fire-and-forget hit counter
        this.prisma.agentTranslation.update({ where: { id: row.id }, data: { hits: { increment: 1 } } }).catch(() => {});
        return row.outText;
      }
    } catch {
      /* DB unavailable → treat as miss */
    }
    this.misses++;
    return null;
  }

  /** Store a translation (both tiers). `pinned` templates are never evicted. */
  async set(action: TranslateAction, text: string, out: string, pinned = false): Promise<void> {
    const norm = this.norm(text);
    if (!norm) return;
    const hash = this.hash(norm);
    this.memSet(this.key(action, hash), out);
    try {
      await this.prisma.agentTranslation.upsert({
        where: { action_srcHash: { action, srcHash: hash } },
        update: { outText: out, ...(pinned ? { pinned: true } : {}) },
        create: { action, srcHash: hash, srcText: norm.slice(0, 4000), outText: out, pinned },
      });
    } catch {
      /* best-effort persistence */
    }
  }

  private memSet(k: string, v: string): void {
    if (this.mem.size >= this.maxMem) {
      const oldest = this.mem.keys().next().value;
      if (oldest !== undefined) this.mem.delete(oldest);
    }
    this.mem.set(k, v);
  }

  /** Warm the in-memory tier from the DB (pinned first) on boot. */
  async warmFromDb(limit = 4000): Promise<number> {
    try {
      const rows = await this.prisma.agentTranslation.findMany({
        orderBy: [{ pinned: "desc" }, { hits: "desc" }],
        take: limit,
        select: { action: true, srcHash: true, outText: true },
      });
      for (const r of rows) this.memSet(this.key(r.action, r.srcHash), r.outText);
      return rows.length;
    } catch {
      return 0;
    }
  }

  stats(): TranslationCacheStats {
    const total = this.hits + this.misses;
    return { memEntries: this.mem.size, hits: this.hits, misses: this.misses, hitRate: total ? this.hits / total : 0 };
  }
}
