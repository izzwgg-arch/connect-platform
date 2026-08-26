/**
 * Teach the Agent — the admin correction lane (Izzy, 2026-08-26: "every word
 * or sentence the agent doesn't understand should go in there... a search box
 * to search the database for items, and I can just select the item and then
 * boom, enter").
 *
 * The QUEUE is derived, never stored: it is the distinct skipped phrases
 * across recent drafts' agentLines, minus what is already taught (a lesson
 * exists) or dismissed. Teaching writes into the SAME
 * SupermarketPhraseLesson table the rep-fix harvest writes into — one
 * mistakes database, two teachers — with source "taught".
 */
import { normalizePhrase } from "./phraseLessons";

export type TeachQueueRow = {
  /** normalized key — what teach/dismiss POST back */
  phrase: string;
  /** the phrase as last heard, for display */
  displayPhrase: string;
  qty: number;
  constraints?: string;
  reason: string;
  count: number;
  lastHeardAt: string;
  lastCustomer: string;
  lastSourceType: string;
  lastDraftId: string;
};

/**
 * Aggregate skipped lines out of recent drafts. Pure — the route feeds it
 * rows and the already-taught/dismissed key sets.
 */
export function buildTeachQueue(
  drafts: Array<{ id: string; customerName: string; sourceType: string; createdAt: Date | string; agentLines?: unknown }>,
  taughtKeys: Set<string>,
  dismissedKeys: Set<string>,
): TeachQueueRow[] {
  const byKey = new Map<string, TeachQueueRow>();
  for (const d of drafts) {
    const lines = Array.isArray(d.agentLines) ? (d.agentLines as any[]) : [];
    for (const l of lines) {
      if (l?.outcome !== "skipped" || !l?.phrase) continue;
      const display = String(l.phrase).slice(0, 160);
      const key = normalizePhrase(display);
      if (!key || taughtKeys.has(key) || dismissedKeys.has(key)) continue;
      const at = new Date(d.createdAt as any);
      const atIso = Number.isNaN(at.getTime()) ? new Date(0).toISOString() : at.toISOString();
      const existing = byKey.get(key);
      if (existing) {
        existing.count++;
        if (atIso > existing.lastHeardAt) {
          existing.lastHeardAt = atIso;
          existing.displayPhrase = display;
          existing.lastCustomer = String(d.customerName ?? "");
          existing.lastSourceType = String(d.sourceType ?? "");
          existing.lastDraftId = d.id;
          existing.reason = String(l.reason ?? existing.reason ?? "");
          existing.qty = Math.max(1, Math.floor(Number(l.qty ?? 1)) || 1);
          existing.constraints = l.constraints ? String(l.constraints).slice(0, 240) : existing.constraints;
        }
      } else {
        byKey.set(key, {
          phrase: key,
          displayPhrase: display,
          qty: Math.max(1, Math.floor(Number(l.qty ?? 1)) || 1),
          ...(l.constraints ? { constraints: String(l.constraints).slice(0, 240) } : {}),
          reason: String(l.reason ?? "No match found in the catalog"),
          count: 1,
          lastHeardAt: atIso,
          lastCustomer: String(d.customerName ?? ""),
          lastSourceType: String(d.sourceType ?? ""),
          lastDraftId: d.id,
        });
      }
    }
  }
  // most-heard first, then most recent — the daily-triage order
  return [...byKey.values()].sort((a, b) => b.count - a.count || (b.lastHeardAt < a.lastHeardAt ? -1 : 1)).slice(0, 200);
}

/**
 * Teach: upsert the lesson as source "taught" and clear any dismissal.
 * `meantPhrase` — "what he meant to say" (Izzy) — teaches a SECOND lesson on
 * the corrected wording, so a future correctly-translated order matches too.
 * The teach page passes the admin's own search text as the meant phrase: the
 * words they typed to FIND the item are literally what the customer meant.
 */
export async function teachPhrase(
  db: any,
  tenantId: string,
  rawPhrase: string,
  posProductId: string,
  meantPhrase?: string,
): Promise<{ phrase: string } | null> {
  const phrase = normalizePhrase(rawPhrase);
  if (!phrase || !posProductId) return null;
  const upsert = async (key: string, display: string) => {
    await db.supermarketPhraseLesson.upsert({
      where: { tenantId_phrase_posProductId: { tenantId, phrase: key, posProductId } },
      create: { tenantId, phrase: key, displayPhrase: display.slice(0, 160), posProductId, source: "taught" },
      update: { source: "taught", timesConfirmed: { increment: 1 }, lastConfirmedAt: new Date(), displayPhrase: display.slice(0, 160) },
    });
  };
  await upsert(phrase, String(rawPhrase));
  const meantKey = meantPhrase ? normalizePhrase(meantPhrase) : "";
  if (meantKey && meantKey !== phrase) await upsert(meantKey, String(meantPhrase));
  await db.supermarketPhraseDismissal.deleteMany({ where: { tenantId, phrase } }).catch(() => {});
  return { phrase };
}

export async function dismissPhrase(db: any, tenantId: string, rawPhrase: string): Promise<{ phrase: string } | null> {
  const phrase = normalizePhrase(rawPhrase);
  if (!phrase) return null;
  await db.supermarketPhraseDismissal.upsert({
    where: { tenantId_phrase: { tenantId, phrase } },
    create: { tenantId, phrase },
    update: {},
  });
  return { phrase };
}

export async function undismissPhrase(db: any, tenantId: string, rawPhrase: string): Promise<{ phrase: string } | null> {
  const phrase = normalizePhrase(rawPhrase);
  if (!phrase) return null;
  await db.supermarketPhraseDismissal.deleteMany({ where: { tenantId, phrase } });
  return { phrase };
}
