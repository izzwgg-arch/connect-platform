/**
 * Telnyx number search for the onboarding wizard (2026-09-16, Izzy: "switch
 * the onboarding wizard to Telnyx. It's going to be Telnyx for now").
 *
 * The Telnyx sibling of `signalWireNumbers.ts`'s search, answering the SAME
 * wizard contract (`OnboardingNumberResult`), so the wizard draws the same
 * modern search surface (mode chips, letters, state/city, capability chips, no
 * "Ready now" spare badge — there is no spare pool on Telnyx either).
 *
 * Differences from SignalWire, each verified live 2026-09-16:
 *   • Telnyx accepts starts/contains/ends TOGETHER with an area code, but the
 *     wizard sends one mode at a time, so the mapping stays one-pattern.
 *   • A city that is not an exact rate-center name answers 400/10031. The
 *     client turns 10031 into [], and this module retries WITHOUT the town
 *     only when an area code/pattern still narrows the search (aliases map
 *     known non-rate-center towns first, e.g. Monsey → SPRING VALLEY).
 *
 * ⛔ Read-only. Purchase happens only after payment (telnyxProvisioning.ts).
 */
import { resolveTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { searchAvailable, type TxAvailable, type TxSearchInput } from "../telnyx/telnyxOnboardingClient";
import {
  formatTenDigits,
  t9ToDigits,
  type OnboardingNumberResult,
  type SignalWireOnboardingSearchInput,
} from "./signalWireNumbers";

export type TelnyxOnboardingSearchInput = SignalWireOnboardingSearchInput;

/**
 * Towns customers type that are NOT Telnyx rate-center names, → the rate center
 * that actually carries their numbers. Each entry verified live 2026-09-16
 * ("MONSEY" answers 10031 even with best_effort; "SPRING VALLEY" returns 845s).
 */
export const LOCALITY_ALIASES: Record<string, string> = {
  "NY:MONSEY": "SPRING VALLEY",
};

// ── Throttle, retry, cache ───────────────────────────────────────────────────
// Proven 2026-09-16 by the stress test: a burst of ~20 parallel searches gets
// 429 (code 10011) on the extras, and the wizard showed "search failed" for
// them. Search is READ-ONLY, so a bounded wait-and-retry is safe; a small
// concurrency cap keeps a busy morning under the limit; identical queries in
// the same minute (the auto-search on step entry, back/forward) hit a cache.
const MAX_CONCURRENT = Number(process.env.TELNYX_SEARCH_CONCURRENCY || 4);
let active = 0;
const waiters: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; rows: TxAvailable[] }>();
export function clearTelnyxSearchCache(): void {
  cache.clear();
}
async function throttledSearch(
  doSearch: typeof searchAvailable,
  creds: any,
  params: TxSearchInput,
  sleep: (ms: number) => Promise<void>,
): Promise<TxAvailable[]> {
  const key = JSON.stringify(params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  for (let attempt = 1; ; attempt++) {
    try {
      const rows = await withSlot(() => doSearch(creds, params));
      cache.set(key, { at: Date.now(), rows });
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      return rows;
    } catch (e: any) {
      if (e?.code === "rate_limited" && attempt < 4) {
        await sleep(400 * attempt + Math.floor(Math.random() * 300));
        continue;
      }
      throw e;
    }
  }
}

/** Pure — the tests drive every branch. Same refusal rules as the SignalWire search. */
export function buildTelnyxSearch(
  input: TelnyxOnboardingSearchInput,
): { params: TxSearchInput } | { refuse: "pattern_too_short" } {
  const digits = t9ToDigits(input.query).slice(0, 7);
  const local = input.type === "local";
  const params: TxSearchInput = {
    numberType: local ? "local" : "toll_free",
    limit: Math.min(Math.max(input.limit ?? 12, 1), 50),
    features: local ? ["voice", "sms"] : ["voice"],
  };
  if (local && input.region) {
    params.state = input.region.trim().toUpperCase().slice(0, 2);
    if (input.city) {
      const typed = input.city.trim().toUpperCase().slice(0, 60);
      params.locality = LOCALITY_ALIASES[`${params.state}:${typed}`] ?? typed;
    }
  }
  const mode = input.mode ?? (digits.length > 0 && digits.length <= 3 ? "areacode" : digits ? "contains" : undefined);
  if (!digits) return { params };
  if (mode === "areacode") {
    if (digits.length < 3) return { refuse: "pattern_too_short" };
    params.areaCode = digits.slice(0, 3);
    return { params };
  }
  if (digits.length < 3) return { refuse: "pattern_too_short" };
  if (mode === "starts") params.startsWith = digits;
  else if (mode === "ends") params.endsWith = digits;
  else params.contains = digits;
  return { params };
}

function mapResult(r: TxAvailable, kind: "local" | "tollfree"): OnboardingNumberResult {
  const d = r.phoneNumber.replace(/\D/g, "").replace(/^1/, "");
  // Telnyx sometimes returns "COMPTON:COMPTON DA" (rate center:sub-area) — show the town only.
  const title = (s: string | null) => (s ? s.split(":")[0].trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "");
  const has = (f: string) => r.features.includes(f);
  return {
    number: formatTenDigits(d),
    e164: r.phoneNumber,
    location: [title(r.locality), r.state].filter(Boolean).join(", "),
    sms: has("sms"),
    voice: has("voice"),
    mms: has("mms"),
    fax: has("fax"),
    inStock: false,
    kind,
  };
}

export type TelnyxOnboardingSearchOutcome =
  | { ok: true; numbers: OnboardingNumberResult[] }
  | { ok: false; reason: "unconfigured" | "pattern_too_short" | "search_failed" };

/** Never throws. Provider failure and "nothing matched" stay DISTINCT outcomes. */
export async function searchTelnyxOnboardingNumbers(
  db: unknown,
  input: TelnyxOnboardingSearchInput,
  deps: { resolveCreds?: typeof resolveTelnyxCredentials; search?: typeof searchAvailable; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TelnyxOnboardingSearchOutcome> {
  const resolveCreds = deps.resolveCreds ?? resolveTelnyxCredentials;
  const doSearch = deps.search ?? searchAvailable;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const built = buildTelnyxSearch(input);
  if ("refuse" in built) return { ok: false, reason: built.refuse };
  const creds = await resolveCreds(db as never).catch(() => null);
  if (!creds) return { ok: false, reason: "unconfigured" };
  const kind = input.type === "tollfree" ? "tollfree" : "local";
  try {
    let rows = await throttledSearch(doSearch, creds, built.params, sleep);
    // A town with no match falls back to the rest of the search ONLY when
    // something else still narrows it (an area code or a digit pattern). A
    // bare state+town fallback showed Niagara Falls for "Monsey" — every
    // result carried its real town, but it was useless; "none found in that
    // town" is the honest answer there.
    const narrowed = !!(built.params.areaCode || built.params.startsWith || built.params.contains || built.params.endsWith);
    if (!rows.length && built.params.locality && narrowed) {
      const { locality: _dropped, ...withoutCity } = built.params;
      rows = await throttledSearch(doSearch, creds, withoutCity, sleep);
    }
    return { ok: true, numbers: rows.map((r) => mapResult(r, kind)) };
  } catch {
    return { ok: false, reason: "search_failed" };
  }
}
