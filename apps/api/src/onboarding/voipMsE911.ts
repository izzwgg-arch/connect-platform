/**
 * Registering a sign-up's 911 address with VoIP.ms.
 *
 * Izzy, 2026-08-17: "During onboarding, use the customer's address as e911
 * and activate e911 in voip.ms on every future signup."
 *
 * The address itself comes from e911Address.ts (pure, tested). This file is
 * only the provider conversation, and it is deliberately thin so the same
 * three steps run for a brand-new number and for a ported one:
 *
 *   1. e911Info     — is this DID already registered? (never register twice)
 *   2. e911Validate — the address as typed, then ONCE MORE with VoIP.ms's own
 *                     corrections applied (see the alternatives note below)
 *   3. e911Provision — only ever with an address that just validated
 *
 * ⛔ NEVER PROVISION AN ADDRESS THAT DID NOT VALIDATE. A registration is
 * billable and, far worse, a wrong one sends an ambulance to the wrong house.
 * A sign-up whose address will not validate is reported as needing a human,
 * which is the honest outcome — not a guessed street.
 *
 * ⛔ AND NEVER LET THIS FAIL THE SIGN-UP. The customer has already paid and
 * their phones must come up. Every path returns a verdict; nothing throws out
 * of `ensureE911ForDid`.
 *
 * ⛔ THE CORRECTION STEP IS NOT A NICETY — IT IS WHAT MAKES THIS WORK AT ALL
 * FOR CONNECT'S CUSTOMERS. The 911 database uses the municipality, not the
 * postal town, and Connect sells into exactly the places where those differ:
 * proven live 2026-08-17, "30 Robert Pitt Dr, MONSEY NY 10952" is refused and
 * comes back with `alternatives: {city: ["SPRING VALLEY"]}`. Without applying
 * that, most Monsey sign-ups would fail. (New York City is the same story:
 * "350 5th Ave, NEW YORK 10118" → "5 AVE", "MANHATTAN", "10001".)
 */

import type { E911Address } from "./e911Address";
import { E911_ADDRESS_TYPES, buildE911Address } from "./e911Address";

export type { E911Address };

/** Just enough of voipMsProvisioning's client to be injectable in tests. */
export type VmsCreds = { username: string; password: string; apiBaseUrl?: string };
export type VmsCall = (
  creds: VmsCreds,
  method: string,
  params?: Record<string, string>,
  timeoutMs?: number,
) => Promise<any>;

export type E911Deps = {
  vms: VmsCall;
  log: (message: string) => Promise<void> | void;
};

export type E911Status =
  | "provisioned"        // registered with VoIP.ms just now
  | "already_registered" // this DID already had a 911 address
  | "dry_run"            // VOIPMS_AUTO_PROVISION is off
  | "address_incomplete" // the sign-up never gave us enough to register
  | "address_invalid"    // VoIP.ms refuses the address and offers no correction
  | "failed";            // the provider errored

export type E911Result = {
  status: E911Status;
  detail: string;
  /** The address as REGISTERED — i.e. after any correction VoIP.ms asked for. */
  address?: E911Address;
  /** Fields VoIP.ms corrected, so the timeline can say what changed. */
  corrected?: string[];
  /** True for the verdicts a human has to act on. */
  needsAttention: boolean;
};

/**
 * The REST parameter set.
 *
 * ⛔ `zip_code`, NOT `zip` (the WSDL's name — it answers `missing_zip`), and
 * `email` is required despite being absent from the WSDL entirely. Proven
 * against the live API 2026-08-17; see e911Address.ts's header.
 */
export function e911Params(did: string, a: E911Address): Record<string, string> {
  return {
    did,
    full_name: a.fullName.slice(0, 60),
    street_number: a.streetNumber,
    street_name: a.streetName.slice(0, 60),
    // Only ever send a designator VoIP.ms publishes — a guess is dropped.
    address_type: (E911_ADDRESS_TYPES as readonly string[]).includes(a.addressType) ? a.addressType : "",
    address_number: a.addressNumber.slice(0, 20),
    city: a.city.slice(0, 60),
    state: a.state,
    country: a.country || "US",
    zip_code: a.zip,
    // ⛔ UPPERCASE "EN", AND e911Validate WILL NOT CATCH A WRONG VALUE HERE.
    // Proven the hard way on the first real registration (Matamim, 2026-08-17):
    // validate happily accepted `en` and then e911Provision refused it —
    // `no_provision`, "The value 'en' of element 'language' is not valid."
    // ⛔ It is NOT the account language vocabulary either: VoIP.ms's own
    // `getLanguages` lists en/es/fr lowercase and every subaccount we own reads
    // `en`, so copying that value is exactly the trap. The E911 field is
    // validated by the upstream emergency provider against its own list, and
    // `EN` is what it takes. "English" fails too (echoed back as 'En').
    language: "EN",
    other_info: a.otherInfo.slice(0, 100),
    email: a.email,
  };
}

/**
 * Apply the corrections VoIP.ms hands back on a near-miss.
 *
 * The response shape is `{alternatives: {city: ["SPRING VALLEY"], …}}` — one
 * array of candidates per field it disagrees with. We take the first of each,
 * which is the provider's own best match, and report what moved so a human
 * can see that the registered address is not verbatim what was typed.
 */
export function applyAlternatives(
  address: E911Address,
  alternatives: unknown,
): { next: E911Address; corrected: string[] } {
  const alt = (alternatives && typeof alternatives === "object" ? alternatives : {}) as Record<string, unknown>;
  const next: E911Address = { ...address };
  const corrected: string[] = [];

  const take = (key: string): string => {
    const v = alt[key];
    const first = Array.isArray(v) ? v[0] : v;
    return typeof first === "string" ? first.trim() : "";
  };

  const map: Array<[string, keyof E911Address, string]> = [
    ["street_name", "streetName", "street"],
    ["street_number", "streetNumber", "street number"],
    ["city", "city", "city"],
    ["state", "state", "state"],
    ["zip_code", "zip", "ZIP code"],
  ];
  for (const [apiKey, field, label] of map) {
    const value = take(apiKey);
    if (value && value.toLowerCase() !== String(next[field] || "").toLowerCase()) {
      (next as any)[field] = value;
      corrected.push(`${label} → ${value}`);
    }
  }
  return { next, corrected };
}

/** VoIP.ms's "this DID has no 911 address" answer, which arrives as an error. */
function isNotRegistered(err: unknown): boolean {
  return /e911_disable|e911_not|no_e911/i.test(String((err as any)?.message || err || ""));
}

/**
 * Is this DID already registered? `e911Info` answers status `e911_disable`
 * when it is not, and our `vms()` helper turns any non-success status into a
 * throw — so "not registered" arrives here as an exception, not a value.
 * A DIFFERENT error (an outage) must not be read as "not registered", or a
 * retry would re-register a DID that was already done.
 */
async function readExistingE911(deps: E911Deps, creds: VmsCreds, did: string): Promise<
  { registered: true; info: any } | { registered: false } | { unknown: true; detail: string }
> {
  try {
    const info = await deps.vms(creds, "e911Info", { did });
    return { registered: true, info };
  } catch (e: any) {
    if (isNotRegistered(e)) return { registered: false };
    return { unknown: true, detail: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * Register the sign-up's address on one DID. Idempotent and never throws.
 *
 * `live` mirrors the VOIPMS_AUTO_PROVISION gate that guards every other
 * purchase in onboarding: with it off nothing is registered and nothing is
 * billed, and the timeline says exactly what would have happened.
 */
export async function ensureE911ForDid(
  deps: E911Deps,
  args: { creds: VmsCreds; did: string; address: E911Address; live: boolean },
): Promise<E911Result> {
  const { creds, did, address, live } = args;

  if (!live) {
    await deps.log(
      `[dry-run] Register 911 address for ${did}: ${address.streetNumber} ${address.streetName}, ${address.city} ${address.state} ${address.zip}.`,
    );
    return { status: "dry_run", detail: "gate_off", address, needsAttention: false };
  }

  try {
    const existing = await readExistingE911(deps, creds, did);
    if ("registered" in existing && existing.registered) {
      await deps.log(`911 is already registered on ${did} — leaving it alone.`);
      return { status: "already_registered", detail: "already_registered", needsAttention: false };
    }
    if ("unknown" in existing) {
      // Could not tell. Registering blind risks a duplicate charge; not
      // registering risks no 911. Stop and say so — this needs eyes.
      await deps.log(`Could not check whether ${did} already has a 911 address: ${existing.detail}`);
      return { status: "failed", detail: existing.detail, needsAttention: true };
    }

    // Validate as typed; on a near-miss take VoIP.ms's own correction and
    // validate once more. One retry only — a second round of alternatives
    // means the provider is not converging and a person should look.
    let candidate = address;
    let corrected: string[] = [];
    let validation = await deps.vms(creds, "e911Validate", e911Params(did, candidate)).catch((e: any) => e);

    if (validation instanceof Error) {
      // `vms()` attaches VoIP.ms's whole answer to the error — the correction
      // list lives in the body of a FAILED response, so a plain message is
      // not enough to recover it.
      const alternatives = (validation as any)?.voipmsResponse?.alternatives;
      if (!alternatives) {
        const detail = String(validation.message || validation).slice(0, 200);
        await deps.log(`911 address was refused for ${did}: ${detail}`);
        return { status: "address_invalid", detail, address: candidate, needsAttention: true };
      }
      const applied = applyAlternatives(candidate, alternatives);
      if (!applied.corrected.length) {
        await deps.log(`911 address was refused for ${did} and no correction was offered.`);
        return { status: "address_invalid", detail: "invalid_address", address: candidate, needsAttention: true };
      }
      candidate = applied.next;
      corrected = applied.corrected;
      validation = await deps.vms(creds, "e911Validate", e911Params(did, candidate)).catch((e: any) => e);
      if (validation instanceof Error) {
        const detail = String(validation.message || validation).slice(0, 200);
        await deps.log(`911 address was still refused for ${did} after applying the suggested correction: ${detail}`);
        return { status: "address_invalid", detail, address: candidate, needsAttention: true };
      }
    }

    await deps.vms(creds, "e911Provision", e911Params(did, candidate));
    const where = `${candidate.streetNumber} ${candidate.streetName}${candidate.addressType ? ` ${candidate.addressType} ${candidate.addressNumber}` : ""}, ${candidate.city} ${candidate.state} ${candidate.zip}`;
    await deps.log(
      corrected.length
        ? `911 registered on ${did} at ${where} (the emergency database corrected the ${corrected.join(", ")}).`
        : `911 registered on ${did} at ${where}.`,
    );
    return {
      status: "provisioned",
      detail: "provisioned",
      address: candidate,
      corrected: corrected.length ? corrected : undefined,
      // A corrected address is still worth a glance, but it is not a failure.
      needsAttention: false,
    };
  } catch (e: any) {
    const detail = String(e?.message || e).slice(0, 200);
    await deps.log(`911 registration failed for ${did}: ${detail}`);
    return { status: "failed", detail, needsAttention: true };
  }
}

/**
 * Build the address from a submission and register it. The one entry point
 * both provisioning paths call, so a new number and a ported number can never
 * register 911 differently.
 */
export async function ensureE911ForSubmission(
  deps: E911Deps,
  args: { creds: VmsCreds; did: string; row: any; live: boolean },
): Promise<E911Result> {
  const built = buildE911Address(args.row);
  if (!built.ok) {
    // Loud, because the alternative is a phone that cannot call for help.
    await deps.log(
      `911 could NOT be registered for ${args.did} — the sign-up is missing: ${built.missing.join(", ")}. Someone has to add the address and register it by hand.`,
    );
    return {
      status: "address_incomplete",
      detail: `missing:${built.missing.join(",")}`,
      address: built.address,
      needsAttention: true,
    };
  }
  return await ensureE911ForDid(deps, { creds: args.creds, did: args.did, address: built.address, live: args.live });
}

/**
 * Point the customer's trunk at the DID we just registered, so a 911 call
 * that goes out with any other caller ID still carries a real address.
 *
 * ⛔ `setSubAccount` IS A FULL UPDATE — every unsent field reverts to its
 * default, which on a live trunk means silence. So this resends the account's
 * OWN current settings, read back from getSubAccounts moments earlier,
 * INCLUDING its own password (getSubAccounts returns it, verified live
 * 2026-08-17), and changes exactly one field. It then re-reads to prove the
 * value stuck. Best-effort throughout: the DID-level registration above is
 * what actually makes 911 work, this is the belt to its braces.
 */
export async function setSubaccountDefaultE911(
  deps: E911Deps,
  args: { creds: VmsCreds; subUsername: string; did: string },
): Promise<{ ok: boolean; detail: string }> {
  const { creds, subUsername, did } = args;
  try {
    const list = await deps.vms(creds, "getSubAccounts");
    const rows: any[] = Array.isArray(list?.accounts) ? list.accounts : [];
    const acct = rows.find((a) => String(a?.account || "") === subUsername);
    if (!acct) return { ok: false, detail: "subaccount_not_found" };
    if (String(acct.default_e911 || "") === did) return { ok: true, detail: "already_set" };
    if (!acct.password) {
      // Without the current password a full update would blank it and take
      // the customer's trunk down. Never worth it for a fallback setting.
      return { ok: false, detail: "password_unreadable" };
    }

    await deps.vms(creds, "setSubAccount", {
      id: String(acct.id),
      password: String(acct.password),
      auth_type: String(acct.auth_type || "1"),
      protocol: String(acct.protocol || "1"),
      device_type: String(acct.device_type || "1"),
      lock_international: String(acct.lock_international || "1"),
      international_route: String(acct.international_route || "1"),
      music_on_hold: String(acct.music_on_hold || "default"),
      allowed_codecs: String(acct.allowed_codecs || "ulaw;g729"),
      dtmf_mode: String(acct.dtmf_mode || "auto"),
      nat: String(acct.nat || "yes"),
      ...(acct.internal_extension ? { internal_extension: String(acct.internal_extension) } : {}),
      ...(acct.description ? { description: String(acct.description) } : {}),
      default_e911: did,
    }, 120_000);

    // Prove it, rather than trusting a success status — `default_e911` is not
    // in VoIP.ms's public REST docs and a silently-ignored field would look
    // identical to a successful write.
    const after = await deps.vms(creds, "getSubAccounts");
    const stuck = (Array.isArray(after?.accounts) ? after.accounts : [])
      .find((a: any) => String(a?.account || "") === subUsername);
    if (String(stuck?.default_e911 || "") === did) {
      await deps.log(`Trunk ${subUsername} now defaults to ${did} for 911.`);
      return { ok: true, detail: "set" };
    }
    return { ok: false, detail: "not_applied" };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message || e).slice(0, 160) };
  }
}
