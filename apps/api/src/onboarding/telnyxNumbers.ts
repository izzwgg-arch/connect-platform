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
 *     client turns 10031 into [], and this module then retries WITHOUT the
 *     city (same state) — every result still carries its real town, so the
 *     customer sees exactly where each number is, never a false promise.
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
    if (input.city) params.locality = input.city.trim().toUpperCase().slice(0, 60);
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
  const title = (s: string | null) => (s ? s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : "");
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
  deps: { resolveCreds?: typeof resolveTelnyxCredentials; search?: typeof searchAvailable } = {},
): Promise<TelnyxOnboardingSearchOutcome> {
  const resolveCreds = deps.resolveCreds ?? resolveTelnyxCredentials;
  const doSearch = deps.search ?? searchAvailable;
  const built = buildTelnyxSearch(input);
  if ("refuse" in built) return { ok: false, reason: built.refuse };
  const creds = await resolveCreds(db as never).catch(() => null);
  if (!creds) return { ok: false, reason: "unconfigured" };
  const kind = input.type === "tollfree" ? "tollfree" : "local";
  try {
    let rows = await doSearch(creds, built.params);
    if (!rows.length && built.params.locality) {
      const { locality: _dropped, ...withoutCity } = built.params;
      rows = await doSearch(creds, withoutCity);
    }
    return { ok: true, numbers: rows.map((r) => mapResult(r, kind)) };
  } catch {
    return { ok: false, reason: "search_failed" };
  }
}
