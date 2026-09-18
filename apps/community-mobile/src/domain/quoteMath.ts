/**
 * Pure math for the RFQ "submit a quote" screen — no imports, testable under
 * plain Node (src/domain/quoteMath.test.ts). An RFQ's `quantity` is a loose,
 * buyer-typed string (e.g. "500 units", "2 pallets (approx.)" — see
 * apps/community-api/src/rfq/routes.ts's `createRfqSchema`), not a number,
 * so a vendor's quote form can only *suggest* a per-unit price from the
 * total they type; it never invents a quantity the buyer didn't give.
 */

/** The first number found in a free-text quantity string. Null if none. */
export function extractQuantityNumber(quantity: string | null | undefined): number | null {
  if (!quantity) return null;
  const m = quantity.match(/[\d,]+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Suggested per-unit price = total / quantity. Null when either side is missing/invalid — the form leaves per-unit blank rather than guessing. */
export function suggestPerUnit(total: number | null | undefined, quantity: string | null | undefined): number | null {
  if (total == null || !Number.isFinite(total) || total <= 0) return null;
  const qty = extractQuantityNumber(quantity);
  if (qty == null) return null;
  return round2(total / qty);
}

/** The inverse: a suggested total from a per-unit price and the RFQ's quantity. */
export function suggestTotal(perUnit: number | null | undefined, quantity: string | null | undefined): number | null {
  if (perUnit == null || !Number.isFinite(perUnit) || perUnit <= 0) return null;
  const qty = extractQuantityNumber(quantity);
  if (qty == null) return null;
  return round2(perUnit * qty);
}

/** Formats a money amount (string or number, as the api sends decimals as strings) for display. Returns "—" for anything not a finite number. */
export function formatMoney(amount: number | string | null | undefined, currency = "USD"): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (n == null || !Number.isFinite(n)) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}
