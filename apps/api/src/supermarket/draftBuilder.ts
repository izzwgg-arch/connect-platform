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
import { extractPosCustomer, posPhoneDigits } from "./posWithLogic";
import { prepareOrderText } from "./orderYiddish";
import { runOrderBrain } from "./orderBrain";

export const DRAFT_BUILDER_DEFAULT_INTERVAL_MS = 2 * 60 * 1000;
export const DRAFT_BUILDER_BOOT_DELAY_MS = 4 * 60 * 1000;
/** Sources older than this are never drafted — bounds the flip-day backlog. */
export const DRAFT_FRESH_WINDOW_MS = 72 * 60 * 60 * 1000;
const MAX_SOURCES_PER_RUN = 50;
const CATALOG_CAP = 5_000;
/**
 * ⛔ YL bills per credit and AUDIO is the expensive kind — a sweep transcribes
 * at most this many voicemails per run; the rest simply wait for the next tick
 * (the fresh window is 72h, so nothing is lost, only paced).
 */
export const YL_TRANSCRIPTIONS_PER_RUN = Math.max(
  1,
  Number(process.env.SUPERMARKET_YL_MAX_TRANSCRIPTIONS_PER_RUN || 10),
);

export type DraftBuilderDeps = {
  db: any;
  log?: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void };
  clientFor?: typeof posClientForTenant;
  now?: () => Date;
  /** injected for tests / the reprocess door */
  prepareText?: typeof prepareOrderText;
  brain?: typeof runOrderBrain;
};

export type DraftContent = {
  transcript: string;
  translation: string;
  items: any[];
  comments: string;
  notes: string;
  /** honest provenance: "brain:<model>[+yl]" or "matcher[+yl]" */
  engine: string;
  /** The brain judged this message NOT an order (complaint/question/chatter). */
  notAnOrder?: string;
  /** The account phone the customer STATED in the message (10 digits). */
  statedPhone?: string;
};

/**
 * The whole order-understanding pipeline for ONE source, per Izzy's rule
 * (2026-08-26): Yiddish Labs ONLY for transcription/translation, then the
 * OpenAI brain fills the items with the constraints honoured — and every
 * failure degrades to the next-best layer instead of blocking the draft:
 * YL audio → YL translate → brain → regex matcher.
 */
export async function composeDraftContent(
  deps: DraftBuilderDeps,
  tenantId: string,
  index: ReturnType<typeof buildCatalogIndex>,
  input: {
    kind: "voicemail" | "text";
    text: string;
    localAudioPath?: string | null;
    voicemailId?: string;
    customerPhone?: string;
    /**
     * A REPROCESS of a draft that already carries YL's transcript+translation
     * reuses them instead of re-billing YL for the same audio — only the
     * brain re-runs.
     */
    preTranslated?: { transcript: string; translation: string };
  },
): Promise<DraftContent> {
  const prepare = deps.prepareText ?? prepareOrderText;
  const brain = deps.brain ?? runOrderBrain;
  const prepared = input.preTranslated
    ? { transcript: input.preTranslated.transcript, translation: input.preTranslated.translation, engine: "yiddishlabs" as const, error: undefined }
    : await prepare(
        { db: deps.db },
        { kind: input.kind, text: input.text, localAudioPath: input.localAudioPath, voicemailId: input.voicemailId },
      );
  const english = (prepared.translation || prepared.transcript).trim();
  const ylTag = prepared.engine.startsWith("yiddishlabs") ? "+yl" : "";
  const prefixNotes = prepared.error ? [`transcription: ${prepared.error}`] : [];
  const brainResult = english
    ? await brain({ db: deps.db }, tenantId, english, { customerPhone: input.customerPhone }).catch(() => null)
    : null;
  if (brainResult) {
    return {
      transcript: prepared.transcript.slice(0, 8000),
      translation: prepared.translation.slice(0, 8000),
      items: brainResult.items,
      comments: brainResult.comments.join("\n").slice(0, 1000),
      notes: [...prefixNotes, ...brainResult.notes].join("\n").slice(0, 2000),
      engine: `brain:${brainResult.model}${ylTag}`,
      notAnOrder: brainResult.notAnOrder?.reason,
      statedPhone: brainResult.customerPhone,
    };
  }
  // no tenant OpenAI key / brain failure → the regex matcher over the ENGLISH
  // text (or the raw source when even YL had nothing to give us).
  const match = matchDraftText(english || String(input.text ?? ""), index);
  return {
    transcript: prepared.transcript.slice(0, 8000),
    translation: prepared.translation.slice(0, 8000),
    items: match.items,
    comments: match.wicMentioned ? WIC_COMMENT : "",
    notes: [...prefixNotes, ...match.notes].join("\n").slice(0, 2000),
    engine: `matcher${ylTag}`,
  };
}

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

export async function loadCatalogIndex(db: any, tenantId: string) {
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

export type PosCustomerHit = { posCustomerId: string | null; name: string; info: any | null };

export async function lookupCustomer(
  client: any,
  cache: Map<string, PosCustomerHit>,
  phoneRaw: string,
): Promise<PosCustomerHit> {
  const phone10 = posPhoneDigits(phoneRaw);
  if (!phone10 || !client) return { posCustomerId: null, name: "", info: null };
  const hit = cache.get(phone10);
  if (hit) return hit;
  let result: PosCustomerHit = { posCustomerId: null, name: "", info: null };
  try {
    const body: any = await client.getCustomerByPhone(phone10);
    // "once we find the account, it should bring in everything" — the whole
    // extracted record rides the draft, not just the id.
    const ext = extractPosCustomer(body);
    if (ext?.posCustomerId) result = { posCustomerId: ext.posCustomerId, name: ext.name, info: ext };
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
  let ylSpent = 0;

  for (const tenant of tenants) {
    const index = await loadCatalogIndex(db, tenant.id);
    const client = await clientFor(db, tenant.id).catch(() => null);
    const customerCache = new Map<string, PosCustomerHit>();

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
        // audio alone is enough now — YL transcribes it; the agent transcript
        // is only the fallback when there is no local audio copy.
        OR: [{ transcript: { not: null } }, { localAudioPath: { not: null } }],
        deletedAt: null,
        ...(draftedVm.length ? { id: { notIn: draftedVm } } : {}),
      },
      select: { id: true, transcript: true, callerNumber: true, callerName: true, receivedAt: true, localAudioPath: true },
      orderBy: { receivedAt: "asc" },
      take: MAX_SOURCES_PER_RUN,
    });
    for (const vm of voicemails) {
      const text = String(vm.transcript ?? "").trim();
      const hasAudio = Boolean(vm.localAudioPath);
      if (!text && !hasAudio) continue;
      const existing = await db.supermarketOrderDraft.findFirst({
        where: { tenantId: tenant.id, sourceType: "voicemail", sourceId: vm.id },
        select: { id: true },
      });
      if (existing) continue;
      // ⛔ over the per-run YL audio budget the voicemail WAITS for the next
      // tick — better a later draft than one with the worse transcript baked
      // in forever.
      if (hasAudio && ylSpent >= YL_TRANSCRIPTIONS_PER_RUN) continue;
      if (hasAudio) ylSpent++;
      const content = await composeDraftContent(deps, tenant.id, index, {
        kind: "voicemail",
        text,
        localAudioPath: vm.localAudioPath,
        voicemailId: vm.id,
        customerPhone: String(vm.callerNumber ?? ""),
      });
      // ⛔ the account IS the phone number (Izzy) — the number the customer
      // SPOKE in the message beats caller ID for the account lookup.
      const accountPhone = content.statedPhone || String(vm.callerNumber ?? "");
      const customer = await lookupCustomer(client, customerCache, accountPhone);
      try {
        await db.supermarketOrderDraft.create({
          data: {
            tenantId: tenant.id,
            sourceType: "voicemail",
            sourceId: vm.id,
            ...(content.notAnOrder ? { status: "DISMISSED" } : {}),
            customerName: customer.name || String(vm.callerName ?? ""),
            customerPhone: accountPhone,
            posCustomerId: customer.posCustomerId,
            ...(customer.info ? { customerInfo: customer.info } : {}),
            transcript: content.transcript,
            translation: content.translation,
            items: content.items,
            agentItems: content.items,
            comments: content.comments,
            notes: content.notes,
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
      const content = await composeDraftContent(deps, tenant.id, index, { kind: "text", text, customerPhone: phone });
      const accountPhone = content.statedPhone || phone;
      const customer = await lookupCustomer(client, customerCache, accountPhone);
      try {
        await db.supermarketOrderDraft.create({
          data: {
            tenantId: tenant.id,
            sourceType: "text",
            sourceId: msg.id,
            threadId: msg.threadId,
            ...(content.notAnOrder ? { status: "DISMISSED" } : {}),
            customerName: customer.name || String(msg.thread?.title ?? ""),
            customerPhone: accountPhone,
            posCustomerId: customer.posCustomerId,
            ...(customer.info ? { customerInfo: customer.info } : {}),
            transcript: content.transcript,
            translation: content.translation,
            items: content.items,
            agentItems: content.items,
            comments: content.comments,
            notes: content.notes,
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
