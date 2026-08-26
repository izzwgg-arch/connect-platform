/**
 * POS with Logic client — Gesheft's register system (https://api.poswithlogic.dev).
 *
 * Design rules, each earned elsewhere in this repo:
 * - ⛔ ZERO dependencies beyond the standard library. An undeclared import killed
 *   apps/api at boot once (`undici`); this file is plain fetch + hand-built URLs.
 * - ⛔ The client NEVER retries a write. Writes are 18 credits each and two of
 *   them move money (`/charges`) or create real orders. A timeout means "I
 *   stopped listening", never "it did not happen" — callers must re-read before
 *   re-writing (the VoIP.ms rotation lesson). Reads may be retried by CALLERS,
 *   honoring `retryAfterSec`.
 * - ⛔ `X-Customer-Pin` is required by THEIR api on balance reads and charges
 *   (and on-account orders). It travels only in the header, is never logged,
 *   and never lands in an error object (`describePinlessHeaders`).
 * - ⛔ `priceQty` is a DIVISOR: unit price = price / priceQty. Ignoring it
 *   mis-prices bulk items ("2 for $10").
 * - Amounts are handled in integer CENTS internally and rendered as decimal
 *   dollars only at the wire (their api takes 0.01–99999.99).
 *
 * Everything here is pure + injectable (fetch comes in as a dep) so the whole
 * client is drivable by tests and by the 25-test stress suite without a key.
 */

export const POS_DEFAULT_BASE_URL = "https://api.poswithlogic.dev";

/** Their documented charge bounds, in cents. */
export const POS_MIN_CHARGE_CENTS = 1;
export const POS_MAX_CHARGE_CENTS = 9999999; // $99,999.99

/** externalId / externalInvoiceId are capped at 20 chars by their api. */
export const POS_EXTERNAL_ID_MAX = 20;

export type PosCredentials = {
  apiKey: string;
  /** Override for tests / a future sandbox. Must be https. */
  baseUrl?: string;
};

export type PosFetchResponse = {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
};
export type PosFetch = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<PosFetchResponse>;

export class PosApiError extends Error {
  status: number;
  code: string;
  /** Seconds from a Retry-After header when the api answered 429, else null. */
  retryAfterSec: number | null;
  /** Bounded slice of the response body — safe to log, never contains our headers. */
  bodyPreview: string;
  constructor(message: string, status: number, code: string, bodyPreview = "", retryAfterSec: number | null = null) {
    super(message);
    this.name = "PosApiError";
    this.status = status;
    this.code = code;
    this.bodyPreview = bodyPreview.slice(0, 300);
    this.retryAfterSec = retryAfterSec;
  }
}

function classifyStatus(status: number): string {
  if (status === 401 || status === 403) return "pos_auth_failed";
  if (status === 402) return "pos_out_of_credits";
  if (status === 404) return "pos_not_found";
  if (status === 409) return "pos_duplicate";
  if (status === 422 || status === 400) return "pos_rejected";
  if (status === 429) return "pos_rate_limited";
  if (status >= 500) return "pos_unavailable";
  return "pos_error";
}

/** 10-digit US phone for their /customers/phonenumber/{phone} path. */
export function posPhoneDigits(input: string): string | null {
  const digits = String(input ?? "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  // ⛔ Izzy, 2026-08-26: the account IS the phone number, "the area code is
  // always 845" — customers routinely speak/type only seven digits.
  if (digits.length === 7) return `845${digits}`;
  return null;
}

/**
 * Everything the register knows about a customer, extracted defensively — the
 * record's exact field names are unproven (⛔ Gesheft's key is scoped
 * customer:get access-level "own" as of 2026-08-26, so no live record has ever
 * been read; POS with Logic must raise it to "all" before lookups return).
 * Izzy's rule: once the account is found, EVERYTHING comes into the order.
 */
export function extractPosCustomer(body: any): {
  posCustomerId: string | null;
  name: string;
  phone: string;
  address: string;
  email: string;
  raw: any;
} | null {
  if (!body || typeof body !== "object") return null;
  const rec: any = Array.isArray((body as any).results) ? (body as any).results[0] : body;
  if (!rec || typeof rec !== "object") return null;
  const id = rec.id ?? rec.customerId ?? rec.customerID ?? null;
  const name =
    [rec.firstName, rec.lastName].filter(Boolean).join(" ") ||
    String(rec.name ?? rec.fullName ?? "");
  const street = String(rec.address ?? rec.address1 ?? rec.street ?? "");
  const city = String(rec.city ?? "");
  const state = String(rec.state ?? "");
  const zip = String(rec.zip ?? rec.zipCode ?? rec.postalCode ?? "");
  const address = [street, [city, state].filter(Boolean).join(" "), zip].filter(Boolean).join(", ");
  const phone = String(rec.phoneNumber ?? rec.phone ?? rec.phone1 ?? "");
  const email = String(rec.email ?? "");
  if (!id && !name) return null;
  let raw: any = null;
  try {
    const s = JSON.stringify(rec);
    raw = s.length <= 4000 ? rec : null;
  } catch {
    raw = null;
  }
  return { posCustomerId: id != null ? String(id) : null, name: name.slice(0, 120), phone, address: address.slice(0, 300), email: email.slice(0, 200), raw };
}

/** A customer PIN their api accepts: 1–8 chars, no whitespace/control chars. */
export function isValidPosPin(pin: string): boolean {
  if (typeof pin !== "string") return false;
  if (pin.length < 1 || pin.length > 8) return false;
  return /^[\x21-\x7e]+$/.test(pin);
}

export function centsToPosAmount(cents: number): string {
  if (!Number.isInteger(cents)) throw new PosApiError("amount must be integer cents", 0, "pos_bad_amount");
  if (cents < POS_MIN_CHARGE_CENTS || cents > POS_MAX_CHARGE_CENTS) {
    throw new PosApiError("amount out of range", 0, "pos_bad_amount");
  }
  return (cents / 100).toFixed(2);
}

export function posAmountToCents(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Unit price in cents from their price + priceQty divisor.
 * priceQty <= 0 or non-finite → treat as 1 (their default), never divide by 0.
 */
export function posUnitPriceCents(price: unknown, priceQty: unknown): number | null {
  const priceCents = posAmountToCents(price);
  if (priceCents === null) return null;
  const qty = typeof priceQty === "number" && Number.isFinite(priceQty) && priceQty > 0 ? priceQty : 1;
  return Math.round(priceCents / qty);
}

/** Bounded external id: our cuid-ish ids are longer than their 20-char cap. */
export function toPosExternalId(id: string): string {
  const cleaned = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, POS_EXTERNAL_ID_MAX);
  if (!cleaned) throw new PosApiError("external id required", 0, "pos_bad_external_id");
  return cleaned;
}

type RequestOptions = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  customerPin?: string;
  timeoutMs?: number;
};

export type PosClientDeps = {
  fetchImpl?: PosFetch;
  /** Called after every completed request with the documented credit cost. */
  onCredits?: (info: { path: string; method: string; credits: number; status: number }) => void;
};

/** Documented credit costs; unknown paths assume 1 so budgets stay conservative. */
export function creditCostFor(method: string, path: string): number {
  if (method === "POST") {
    if (path.startsWith("/orders") || path.startsWith("/invoices") || /\/charges$/.test(path)) return 18;
    if (/\/cards$/.test(path)) return 1;
    return 1;
  }
  if (path.startsWith("/orders/") || path.startsWith("/invoices/")) return 0;
  if (/\/cards(\/|$)/.test(path)) return 0;
  return 1;
}

export class PosWithLogicClient {
  private readonly creds: PosCredentials;
  private readonly fetchImpl: PosFetch;
  private readonly onCredits: PosClientDeps["onCredits"];

  constructor(creds: PosCredentials, deps: PosClientDeps = {}) {
    if (!creds || typeof creds.apiKey !== "string" || creds.apiKey.trim().length < 8) {
      throw new PosApiError("POS api key missing", 0, "pos_key_missing");
    }
    const base = (creds.baseUrl ?? POS_DEFAULT_BASE_URL).replace(/\/+$/, "");
    if (!/^https:\/\//.test(base) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
      throw new PosApiError("POS base url must be https", 0, "pos_bad_base_url");
    }
    this.creds = { apiKey: creds.apiKey.trim(), baseUrl: base };
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<PosFetchResponse>);
    this.onCredits = deps.onCredits;
  }

  private async request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(this.creds.baseUrl + opts.path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      "x-api-key": this.creds.apiKey,
      accept: "application/json",
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.customerPin !== undefined) {
      if (!isValidPosPin(opts.customerPin)) throw new PosApiError("invalid customer PIN shape", 0, "pos_bad_pin");
      headers["X-Customer-Pin"] = opts.customerPin;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
    let res: PosFetchResponse;
    try {
      res = await this.fetchImpl(url.toString(), {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
    } catch (err: any) {
      clearTimeout(timer);
      const aborted = err?.name === "AbortError" || controller.signal.aborted;
      throw new PosApiError(
        aborted ? "POS request timed out — it MAY still have landed; re-read before retrying" : "POS unreachable",
        0,
        aborted ? "pos_timeout" : "pos_unreachable",
      );
    }
    clearTimeout(timer);
    const text = await res.text().catch(() => "");
    try {
      this.onCredits?.({ path: opts.path, method: opts.method, credits: creditCostFor(opts.method, opts.path), status: res.status });
    } catch {
      /* accounting must never fail a request */
    }
    if (res.status >= 200 && res.status < 300) {
      if (!text) return undefined as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new PosApiError("POS returned unparseable JSON", res.status, "pos_bad_response", text);
      }
    }
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfterSec = retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim()) ? Number(retryAfterRaw.trim()) : null;
    throw new PosApiError(
      `POS answered ${res.status} on ${opts.method} ${opts.path}`,
      res.status,
      classifyStatus(res.status),
      text,
      retryAfterSec,
    );
  }

  // ---------- customers ----------
  getCustomerByPhone(phone10: string) {
    return this.request<Record<string, unknown>>({ method: "GET", path: `/customers/phonenumber/${phone10}` });
  }
  getCustomerIdByPhone(phone10: string) {
    return this.request<Record<string, unknown>>({ method: "GET", path: `/customers/phonenumber/${phone10}/id` });
  }
  getCustomerById(id: string) {
    return this.request<Record<string, unknown>>({ method: "GET", path: `/customers/id/${encodeURIComponent(id)}` });
  }
  listCustomers(q: { take?: number; cursor?: string; lastMod?: string }) {
    return this.request<Record<string, unknown>>({ method: "GET", path: "/customers", query: q });
  }
  getCustomerBalance(customerId: string, pin: string) {
    return this.request<Record<string, unknown>>({
      method: "GET",
      path: `/customers/id/${encodeURIComponent(customerId)}/balance`,
      customerPin: pin,
    });
  }
  listCustomerCards(customerId: string) {
    return this.request<Array<Record<string, unknown>>>({
      method: "GET",
      path: `/customers/id/${encodeURIComponent(customerId)}/cards`,
    });
  }

  // ---------- charges (MONEY — idempotent by externalId, NEVER retried here) ----------
  createCharge(customerId: string, pin: string, input: { externalId: string; amountCents: number; cardId: string }) {
    return this.request<Record<string, unknown>>({
      method: "POST",
      path: `/customers/id/${encodeURIComponent(customerId)}/charges`,
      customerPin: pin,
      body: {
        externalId: toPosExternalId(input.externalId),
        amount: Number(centsToPosAmount(input.amountCents)),
        cardId: input.cardId,
      },
      timeoutMs: 30_000,
    });
  }

  // ---------- products ----------
  listProducts(q: { take?: number; cursor?: string; lastMod?: string; includeInactive?: boolean }) {
    return this.request<Record<string, unknown>>({ method: "GET", path: "/products", query: { ...q, take: q.take ?? 100 } });
  }
  getProductByCode(code: string) {
    return this.request<Record<string, unknown>>({ method: "GET", path: `/products/code/${encodeURIComponent(code)}` });
  }

  // ---------- orders ----------
  createOrder(body: Record<string, unknown>, customerPin?: string) {
    return this.request<Record<string, unknown>>({ method: "POST", path: "/orders", body, customerPin, timeoutMs: 30_000 });
  }
  getOrderById(id: string) {
    return this.request<Record<string, unknown>>({ method: "GET", path: `/orders/id/${encodeURIComponent(id)}` });
  }
  getOrderByExternalId(externalOrderId: string) {
    return this.request<Record<string, unknown>>({
      method: "GET",
      path: `/orders/external/${encodeURIComponent(externalOrderId)}`,
    });
  }
}
