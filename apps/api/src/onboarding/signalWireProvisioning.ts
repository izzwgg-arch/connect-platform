/**
 * SignalWire number provisioning for onboarding (2026-08-30).
 *
 * The SignalWire sibling of `applyOnboardingNumber`'s VoIP.ms body — reached
 * ONLY by its dispatch (the submission's `answers.phone.provider` says which
 * carrier the number was picked from; the stamp is written at apply-number
 * time so a submission provisions on the carrier it searched, whatever the
 * platform default is by then).
 *
 * What runs here, and only after payment (every invocation site of
 * applyOnboardingNumber already gates on `row.paidAt`):
 *   1. PURCHASE the selected number on the master Space — idempotent: a retry
 *      first looks for the number already on the account (a purchase timeout
 *      is "I stopped listening", never "it did not happen" — VoIP.ms rotation
 *      lesson, 2026-08-05), and NEVER retries the POST itself.
 *   2. ROUTE it: voice → the shared `loopcom-pbx` SIP endpoint (the exact
 *      live-proven config of +12053513327: call_handler "relay_sip_endpoint" +
 *      call_sip_endpoint_id, read off the account 2026-08-30), messaging → the
 *      platform's inbound SMS webhook.
 *   3. E911: create the address (SignalWire auto-corrects to the
 *      emergency-database town — the Monsey → Spring Valley rule) and assign
 *      it to the number. Recorded in answers.provisioning.e911 in the SAME
 *      shape the VoIP.ms path writes, so the customer's "E911 is set" email
 *      and the admin timeline work unchanged.
 *   4. PORT sign-ups: buy a temporary number in the ported number's area code
 *      and record the port package as `portFiling.status =
 *      "awaiting_manual_filing"` — SignalWire has NO porting API (dashboard +
 *      signed LOA only, verified 2026-08-30), so filing is an admin
 *      Port-queue task and NOTHING here talks to a carrier about the port.
 *
 * ⛔ There is no subaccount, no per-DID SMS enable and no spare pool here —
 * all three are VoIP.ms concepts. Texting on a SignalWire number activates
 * when its 10DLC campaign is approved, never by a number-level switch.
 */
import { db } from "@connect/db";
import {
  listNumbers,
  purchaseNumber,
  searchNumbers,
  updateNumberHandlers,
  createE911Address,
  assignE911Address,
  SignalWireError,
  type SwOwnedNumber,
} from "../signalwire/signalWireClient";
import type { StoredSignalWireCredentials } from "../signalwire/signalWireCredentials";
import { resolveSignalWireCredentials } from "../signalwire/signalWireCredentials";
import { inboundSmsWebhookUrl, resolvePublicApiBase } from "../signalwire/signalWireRoutes";
import { buildE911Address } from "./e911Address";
import {
  onboardingTenDigits as tenDigits,
  logOnboardingEvent as logEvent,
  mergeOnboardingProvisioningState as mergeProvisioningState,
  type ProvisionResult,
} from "./voipMsProvisioning";

/**
 * Live gate for SignalWire purchases/writes — the sibling of
 * VOIPMS_AUTO_PROVISION. Default OFF: everything runs as a dry-run that
 * narrates what it would do on the sign-up timeline, exactly like the VoIP.ms
 * path before its gate was armed. Read at call time so tests can flip it.
 */
export function signalWireAutoProvisionEnabled(): boolean {
  const raw = String(process.env.SIGNALWIRE_AUTO_PROVISION || "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true" || raw === "yes";
}

type SwDeps = {
  resolveCreds: typeof resolveSignalWireCredentials;
  listNumbers: typeof listNumbers;
  purchaseNumber: typeof purchaseNumber;
  searchNumbers: typeof searchNumbers;
  updateNumberHandlers: typeof updateNumberHandlers;
  createE911Address: typeof createE911Address;
  assignE911Address: typeof assignE911Address;
};

const realDeps: SwDeps = {
  resolveCreds: resolveSignalWireCredentials,
  listNumbers,
  purchaseNumber,
  searchNumbers,
  updateNumberHandlers,
  createE911Address,
  assignE911Address,
};

function toE164(tenDigit: string): string {
  return `+1${tenDigit}`;
}

/**
 * The SIP endpoint every SignalWire number's voice routes to.
 * Resolution order:
 *   1. SIGNALWIRE_PBX_SIP_ENDPOINT_ID env (explicit pin),
 *   2. copied off ANY number already routed relay_sip_endpoint on the account
 *      (the +12053513327 anchor — self-discovering, survives id changes).
 * Refuses (null) rather than guessing: a number routed to a wrong endpoint is
 * a customer whose calls go somewhere else.
 */
export async function resolvePbxSipEndpointId(
  creds: StoredSignalWireCredentials,
  deps: Pick<SwDeps, "listNumbers">,
  owned?: SwOwnedNumber[],
): Promise<string | null> {
  const pinned = String(process.env.SIGNALWIRE_PBX_SIP_ENDPOINT_ID || "").trim();
  if (pinned) return pinned;
  const numbers = owned ?? (await deps.listNumbers(creds).catch(() => []));
  for (const n of numbers) {
    const raw = (n.raw ?? {}) as Record<string, unknown>;
    if (String(raw.call_handler || "") === "relay_sip_endpoint" && raw.call_sip_endpoint_id) {
      return String(raw.call_sip_endpoint_id);
    }
  }
  return null;
}

/** Split a contact name for SignalWire's first/last E911 fields. */
function e911NameParts(row: any): { first: string; last: string } {
  const contact = String(row?.answers?.contact?.name || "").trim();
  if (contact.includes(" ")) {
    const i = contact.lastIndexOf(" ");
    return { first: contact.slice(0, i).trim(), last: contact.slice(i + 1).trim() };
  }
  const company = String(row?.companyName || row?.answers?.company?.name || contact || "Office").trim();
  return { first: contact || company, last: "Office" };
}

async function applyE911SignalWire(
  creds: StoredSignalWireCredentials,
  deps: SwDeps,
  row: any,
  did: string,
  numberId: string,
  live: boolean,
): Promise<void> {
  const submissionId = row.id;
  const build = buildE911Address(row);
  if (!build.ok) {
    await logEvent(submissionId, `911 for ${did} skipped — the address is incomplete (missing ${build.missing.join(", ")}). Needs a person.`);
    await mergeProvisioningState(row, {
      e911: { did, status: "address_incomplete", detail: build.missing.join(","), needsAttention: true, at: new Date().toISOString(), address: null, emailedAt: null, provider: "signalwire" },
    });
    return;
  }
  const a = build.address;
  if (!live) {
    await logEvent(submissionId, `[dry-run] Register 911 for ${did} at ${a.streetNumber} ${a.streetName}, ${a.city} ${a.state} ${a.zip}.`);
    return;
  }
  const names = e911NameParts(row);
  try {
    const created = await deps.createE911Address(creds, {
      label: String(row.companyName || a.fullName || did).slice(0, 32),
      country: "US",
      firstName: names.first,
      lastName: names.last,
      streetNumber: a.streetNumber,
      streetName: a.streetName,
      city: a.city,
      state: a.state,
      postalCode: a.zip,
      addressType: a.addressType || undefined,
      addressNumber: a.addressNumber || undefined,
      autoCorrect: true,
    });
    await deps.assignE911Address(creds, numberId, created.id);
    // The address AS REGISTERED — SignalWire's create answers with the
    // (possibly auto-corrected) stored form in `raw`; that is what a
    // dispatcher will be handed, so that is what the customer is told.
    const rawAddr = (created.raw ?? {}) as Record<string, unknown>;
    const registered = {
      fullName: a.fullName,
      streetNumber: String(rawAddr.street_number ?? a.streetNumber),
      streetName: String(rawAddr.street_name ?? a.streetName),
      city: String(rawAddr.city ?? a.city),
      state: String(rawAddr.state ?? a.state),
      zip: String(rawAddr.postal_code ?? a.zip),
      country: "US",
    };
    const corrected =
      registered.city.toUpperCase() !== a.city.toUpperCase() || registered.streetName.toUpperCase() !== a.streetName.toUpperCase()
        ? { city: registered.city }
        : null;
    const prior = (row?.answers?.provisioning?.e911 || {}) as any;
    await mergeProvisioningState(row, {
      e911: {
        did,
        status: "provisioned",
        detail: "signalwire",
        corrected,
        needsAttention: false,
        at: new Date().toISOString(),
        address: registered,
        emailedAt: prior.emailedAt || null,
        provider: "signalwire",
      },
    });
    await logEvent(submissionId, `911 registered on ${did} at ${registered.streetNumber} ${registered.streetName}, ${registered.city} ${registered.state} ${registered.zip}.`);
  } catch (e: any) {
    // ⛔ NEVER registered on trust, never fatal to a paid sign-up: the number
    // works, 911 does not — said in plain words on the timeline for a person.
    const detail = e instanceof SignalWireError ? `${e.code}: ${String(e.detail ? JSON.stringify(e.detail) : e.userMessage).slice(0, 200)}` : String(e?.message || e).slice(0, 200);
    await logEvent(submissionId, `⛔ 911 registration for ${did} FAILED (${detail}) — the number works, 911 does not. Needs a person.`);
    await mergeProvisioningState(row, {
      e911: { did, status: "failed", detail, needsAttention: true, at: new Date().toISOString(), address: null, emailedAt: null, provider: "signalwire" },
    });
  }
}

/**
 * Buy (or adopt) one number and wire its voice + messaging handlers.
 * Returns the owned-number record. Idempotent by construction:
 *   already on the account → adopt; purchase timeout → re-list before failing.
 */
async function ensureNumberOnAccount(
  creds: StoredSignalWireCredentials,
  deps: SwDeps,
  submissionId: string,
  e164: string,
): Promise<SwOwnedNumber> {
  const owned = await deps.listNumbers(creds).catch(() => []);
  const digitsOf = (v: string) => String(v).replace(/\D/g, "").replace(/^1/, "");
  const existing = owned.find((n) => digitsOf(n.number) === digitsOf(e164));
  if (existing) {
    await logEvent(submissionId, `Number ${e164} is already on the SignalWire account — adopting it (an earlier run bought it).`);
    return existing;
  }
  try {
    return await deps.purchaseNumber(creds, e164);
  } catch (e: any) {
    if (e instanceof SignalWireError && (e.code === "timeout" || e.code === "network")) {
      // "I stopped listening" ≠ "it did not happen" — reconcile before failing.
      const after = await deps.listNumbers(creds).catch(() => []);
      const landed = after.find((n) => digitsOf(n.number) === digitsOf(e164));
      if (landed) {
        await logEvent(submissionId, `Purchase of ${e164} timed out but LANDED — adopting it.`);
        return landed;
      }
    }
    throw e;
  }
}

async function routeNumber(
  creds: StoredSignalWireCredentials,
  deps: SwDeps,
  submissionId: string,
  owned: SwOwnedNumber,
  label: string,
): Promise<void> {
  const endpointId = await resolvePbxSipEndpointId(creds, deps);
  if (!endpointId) {
    // Refuse loudly rather than leave a bought number routed nowhere with no
    // trace — a number that does not ring is worse than a failed build.
    throw new Error("signalwire_pbx_endpoint_not_found");
  }
  await deps.updateNumberHandlers(creds, owned.id, {
    name: label.slice(0, 80),
    callHandler: "relay_sip_endpoint",
    callSipEndpointId: endpointId,
    messageHandler: "laml_webhooks",
    messageRequestUrl: inboundSmsWebhookUrl(resolvePublicApiBase()),
  });
  await logEvent(submissionId, `Number ${owned.number} routed — calls to the phone system, texts to the Loopcom inbox.`);
}

/** Pick + buy a temporary number for a porting sign-up (same area code first). */
async function ensureTemporarySignalWireDid(
  creds: StoredSignalWireCredentials,
  deps: SwDeps,
  row: any,
  portedDid: string,
): Promise<SwOwnedNumber> {
  const submissionId = row.id;
  const priorTemp = tenDigits(row?.answers?.provisioning?.temporaryDid);
  if (priorTemp.length === 10) {
    const owned = await deps.listNumbers(creds).catch(() => []);
    const found = owned.find((n) => String(n.number).replace(/\D/g, "").endsWith(priorTemp));
    if (found) {
      await logEvent(submissionId, `Reusing temporary number ${found.number} from the earlier run.`);
      return found;
    }
  }
  const areaCode = portedDid.slice(0, 3) || "845";
  let candidates = await deps.searchNumbers(creds, { numberType: "local", areaCode, maxResults: 5 }).catch(() => []);
  if (!candidates.length) {
    candidates = await deps.searchNumbers(creds, { numberType: "local", areaCode: "845", maxResults: 5 }).catch(() => []);
  }
  if (!candidates.length) throw new Error("no_temporary_number_available");
  const bought = await ensureNumberOnAccount(creds, deps, submissionId, candidates[0].number);
  await mergeProvisioningState(row, { temporaryDid: tenDigits(bought.number) });
  return bought;
}

/**
 * The SignalWire body of applyOnboardingNumber. The caller (its VoIP.ms
 * sibling) has ALREADY handled: row load, ready/provisioning gates, and
 * setting numberStatus="provisioning" — this picks up from there and owns the
 * terminal status writes, mirroring the VoIP.ms body exactly.
 */
export async function applySignalWireOnboardingNumber(
  submissionId: string,
  injectedDeps?: Partial<SwDeps>,
): Promise<ProvisionResult> {
  const deps: SwDeps = { ...realDeps, ...(injectedDeps || {}) };
  const live = signalWireAutoProvisionEnabled();

  const row = await (db as any).onboardingSubmission.findUnique({ where: { id: submissionId } });
  if (!row) return { ok: false, live, detail: "submission_not_found" };

  const creds = await deps.resolveCreds(db as never).catch(() => null);
  if (!creds) {
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "failed", setupError: "provider_unconfigured" } });
    await logEvent(submissionId, "SignalWire provisioning skipped — platform credentials not configured.");
    return { ok: false, live, detail: "provider_unconfigured" };
  }

  const answers: any = row.answers || {};
  const choice = String(row.phoneNumberChoice || answers?.phone?.choice || "new");
  const label = String(row.companyName || answers?.company?.name || "Loopcom customer").trim();

  try {
    let did = "";
    let temporary = false;

    if (choice === "port") {
      // Temporary number first; the port itself is a MANUAL dashboard filing
      // (SignalWire has no porting API) — record the package for the admin
      // Port queue and never pretend a carrier was contacted.
      temporary = true;
      const portedDid = tenDigits(answers?.phone?.details?.numbers);
      if (live) {
        const temp = await ensureTemporarySignalWireDid(creds, deps, row, portedDid);
        did = tenDigits(temp.number);
        await routeNumber(creds, deps, submissionId, temp, `${label} (temporary)`);
        await applyE911SignalWire(creds, deps, row, did, temp.id, live);
      } else {
        did = portedDid || "8450000000";
        await logEvent(submissionId, `[dry-run] Buy a temporary SignalWire number in area code ${portedDid.slice(0, 3) || "845"}, route it, register 911.`);
      }
      const prior = (row?.answers?.provisioning?.portFiling || {}) as any;
      await mergeProvisioningState(row, {
        portFiling: {
          provider: "signalwire",
          status: prior.status && prior.status !== "awaiting_manual_filing" ? prior.status : "awaiting_manual_filing",
          portedDid,
          requestedAt: prior.requestedAt || new Date().toISOString(),
        },
      });
      await logEvent(submissionId, `Port of ${portedDid || "the customer's number"} recorded for filing at SignalWire (dashboard + signed LOA — no carrier API). It is in the admin Port queue.`);
    } else {
      did = tenDigits(answers?.phone?.selectedNumber);
      if (did.length !== 10) throw new Error("no_number_selected");
      if (live) {
        const owned = await ensureNumberOnAccount(creds, deps, submissionId, toE164(did));
        await routeNumber(creds, deps, submissionId, owned, label);
        await applyE911SignalWire(creds, deps, row, did, owned.id, live);
      } else {
        await logEvent(submissionId, `[dry-run] Buy ${toE164(did)} on SignalWire, route calls to the phone system + texts to the inbox, register 911.`);
      }
    }

    await (db as any).onboardingSubmission.update({
      where: { id: submissionId },
      data: {
        numberStatus: live ? "ready" : "ready_dryrun",
        provisionedDid: did || null,
        didIsTemporary: temporary,
        setupError: null,
      },
    });
    await logEvent(submissionId, `${live ? "" : "[dry-run] "}Number stage ready — ${did}${temporary ? " (temporary until the port is filed and completes)" : ""} on SignalWire.`);
    return { ok: true, live, detail: choice === "port" ? "port_awaiting_manual_filing_temp_assigned" : "number_ready" };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "failed", setupError: msg } });
    await logEvent(submissionId, `SignalWire provisioning error: ${msg}`);
    return { ok: false, live, detail: "error" };
  }
}
