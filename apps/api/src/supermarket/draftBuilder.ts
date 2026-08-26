/**
 * Draft-builder sweep (supermarket plan Phase 3) — turns fresh Yiddish
 * voicemails and inbound texts on supermarket tenants into SupermarketOrderDraft
 * rows the Orders Desk reviews.
 *
 * Shape lessons this sweep inherits (all paid for elsewhere in this repo):
 * - it is a SWEEP over the source tables, never a hook inside voicemail/SMS
 *   ingest — the ingest paths must never gain a failure mode from us;
 * - the fresh WINDOW + the per-source unique key make the backlog structurally
 *   unreachable (the voicemail-email head-of-line lesson): a source older than
 *   the window is never drafted, and a drafted source is never drafted twice;
 * - every skip is cheap and silent; every failure is per-source, never
 *   batch-fatal.
 *
 * The agent's guess is FROZEN into agentItems at build time — that, against
 * what the rep approves, is the correction training data (Phase 7's gauge).
 */

import { buildCatalogIndex, matchDraftText, WIC_COMMENT, type CatalogEntry } from "./draftMatcher";
import { posClientForTenant } from "./integrationCredentials";
import { posPhoneDigits } from "./posWithLogic";

export const DRAFT_BUILDER_DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
export const DRAFT_BUILDER_BOOT_DELAY_MS = 4 * 60 * 1000;
/** Sources older than this are never drafted — bounds the flip-day backlog. */
export const DRAFT_FRESH_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_SOURCES_PER_RUN = 50;
const CATALOG_CAP = 5_000;

export type DraftBuilderDeps = {
  db: any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
  clientFor?: typeof posClientForTenant;
  now?: () => Date;
};

let running = false;

export async function runDraftBuilderSweep(deps: DraftBuilderDeps): Promise<{ drafts: number }> {
  if (running) return { drafts: 0 };
  running = true;
  try {
    return await sweepInner(deps);
  } finally {
    running = false;
  }
}

async function loadCatalogIndex(db: any, tenantId: string) {
  const rows = await db.posCatalogItem.findMany({
    where: { tenantId, isActive: true },
    select: { posProductId: true, code: true, name: true, unitPriceCents: true },
    take: CATALOG_CAP,
  });
  const entries: CatalogEntry[] = rows.map((r: any) => ({
    posProductId: r.posProductId,
    code: r.code,
    name: r.name,
    unitPriceCents: r.unitPriceCents,
  }));
  return buildCatalogIndex(entries);
}

async function lookupCustomer(
  client: any,
  cache: Map<string, { posCustomerId: string | null; name: string }>,
  phoneRaw: string,
): Promise<{ posCustomerId: string | null; name: string }> {
  const phone10 = posPhoneDigits(phoneRaw);
  if (!phone10 || !client) return { posCustomerId: null, name: "" };
  const hit = cache.get(phone10);
  if (hit) return hit;
  let result: { posCustomerId: string | null; name: string } = { posCustomerId: null, name: "" };
  try {
    const body: any = await client.getCustomerByPhone(phone10);
    const id = body?.id ?? body?.customerId ?? null;
    const name = [body?.firstName, body?.lastName].filter(Boolean).join(" ") || String(body?.name ?? "");
    if (id) result = { posCustomerId: String(id), name: name.slice(0, 120) };
  } catch {
    // best-effort: an unreachable register costs the name, never the draft
  }
  cache.set(phone10, result);
  return result;
}

async function sweepInner(deps: DraftBuilderDeps): Promise<{ drafts: number }> {
  const { db } = deps;
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  const now = deps.now ? deps.now() : new Date();
  const since = new Date(now.getTime() - DRAFT_FRESH_WINDOW_MS);
  const clientFor = deps.clientFor ?? posClientForTenant;

  const tenants = await db.tenant.findMany({
    where: { crmMode: "supermarket", pbxRemovedAt: null },
    select: { id: true },
    take: 50,
  });
  let created = 0;

  for (const tenant of tenants) {
    const index = await loadCatalogIndex(db, tenant.id);
    const client = await clientFor(db, tenant.id).catch(() => null);
    const customerCache = new Map<string, { posCustomerId: string | null; name: string }>();

    // ⛔ Exclude already-drafted sources IN THE QUERY, not just per-row. The
    // per-row dedupe alone stalls a busy store forever: with more than
    // MAX_SOURCES_PER_RUN sources inside the window, every sweep re-reads the
    // same oldest 50 (all drafted), creates nothing, and the tail is never
    // reached. Found by STRESS 25 (120 orders → only 50 drafted, ever).
    const drafted = await db.supermarketOrderDraft.findMany({
      where: { tenantId: tenant.id },
      select: { sourceType: true, sourceId: true },
      take: 20_000,
    });
    const draftedVm = drafted.filter((d: any) => d.sourceType === "voicemail").map((d: any) => d.sourceId);
    const draftedText = drafted.filter((d: any) => d.sourceType === "text").map((d: any) => d.sourceId);

    // ── voicemails with transcripts ────────────────────────────────────────
    const voicemails = await db.voicemail.findMany({
      where: {
        tenantId: tenant.id,
        receivedAt: { gte: since },
        transcript: { not: null },
        deletedAt: null,
        ...(draftedVm.length ? { id: { notIn: draftedVm } } : {}),
      },
      select: { id: true, transcript: true, callerNumber: true, callerName: true, receivedAt: true },
      orderBy: { receivedAt: "asc" },
      take: MAX_SOURCES_PER_RUN,
    });
    for (const vm of voicemails) {
      const text = String(vm.transcript ?? "").trim();
      if (!text) continue;
      const existing = await db.supermarketOrderDraft.findFirst({
        where: { tenantId: tenant.id, sourceType: "voicemail", sourceId: vm.id },
        select: { id: true },
      });
      if (existing) continue;
      const match = matchDraftText(text, index);
      const customer = await lookupCustomer(client, customerCache, String(vm.callerNumber ?? ""));
      try {
        await db.supermarketOrderDraft.create({
          data: {
            tenantId: tenant.id,
            sourceType: "voicemail",
            sourceId: vm.id,
            customerName: customer.name || String(vm.callerName ?? ""),
            customerPhone: String(vm.callerNumber ?? ""),
            posCustomerId: customer.posCustomerId,
            transcript: text.slice(0, 8000),
            items: match.items,
            agentItems: match.items,
            comments: match.wicMentioned ? WIC_COMMENT : "",
            notes: match.notes.join("\n").slice(0, 2000),
          },
        });
        created++;
      } catch (err: any) {
        // unique-violation race (two api processes) = already drafted; anything
        // else is per-source and must not kill the sweep.
        if (!String(err?.code ?? "").includes("P2002")) {
          log.warn({ tenantId: tenant.id, voicemailId: vm.id, err: String(err?.message ?? err) }, "draft build failed");
        }
      }
    }

    // ── inbound texts ──────────────────────────────────────────────────────
    const texts = await db.connectChatMessage.findMany({
      where: {
        tenantId: tenant.id,
        direction: "INBOUND",
        createdAt: { gte: since },
        body: { not: "" },
        thread: { type: "SMS" },
        ...(draftedText.length ? { id: { notIn: draftedText } } : {}),
      },
      select: {
        id: true,
        body: true,
        threadId: true,
        createdAt: true,
        thread: { select: { externalSmsE164: true, title: true } },
      },
      orderBy: { createdAt: "asc" },
      take: MAX_SOURCES_PER_RUN,
    });
    for (const msg of texts) {
      const text = String(msg.body ?? "").trim();
      if (text.length < 3) continue;
      const existing = await db.supermarketOrderDraft.findFirst({
        where: { tenantId: tenant.id, sourceType: "text", sourceId: msg.id },
        select: { id: true },
      });
      if (existing) continue;
      const phone = String(msg.thread?.externalSmsE164 ?? "");
      const match = matchDraftText(text, index);
      const customer = await lookupCustomer(client, customerCache, phone);
      try {
        await db.supermarketOrderDraft.create({
          data: {
            tenantId: tenant.id,
            sourceType: "text",
            sourceId: msg.id,
            threadId: msg.threadId,
            customerName: customer.name || String(msg.thread?.title ?? ""),
            customerPhone: phone,
            posCustomerId: customer.posCustomerId,
            transcript: text.slice(0, 8000),
            items: match.items,
            agentItems: match.items,
            comments: match.wicMentioned ? WIC_COMMENT : "",
            notes: match.notes.join("\n").slice(0, 2000),
          },
        });
        created++;
      } catch (err: any) {
        if (!String(err?.code ?? "").includes("P2002")) {
          log.warn({ tenantId: tenant.id, messageId: msg.id, err: String(err?.message ?? err) }, "draft build failed");
        }
      }
    }
  }
  return { drafts: created };
}
