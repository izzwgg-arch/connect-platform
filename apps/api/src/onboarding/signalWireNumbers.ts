/**
 * SignalWire number search for the onboarding wizard (2026-08-30).
 *
 * The wizard's "Your number" step searches THIS module when the platform's
 * onboarding number provider is SignalWire. It reuses the proven bench client
 * (`../signalwire/signalWireClient.ts`) and the single platform credential row
 * — never a per-tenant credential (numbers live on the master Space, exactly
 * like the master VoIP.ms reseller account they replace).
 *
 * Design facts this module encodes (verified against SignalWire's docs
 * 2026-08-30 — see CLAUDE.md "SIGNALWIRE ONBOARDING"):
 *   • The API accepts `starts_with` / `contains` / `ends_with` — 3–7 DIGITS,
 *     mutually exclusive — plus `areacode`, `region` (state), `city` (only
 *     with region) and `number_type` ("local" | "toll-free").
 *   • Letters are NOT accepted by the API. The wizard promises "letters work
 *     everywhere" (approved mockups), so this module T9-translates them
 *     server-side; the wizard shows the same translation live client-side.
 *   • There is no spare-stock concept here — that was a VoIP.ms master-account
 *     idea. Every result is purchasable; `inStock` is always false.
 *
 * ⛔ Read-only. Nothing in this module may purchase, release or modify a
 * number — purchase happens ONLY after payment, in the provisioning stage.
 */
import {
  searchNumbers,
  type SwAvailableNumber,
  type SwNumberSearchInput,
} from "../signalwire/signalWireClient";
import { resolveSignalWireCredentials } from "../signalwire/signalWireCredentials";

/**
 * Which carrier the onboarding wizard searches and (after payment) buys from.
 * Read at CALL time so it is testable and flippable without a rebuild —
 * an env change still needs a container restart to be seen, but never a build.
 *
 * Default stays "voipms" until the SignalWire path is switched on deliberately
 * (Izzy's go-live call — gated on the attestation-A grant per the approved
 * mockups' decision #1). Every new-signup surface must ask THIS function, so
 * the flip is one place.
 */
export type OnboardingNumberProviderName = "voipms" | "signalwire";
export function onboardingNumberProvider(): OnboardingNumberProviderName {
  const raw = String(process.env.ONBOARDING_NUMBER_PROVIDER || "").trim().toLowerCase();
  return raw === "signalwire" ? "signalwire" : "voipms";
}

/**
 * Phone-keypad letters → digits ("LOOP" → "5667"); digits pass through,
 * everything else is dropped. THE one T9 implementation for onboarding —
 * the VoIP.ms vanity path and the SignalWire pattern search both use it,
 * and the wizard's live preview mirrors it.
 */
export function t9ToDigits(word: string): string {
  const keypad: Record<string, string> = {
    a: "2", b: "2", c: "2", d: "3", e: "3", f: "3", g: "4", h: "4", i: "4",
    j: "5", k: "5", l: "5", m: "6", n: "6", o: "6", p: "7", q: "7", r: "7", s: "7",
    t: "8", u: "8", v: "8", w: "9", x: "9", y: "9", z: "9",
  };
  return String(word || "")
    .toLowerCase()
    .split("")
    .map((c) => (/[0-9]/.test(c) ? c : keypad[c] || ""))
    .join("");
}

export type OnboardingSearchMode = "areacode" | "starts" | "contains" | "ends";

export type OnboardingNumberResult = {
  number: string; // formatted "(845) 219-5667"
  e164: string; // as the provider returns it (SignalWire: +1XXXXXXXXXX)
  location: string;
  sms: boolean;
  voice: boolean;
  mms?: boolean;
  fax?: boolean;
  inStock: boolean; // always false on SignalWire — no spare pool
  kind: "local" | "tollfree";
};

export type SignalWireOnboardingSearchInput = {
  /** Raw query as typed — may contain letters; T9-translated here. */
  query: string;
  mode?: OnboardingSearchMode;
  type: "local" | "tollfree";
  /** Two-letter state (local only). */
  region?: string;
  /** City (local only; the API requires region alongside it). */
  city?: string;
  limit?: number;
};

export function formatTenDigits(d: string): string {
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
}

/**
 * Turn the wizard's query into SignalWire search params.
 * Pure and exported so the tests can drive every branch without a credential.
 *
 * Rules (each one is a doc-verified API constraint, not a preference):
 *   • areacode mode (or a bare ≤3-digit query with no mode) → `areacode`.
 *   • starts/contains/ends → the matching pattern param, 3–7 digits. Under 3
 *     digits the API refuses, so we LEFT-PAD nothing and instead fall back to
 *     areacode when it looks like one, else refuse with `pattern_too_short`
 *     so the wizard can say so in plain words instead of a provider 422.
 *   • The three pattern params are mutually exclusive — mode picks exactly one.
 *   • region/city ride along only for local searches; city requires region.
 */
export function buildSignalWireSearch(
  input: SignalWireOnboardingSearchInput,
): { params: SwNumberSearchInput } | { refuse: "pattern_too_short" } {
  const digits = t9ToDigits(input.query).slice(0, 7);
  const local = input.type === "local";
  const params: SwNumberSearchInput = {
    numberType: local ? "local" : "toll-free",
    maxResults: Math.min(Math.max(input.limit ?? 12, 1), 100),
  };
  if (local && input.region) {
    params.region = input.region.trim().toUpperCase().slice(0, 2);
    if (input.city) params.city = input.city.trim().slice(0, 60);
  }

  const mode: OnboardingSearchMode | undefined =
    input.mode ?? (digits.length > 0 && digits.length <= 3 ? "areacode" : digits ? "contains" : undefined);

  if (!digits) return { params }; // browse: region/city (or plain toll-free) only

  if (mode === "areacode") {
    params.areaCode = digits.slice(0, 3);
    return { params };
  }
  if (digits.length < 3) return { refuse: "pattern_too_short" };
  if (mode === "starts") params.startsWith = digits;
  else if (mode === "ends") params.endsWith = digits;
  else params.contains = digits;
  return { params };
}

function mapResult(r: SwAvailableNumber, kind: "local" | "tollfree"): OnboardingNumberResult {
  const d = String(r.number || "").replace(/\D/g, "").replace(/^1/, "");
  const caps = r.capabilities || ({} as SwAvailableNumber["capabilities"]);
  return {
    number: formatTenDigits(d),
    e164: r.number,
    location: [r.city, r.region].filter(Boolean).join(", "),
    sms: caps.sms !== false,
    voice: caps.voice !== false,
    mms: caps.mms !== false,
    fax: caps.fax === true,
    inStock: false,
    kind,
  };
}

export type SignalWireOnboardingSearchOutcome =
  | { ok: true; numbers: OnboardingNumberResult[] }
  | { ok: false; reason: "unconfigured" | "pattern_too_short" | "search_failed" };

/**
 * The whole search: resolve the platform credential, build params, call
 * SignalWire, map to the wizard shape. Never throws — the route translates
 * each `reason` into the wizard's existing error contract
 * (`number_provider_unconfigured` / `number_search_failed` / plain-English
 * refusals), which the 2026-08-18 incident taught must never collapse into
 * an empty list.
 */
export async function searchSignalWireOnboardingNumbers(
  db: unknown,
  input: SignalWireOnboardingSearchInput,
  deps: {
    resolveCreds?: typeof resolveSignalWireCredentials;
    search?: typeof searchNumbers;
  } = {},
): Promise<SignalWireOnboardingSearchOutcome> {
  const resolveCreds = deps.resolveCreds ?? resolveSignalWireCredentials;
  const doSearch = deps.search ?? searchNumbers;

  const built = buildSignalWireSearch(input);
  if ("refuse" in built) return { ok: false, reason: built.refuse };

  const creds = await resolveCreds(db as never).catch(() => null);
  if (!creds) return { ok: false, reason: "unconfigured" };

  try {
    const rows = await doSearch(creds, built.params);
    const kind = input.type === "tollfree" ? "tollfree" : "local";
    return { ok: true, numbers: rows.map((r) => mapResult(r, kind)) };
  } catch {
    return { ok: false, reason: "search_failed" };
  }
}
