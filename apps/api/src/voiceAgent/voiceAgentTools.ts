/**
 * Voice-agent tool execution — the server side of every model tool call.
 *
 * ⛔ THE MODEL'S ARGUMENTS ARE UNTRUSTED INPUT. Every price on a finalized
 * order comes from the CATALOG at execution time — the model can say any
 * number it likes and it changes nothing. Any tenant-shaped field in the
 * arguments is ignored: tenant and call identity come from the session the
 * api itself issued (the toolRegistry rule, applied to voice).
 *
 * finalize_order writes a SupermarketOrderDraft (sourceType "voice_call",
 * sourceId = the call's session uuid) — the SAME review queue voicemail and
 * text orders land in, with the AI's guess frozen into agentItems as training
 * data. ⛔ It NEVER touches the POS: approveAndSubmitDraft in
 * supermarket/orderSubmit.ts is the only register-submit path, behind a
 * human's approval (or, later, earned auto-submit through decideAutoSubmit —
 * never around it).
 */

import { searchCatalog, lookupByCodes, centsToText } from "./voiceAgentCatalog";

export interface ToolExecInput {
  db: any;
  tenantId: string;
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface ToolExecResult {
  ok: boolean;
  /** JSON string handed back to the model verbatim. */
  output: string;
  draftId?: string | null;
}

const MAX_LINE_QTY = 99;
const MAX_ORDER_LINES = 60;

export async function executeVoiceAgentTool(input: ToolExecInput): Promise<ToolExecResult> {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(input.argumentsJson || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
  } catch {
    return { ok: false, output: JSON.stringify({ error: "arguments_not_json" }) };
  }

  if (input.name === "search_items") {
    const query = String(args["query"] ?? "").slice(0, 120);
    const matches = await searchCatalog(input.db, input.tenantId, query);
    if (matches.length === 0) {
      return {
        ok: true,
        output: JSON.stringify({
          matches: [],
          note: "No matching item. Ask the caller to spell the name or give the item number.",
        }),
      };
    }
    return {
      ok: true,
      output: JSON.stringify({
        matches: matches.map((m) => ({ itemNumber: m.itemNumber, name: m.name, price: m.priceText })),
      }),
    };
  }

  if (input.name === "finalize_order") {
    return finalizeOrder(input, args);
  }

  return { ok: false, output: JSON.stringify({ error: "unknown_tool" }) };
}

async function finalizeOrder(input: ToolExecInput, args: Record<string, unknown>): Promise<ToolExecResult> {
  const rawItems = Array.isArray(args["items"]) ? (args["items"] as unknown[]) : [];
  if (rawItems.length === 0) {
    return { ok: false, output: JSON.stringify({ error: "empty_order", note: "Ask what they would like to order." }) };
  }
  if (rawItems.length > MAX_ORDER_LINES) {
    return { ok: false, output: JSON.stringify({ error: "too_many_lines" }) };
  }

  // Collapse duplicates and clamp quantities BEFORE touching the db.
  const wanted = new Map<string, number>();
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object") continue;
    const code = String((raw as { itemNumber?: unknown }).itemNumber ?? "").trim().slice(0, 40);
    const qty = Number((raw as { quantity?: unknown }).quantity);
    if (!code || !Number.isFinite(qty) || qty <= 0) continue;
    wanted.set(code, Math.min(MAX_LINE_QTY, (wanted.get(code) ?? 0) + Math.round(qty)));
  }
  if (wanted.size === 0) {
    return { ok: false, output: JSON.stringify({ error: "no_valid_items" }) };
  }

  const catalog = await lookupByCodes(input.db, input.tenantId, [...wanted.keys()]);
  const unknown = [...wanted.keys()].filter((c) => !catalog.has(c));
  if (unknown.length > 0) {
    // ⛔ Refuse the WHOLE order rather than silently dropping lines — a
    // caller told "your order went through" must get every item they heard
    // read back.
    return {
      ok: false,
      output: JSON.stringify({
        error: "unknown_items",
        itemNumbers: unknown.slice(0, 10),
        note: "These items are not in the catalog. Search again and correct the order before finalizing.",
      }),
    };
  }

  // Server-side pricing — the model's idea of a price is never consulted.
  const lines = [...wanted.entries()].map(([code, qty]) => {
    const row = catalog.get(code)!;
    return {
      code,
      name: row.name,
      qty,
      unitPriceCents: row.unitPriceCents,
      posProductId: row.posProductId,
      matchedFrom: "voice_agent",
    };
  });
  const subtotalCents = lines.reduce((sum, l) => sum + l.qty * l.unitPriceCents, 0);

  const call = await input.db.voiceAgentCall.findUnique({
    where: { id: input.callId },
    select: { id: true, tenantId: true, sessionUuid: true, callerNumber: true, draftId: true },
  });
  if (!call || call.tenantId !== input.tenantId) {
    return { ok: false, output: JSON.stringify({ error: "call_not_found" }) };
  }
  if (call.draftId) {
    // One order per call — a model retrying finalize must not duplicate.
    return {
      ok: true,
      draftId: call.draftId,
      output: JSON.stringify({ ok: true, note: "The order was already placed on this call.", totalText: centsToText(subtotalCents) }),
    };
  }

  const comments = String(args["comments"] ?? "").slice(0, 1000);
  const notes = String(args["notes"] ?? "").slice(0, 2000);
  const customerName = String(args["customerName"] ?? "").slice(0, 120);

  // sourceType+sourceId is the draft table's dedupe anchor — one draft per
  // call, enforced by the DB even if two finalize calls race.
  let draft;
  try {
    draft = await input.db.supermarketOrderDraft.create({
      data: {
        tenantId: input.tenantId,
        sourceType: "voice_call",
        sourceId: call.sessionUuid,
        customerName,
        customerPhone: call.callerNumber ?? "",
        transcript: "",
        translation: "",
        items: lines,
        agentItems: lines,
        comments,
        notes,
        status: "NEEDS_REVIEW",
        orderMethod: "Delivery",
      },
      select: { id: true },
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      const existing = await input.db.supermarketOrderDraft.findFirst({
        where: { tenantId: input.tenantId, sourceType: "voice_call", sourceId: call.sessionUuid },
        select: { id: true },
      });
      return {
        ok: true,
        draftId: existing?.id ?? null,
        output: JSON.stringify({ ok: true, note: "The order was already placed on this call.", totalText: centsToText(subtotalCents) }),
      };
    }
    return { ok: false, output: JSON.stringify({ error: "order_save_failed", note: "Apologise and offer to transfer to a person." }) };
  }

  await input.db.voiceAgentCall
    .update({ where: { id: input.callId }, data: { draftId: draft.id } })
    .catch(() => undefined);

  return {
    ok: true,
    draftId: draft.id,
    output: JSON.stringify({
      ok: true,
      orderReference: draft.id.slice(-6).toUpperCase(),
      totalText: centsToText(subtotalCents),
      itemCount: lines.reduce((n, l) => n + l.qty, 0),
      note: "Order placed for review by the store. Tell the caller the total and thank them.",
    }),
  };
}
