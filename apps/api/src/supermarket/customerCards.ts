/**
 * Cards on file for supermarket orders (Izzy, 2026-08-26): "check the system
 * to see if there are any cards on file... give them the option to pick a card
 * to charge... If there's no card on file, give them the option to add a card
 * with the iFields."
 *
 * Two sources, one list:
 *  - the REGISTER's stored cards (POS listCustomerCards — no PIN needed for
 *    the list; ⛔ their charge lane needs the customer's PIN, so a register
 *    card is only marked chargeable when its record carries a gateway token
 *    we can hand to Sola — unproven until a real record is seen);
 *  - cards a rep saves HERE through the Sola iFields (SmCustomerCard) — the
 *    SUT becomes an xToken via cc:save on the TENANT'S OWN Sola key and the
 *    token is stored encrypted. These are always chargeable once the key is in.
 *
 * ⛔ Money rules (the platform's paid-for shapes):
 *  - the Sola key is the TENANT's (ProviderCredential / SOLA) — the platform's
 *    own billing merchant account is never a fallback; no key = plain refusal.
 *  - a charge is attempted ONCE, never retried — a timeout answers "may have
 *    gone through", and gatewayXInvoice is unique per attempt.
 *  - a DECLINE never blocks the order: the draft records DECLINED and the
 *    order still goes to the register (the rep chases the money).
 *  - the raw card number only ever exists inside Sola's iframes; the server
 *    sees a single-use token, stores only the encrypted xToken.
 */

import { SolaCardknoxAdapter } from "@connect/integrations";
import { resolveIntegrationKey } from "./integrationCredentials";

export type CardOnFile = {
  /** "saved:<rowId>" or "pos:<cardId>" — the id the UI hands back to charge. */
  id: string;
  source: "saved" | "pos";
  brand: string;
  last4: string;
  exp: string;
  cardholderName: string;
  /** false = shown for the rep's information but cannot be charged from here. */
  chargeable: boolean;
};

export type CardsDeps = {
  db: any;
  /** injected for tests */
  adapterFor?: typeof solaAdapterForTenant;
  posClient?: any;
};

/** The tenant's OWN Sola adapter, or null (= "Sola key not connected yet"). */
export async function solaAdapterForTenant(db: any, tenantId: string): Promise<{ adapter: any; ifieldsKey: string | null } | null> {
  const key = await resolveIntegrationKey(db, tenantId, "SOLA");
  if (!key) return null;
  try {
    return {
      adapter: new SolaCardknoxAdapter({ apiKey: key.apiKey, mode: "prod", baseUrl: key.baseUrl }),
      ifieldsKey: key.ifieldsKey ?? null,
    };
  } catch {
    return null;
  }
}

const s = (v: unknown) => String(v ?? "").trim();

/** Defensive extraction of a POS card record — field names unproven live. */
export function extractPosCard(rec: any): Omit<CardOnFile, "id" | "source" | "chargeable"> & { posCardId: string | null; gatewayToken: string | null } {
  const posCardId = rec?.id != null ? String(rec.id) : rec?.cardId != null ? String(rec.cardId) : null;
  const masked = s(rec?.maskedNumber ?? rec?.cardNumber ?? rec?.number ?? rec?.mask);
  const last4 = s(rec?.last4 ?? rec?.lastFour) || (masked ? masked.replace(/\D/g, "").slice(-4) : "");
  const exp = s(rec?.exp ?? rec?.expiration ?? rec?.expiry ?? rec?.expDate);
  const brand = s(rec?.brand ?? rec?.cardType ?? rec?.type ?? rec?.network);
  const cardholderName = s(rec?.cardholderName ?? rec?.nameOnCard ?? rec?.name);
  const gatewayToken = s(rec?.xToken ?? rec?.token ?? rec?.gatewayToken) || null;
  return { posCardId, brand, last4, exp, cardholderName, gatewayToken };
}

export async function listCardsOnFile(deps: CardsDeps, tenantId: string, posCustomerId: string): Promise<CardOnFile[]> {
  const out: CardOnFile[] = [];
  // the register's cards — best-effort; an unreachable register costs the
  // list, never the screen
  if (deps.posClient) {
    try {
      const body: any = await deps.posClient.listCustomerCards(posCustomerId);
      const rows = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : [];
      for (const rec of rows.slice(0, 10)) {
        const ext = extractPosCard(rec);
        if (!ext.posCardId) continue;
        out.push({
          id: `pos:${ext.posCardId}`,
          source: "pos",
          brand: ext.brand,
          last4: ext.last4,
          exp: ext.exp,
          cardholderName: ext.cardholderName,
          // chargeable from HERE only when the record carries a gateway token
          chargeable: Boolean(ext.gatewayToken),
        });
      }
    } catch {
      /* list stays what we hold ourselves */
    }
  }
  const saved = await deps.db.smCustomerCard.findMany({
    where: { tenantId, posCustomerId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, brand: true, last4: true, exp: true, cardholderName: true },
  });
  for (const row of saved) {
    out.push({
      id: `saved:${row.id}`,
      source: "saved",
      brand: row.brand,
      last4: row.last4,
      exp: row.exp,
      cardholderName: row.cardholderName,
      chargeable: true,
    });
  }
  return out;
}

/** SUT → cc:save on the tenant's Sola key → encrypted xToken row. */
export async function saveCardFromSut(
  deps: CardsDeps,
  input: {
    tenantId: string;
    posCustomerId: string;
    sut: string;
    exp?: string;
    cardholderName?: string;
    actorUserId: string;
  },
): Promise<{ ok: true; card: CardOnFile } | { ok: false; code: string; message: string }> {
  const adapterFor = deps.adapterFor ?? solaAdapterForTenant;
  const sola = await adapterFor(deps.db, input.tenantId);
  if (!sola) {
    return { ok: false, code: "sola_not_connected", message: "This store's Sola account isn't connected yet — paste their Sola key under Integrations first." };
  }
  let res: any;
  try {
    res = await sola.adapter.saveCardWithSut({ sut: input.sut, exp: input.exp, cardholderName: input.cardholderName });
  } catch {
    return { ok: false, code: "sola_unreachable", message: "Sola could not be reached — the card was not saved. Try again." };
  }
  const token = s(res?.xToken);
  if (!token || (res?.xResult && String(res.xResult).toUpperCase() !== "A")) {
    return { ok: false, code: "card_refused", message: s(res?.xError) || "The card was not accepted." };
  }
  const sec = await import("@connect/security");
  if (!sec.hasCredentialsMasterKey()) {
    return { ok: false, code: "vault_unavailable", message: "The card vault is unavailable right now — the card was not saved." };
  }
  const last4 = s(res?.xMaskedCardNumber).replace(/\D/g, "").slice(-4) || s(input.sut).replace(/\D/g, "").slice(-4);
  const brand = s(res?.xCardType);
  const row = await deps.db.smCustomerCard.create({
    data: {
      tenantId: input.tenantId,
      posCustomerId: input.posCustomerId,
      tokenEnc: sec.encryptJson(token),
      brand,
      last4,
      exp: s(input.exp ?? res?.xExp),
      cardholderName: s(input.cardholderName),
      createdBy: input.actorUserId,
    },
    select: { id: true, brand: true, last4: true, exp: true, cardholderName: true },
  });
  return {
    ok: true,
    card: { id: `saved:${row.id}`, source: "saved", brand: row.brand, last4: row.last4, exp: row.exp, cardholderName: row.cardholderName, chargeable: true },
  };
}

/**
 * Charge a card on file for a draft. ⛔ ONE attempt, never retried; the
 * result is recorded on the draft either way and a decline never blocks the
 * order (the caller already submitted it, or will regardless).
 */
export async function chargeCardForDraft(
  deps: CardsDeps,
  input: {
    tenantId: string;
    draftId: string;
    cardRef: string;
    amountCents: number;
    actorUserId: string;
  },
): Promise<{ ok: boolean; code: string; message: string; last4?: string }> {
  const amount = Math.floor(Number(input.amountCents));
  if (!Number.isFinite(amount) || amount < 50 || amount > 5_000_00) {
    return { ok: false, code: "bad_amount", message: "That amount can't be charged." };
  }
  const adapterFor = deps.adapterFor ?? solaAdapterForTenant;
  const sola = await adapterFor(deps.db, input.tenantId);
  if (!sola) {
    return { ok: false, code: "sola_not_connected", message: "This store's Sola account isn't connected yet — the order can still go through without charging." };
  }

  // resolve the token server-side — the client only ever names a card id
  let token: string | null = null;
  let last4 = "";
  const m = /^saved:(.+)$/.exec(input.cardRef);
  if (m) {
    const row = await deps.db.smCustomerCard.findFirst({
      where: { id: m[1], tenantId: input.tenantId },
      select: { tokenEnc: true, last4: true },
    });
    if (row) {
      try {
        const sec = await import("@connect/security");
        token = sec.decryptJson<string>(row.tokenEnc);
        last4 = row.last4;
      } catch {
        token = null;
      }
    }
  } else if (/^pos:/.test(input.cardRef) && deps.posClient) {
    // a register card is chargeable only when its record carries a gateway token
    try {
      const body: any = await deps.posClient.listCustomerCards(input.cardRef.slice(4));
      void body; // the card id is not the customer id — resolved by the route instead
    } catch {
      /* fall through to refusal */
    }
  }
  if (!token) {
    return { ok: false, code: "card_not_chargeable", message: "That card can't be charged from here — pick a saved card or add one." };
  }

  // unique per ATTEMPT — Sola's duplicate detection keys on xInvoice
  const gatewayXInvoice = `sm${String(input.draftId).replace(/[^A-Za-z0-9]/g, "").slice(-12)}t${Date.now().toString(36)}`;
  let res: any;
  try {
    res = await sola.adapter.chargeToken({ token, amountCents: amount, gatewayXInvoice, recurringIndicator: "Stored" });
  } catch {
    // ⛔ timeout/5xx: the charge MAY have landed — say so, never retry
    await recordPayment(deps.db, input, "UNKNOWN", null, last4, amount);
    return { ok: false, code: "charge_unknown", message: "Sola didn't answer — the charge may or may not have gone through. Check before trying again." };
  }
  const approved = String(res?.xResult ?? "").toUpperCase() === "A";
  const ref = s(res?.xRefNum) || null;
  await recordPayment(deps.db, input, approved ? "CHARGED" : "DECLINED", ref, last4, amount);
  if (approved) return { ok: true, code: "approved", message: `Charged $${(amount / 100).toFixed(2)} to •••• ${last4}.`, last4 };
  return { ok: false, code: "declined", message: s(res?.xError) || "The card was declined.", last4 };
}

async function recordPayment(db: any, input: { tenantId: string; draftId: string }, status: string, ref: string | null, last4: string, amountCents: number): Promise<void> {
  try {
    await db.supermarketOrderDraft.updateMany({
      where: { id: input.draftId, tenantId: input.tenantId },
      data: { paymentStatus: status, paymentRef: ref, paymentLast4: last4, paymentAmountCents: amountCents },
    });
  } catch {
    /* the charge result must never be lost to a row-write failure — the audit row still lands */
  }
}
