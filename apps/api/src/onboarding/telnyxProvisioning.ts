/**
 * Telnyx number provisioning for onboarding (2026-09-16, Izzy: "switch the
 * onboarding wizard to Telnyx … make sure that it works end to end").
 *
 * The Telnyx sibling of `applySignalWireOnboardingNumber` — reached ONLY by
 * applyOnboardingNumber's dispatch on the submission's stamped
 * `answers.phone.provider === "telnyx"`. Every invocation site already gates on
 * `row.paidAt`, so nothing here runs before the customer paid.
 *
 *   1. PURCHASE the picked number with ONE number order, pre-assigned to the
 *      PBX's SIP connection (Loopcom-Primary-SIP — PBX trunk 183 registers to
 *      it) and the sign-ups messaging profile. The order id is stored BEFORE it
 *      is polled, so a crash between "ordered" and "active" resumes by reading
 *      that order — never by ordering again. A number already on the account
 *      is adopted.
 *   2. CONFIGURE: customer_reference = the tenant slug (one flat account,
 *      per-customer bookkeeping — handoff §5), outbound CNAM = the customer's
 *      own company name (free; never LOOPCOM on everyone).
 *   3. E911: a validated Telnyx address + enable_emergency on the number,
 *      recorded in answers.provisioning.e911 in the SAME shape the VoIP.ms and
 *      SignalWire paths write, so the "E911 is set" email and the admin
 *      timeline work unchanged. ⛔ "provisioned" only once Telnyx reports the
 *      number's emergency_status active — Telnyx activates asynchronously, and
 *      "we asked" is not "911 works". A pending activation is finished by the
 *      Telnyx sweep (telnyxPortWatchdog.ts).
 *   4. PORT sign-ups: a temporary number in the ported number's area code
 *      FIRST (the irreversible half goes last — the VoIP.ms retry lesson), then
 *      a REAL Telnyx porting order: filled, LOA + bill attached, SUBMITTED.
 *      Telnyx has the porting API SignalWire lacks. A filing Telnyx refuses
 *      never fails a paid build — it lands in the admin Port queue as
 *      `needs_attention` with Telnyx's own words.
 *
 * ⛔ Gate: TELNYX_AUTO_PROVISION (default OFF = dry-run narration), the
 * sibling of VOIPMS_AUTO_PROVISION / SIGNALWIRE_AUTO_PROVISION.
 */
import { db } from "@connect/db";
import { resolveTelnyxCredentials, type StoredTelnyxCredentials } from "../telnyx/telnyxCredentials";
import { listConnections } from "../telnyx/telnyxClient";
import {
  configureOwnedNumber,
  createAddress,
  createMessagingProfileWithWebhook,
  enableEmergency,
  findOwnedNumber,
  getNumberOrder,
  listMessagingProfilesRaw,
  placeNumberOrder,
  searchAvailable,
  setNumberCnam,
  telnyxErrorDetail,
} from "../telnyx/telnyxOnboardingClient";
import { TELNYX_INBOUND_SMS_PATH } from "../telnyx/telnyxWebhooks";
import { resolvePublicApiBase } from "../signalwire/signalWireRoutes";
import { buildE911Address } from "./e911Address";
import { ensureProvisioningIdentity } from "./provisioningIdentity";
import {
  onboardingTenDigits as tenDigits,
  logOnboardingEvent as logEvent,
  mergeOnboardingProvisioningState as mergeProvisioningState,
  type ProvisionResult,
} from "./voipMsProvisioning";

export function telnyxAutoProvisionEnabled(): boolean {
  const raw = String(process.env.TELNYX_AUTO_PROVISION || "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true" || raw === "yes";
}

/** The SIP connection PBX trunk 183 registers to. Matched by NAME, never a guessed id. */
export const TELNYX_PBX_CONNECTION_NAME = "Loopcom-Primary-SIP";
/** The messaging profile sign-up numbers join (its webhook is the chat ingest). */
export const TELNYX_SIGNUP_MESSAGING_PROFILE_NAME = "Loopcom Sign-ups";

export type TxDeps = {
  resolveCreds: typeof resolveTelnyxCredentials;
  listConnections: typeof listConnections;
  listMessagingProfiles: typeof listMessagingProfilesRaw;
  createMessagingProfile: typeof createMessagingProfileWithWebhook;
  findOwnedNumber: typeof findOwnedNumber;
  placeNumberOrder: typeof placeNumberOrder;
  getNumberOrder: typeof getNumberOrder;
  configureOwnedNumber: typeof configureOwnedNumber;
  setNumberCnam: typeof setNumberCnam;
  searchAvailable: typeof searchAvailable;
  createAddress: typeof createAddress;
  enableEmergency: typeof enableEmergency;
  fileTelnyxPort: (row: any, portedDid: string, ctx: { connectionId: string; messagingProfileId: string | null; customerReference: string }) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export function realTelnyxDeps(): TxDeps {
  return {
    resolveCreds: resolveTelnyxCredentials,
    listConnections,
    listMessagingProfiles: listMessagingProfilesRaw,
    createMessagingProfile: createMessagingProfileWithWebhook,
    findOwnedNumber,
    placeNumberOrder,
    getNumberOrder,
    configureOwnedNumber,
    setNumberCnam,
    searchAvailable,
    createAddress,
    enableEmergency,
    fileTelnyxPort: async (row, portedDid, ctx) => {
      const { fileTelnyxPortForSubmission } = await import("./telnyxPortFiling");
      await fileTelnyxPortForSubmission(row, portedDid, ctx);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/** Refuses (throws) rather than guessing — a number routed to the wrong place rings nobody. */
export async function resolveTelnyxPbxConnectionId(creds: StoredTelnyxCredentials, deps: Pick<TxDeps, "listConnections">): Promise<string> {
  const pinned = String(process.env.TELNYX_PBX_CONNECTION_ID || "").trim();
  if (pinned) return pinned;
  const conns = await deps.listConnections(creds);
  const hit = conns.find((c) => String(c.name || "").trim() === TELNYX_PBX_CONNECTION_NAME);
  if (!hit) throw new Error(`telnyx_pbx_connection_not_found (${TELNYX_PBX_CONNECTION_NAME})`);
  return hit.id;
}

/**
 * The messaging profile for sign-up numbers: env pin → by name → create it with
 * the chat-ingest webhook. Best-effort: a failure returns null and the number
 * still gets voice (texting is an add-on; a phone that rings beats a failed build).
 */
export async function resolveSignupMessagingProfileId(
  creds: StoredTelnyxCredentials,
  deps: Pick<TxDeps, "listMessagingProfiles" | "createMessagingProfile">,
  submissionId?: string,
): Promise<string | null> {
  const pinned = String(process.env.TELNYX_MESSAGING_PROFILE_ID || "").trim();
  if (pinned) return pinned;
  try {
    const profiles = await deps.listMessagingProfiles(creds);
    const hit = profiles.find((p) => p.name.trim() === TELNYX_SIGNUP_MESSAGING_PROFILE_NAME);
    if (hit) return hit.id;
    const webhook = `${resolvePublicApiBase()}${TELNYX_INBOUND_SMS_PATH}`;
    return await deps.createMessagingProfile(creds, TELNYX_SIGNUP_MESSAGING_PROFILE_NAME, webhook);
  } catch (e) {
    if (submissionId) await logEvent(submissionId, `Texting profile could not be prepared on Telnyx (${telnyxErrorDetail(e)}) — the number works for calls; texting needs a person.`);
    return null;
  }
}

const e164Of = (ten: string) => `+1${ten}`;

/**
 * Buy (or adopt) ONE number. The order is sent once; its id is persisted under
 * answers.provisioning.telnyxOrders[e164] before polling, so a retry after a
 * crash polls THAT order instead of placing a second one.
 */
export async function ensureTelnyxNumber(
  creds: StoredTelnyxCredentials,
  deps: TxDeps,
  row: any,
  e164: string,
  ctx: { connectionId: string; messagingProfileId: string | null; customerReference: string },
): Promise<{ id: string; phoneNumber: string }> {
  const submissionId = row.id;
  const owned = await deps.findOwnedNumber(creds, e164);
  if (owned) {
    await logEvent(submissionId, `Number ${e164} is already on the account — adopting it.`);
    return owned;
  }
  const orders: Record<string, string> = { ...((row?.answers?.provisioning?.telnyxOrders as Record<string, string>) || {}) };
  let orderId = orders[e164];
  if (!orderId) {
    try {
      const order = await deps.placeNumberOrder(creds, { e164, ...ctx });
      orderId = order.id;
    } catch (e: any) {
      // "I stopped listening" ≠ "it did not happen": re-read before failing.
      if (e?.code === "timeout" || e?.code === "network") {
        const landed = await deps.findOwnedNumber(creds, e164).catch(() => null);
        if (landed) {
          await logEvent(submissionId, `The order for ${e164} timed out but the number LANDED — adopting it.`);
          return landed;
        }
      }
      throw e;
    }
    if (!orderId) throw new Error("telnyx_number_order_returned_no_id");
    orders[e164] = orderId;
    await mergeProvisioningState(row, { telnyxOrders: orders });
    await logEvent(submissionId, `Ordered ${e164} (order ${orderId}).`);
  } else {
    await logEvent(submissionId, `Resuming the earlier order for ${e164} (order ${orderId}) — not ordering again.`);
  }

  // Poll the order, then the owned-number record (the id exists only after success).
  for (let i = 0; i < 20; i++) {
    const order = await deps.getNumberOrder(creds, orderId).catch(() => null);
    const status = String(order?.numberStatus || order?.status || "").toLowerCase();
    if (status === "failure" || status === "failed" || status === "cancelled") {
      // The order died — clear it so a retry may pick again, and say why.
      delete orders[e164];
      await mergeProvisioningState(row, { telnyxOrders: orders });
      throw new Error(`telnyx_number_order_failed (${e164}, order ${orderId})`);
    }
    if (status === "success") {
      const got = await deps.findOwnedNumber(creds, e164).catch(() => null);
      if (got) return got;
    }
    await deps.sleep(3000);
  }
  const late = await deps.findOwnedNumber(creds, e164).catch(() => null);
  if (late) return late;
  throw new Error(`telnyx_number_order_not_active_yet (${e164}, order ${orderId}) — a retry resumes this order`);
}

/** Split a contact name for Telnyx's first/last address fields. */
function nameParts(row: any): { first: string; last: string } {
  const contact = String(row?.answers?.contact?.name || [row?.contactFirstName, row?.contactLastName].filter(Boolean).join(" ") || "").trim();
  if (contact.includes(" ")) {
    const i = contact.lastIndexOf(" ");
    return { first: contact.slice(0, i).trim(), last: contact.slice(i + 1).trim() };
  }
  const company = String(row?.companyName || row?.answers?.company?.name || contact || "Office").trim();
  return { first: contact || company, last: "Office" };
}

/**
 * Register 911 for one owned number. Reuses an address created by an earlier
 * run (answers.provisioning.telnyxE911AddressId) — never a second address.
 */
export async function applyTelnyxE911(
  creds: StoredTelnyxCredentials,
  deps: TxDeps,
  row: any,
  did: string,
  numberId: string,
): Promise<void> {
  const submissionId = row.id;
  const build = buildE911Address(row);
  if (!build.ok) {
    await logEvent(submissionId, `911 for ${did} skipped — the address is incomplete (missing ${build.missing.join(", ")}). Needs a person.`);
    await mergeProvisioningState(row, {
      e911: { did, status: "address_incomplete", detail: build.missing.join(","), needsAttention: true, at: new Date().toISOString(), address: null, emailedAt: null, provider: "telnyx" },
    });
    return;
  }
  const a = build.address;
  const prior = (row?.answers?.provisioning?.e911 || {}) as any;
  try {
    let addressId = String(row?.answers?.provisioning?.telnyxE911AddressId || "");
    let registered = {
      fullName: a.fullName,
      streetNumber: a.streetNumber,
      streetName: a.streetName,
      addressType: a.addressType,
      addressNumber: a.addressNumber,
      city: a.city,
      state: a.state,
      zip: a.zip,
      country: "US",
      email: a.email,
      otherInfo: a.otherInfo,
    };
    if (!addressId) {
      const names = nameParts(row);
      const created = await deps.createAddress(creds, {
        firstName: names.first,
        lastName: names.last,
        businessName: String(row.companyName || a.fullName || "Office"),
        streetAddress: [a.streetNumber, a.streetName].filter(Boolean).join(" "),
        extendedAddress: [a.addressType, a.addressNumber].filter(Boolean).join(" ") || null,
        locality: a.city,
        administrativeArea: a.state,
        postalCode: a.zip.slice(0, 5),
        phoneNumber: e164Of(did),
        customerReference: String(row?.answers?.provisioning?.tenantSlug || submissionId),
      });
      addressId = created.id;
      if (!addressId) throw new Error("telnyx_address_create_returned_no_id");
      if (created.locality) registered = { ...registered, city: created.locality };
      await mergeProvisioningState(row, { telnyxE911AddressId: addressId });
    }
    const enabled = await deps.enableEmergency(creds, numberId, addressId);
    let status = String(enabled.status || "").toLowerCase();
    for (let i = 0; i < 10 && status !== "active"; i++) {
      await deps.sleep(3000);
      const now = await deps.findOwnedNumber(creds, e164Of(did)).catch(() => null);
      status = String(now?.emergencyStatus || status).toLowerCase();
    }
    const active = status === "active";
    await mergeProvisioningState(row, {
      e911: {
        did,
        status: active ? "provisioned" : "pending_activation",
        detail: `telnyx:${status || "unknown"}`,
        corrected: registered.city.toUpperCase() !== a.city.toUpperCase() ? { city: registered.city } : null,
        needsAttention: false,
        at: new Date().toISOString(),
        address: registered,
        emailedAt: prior.emailedAt || null,
        provider: "telnyx",
        telnyxNumberId: numberId,
        telnyxAddressId: addressId,
      },
    });
    await logEvent(
      submissionId,
      active
        ? `911 registered on ${did} at ${registered.streetNumber} ${registered.streetName}, ${registered.city} ${registered.state} ${registered.zip}.`
        : `911 requested for ${did} — Telnyx is still activating it (${status || "no status yet"}). The sweep confirms it; the customer is told only once it is active.`,
    );
  } catch (e) {
    // ⛔ Never registered on trust, never fatal to a paid sign-up.
    const detail = telnyxErrorDetail(e);
    await logEvent(submissionId, `⛔ 911 registration for ${did} FAILED (${detail}) — the number works, 911 does not. Needs a person.`);
    await mergeProvisioningState(row, {
      e911: { did, status: "failed", detail, needsAttention: true, at: new Date().toISOString(), address: null, emailedAt: null, provider: "telnyx" },
    });
  }
}

async function configureNumber(creds: StoredTelnyxCredentials, deps: TxDeps, row: any, n: { id: string; phoneNumber: string }, ctx: { connectionId: string; messagingProfileId: string | null; customerReference: string }, company: string): Promise<void> {
  await deps.configureOwnedNumber(creds, n.id, {
    connectionId: ctx.connectionId,
    messagingProfileId: ctx.messagingProfileId,
    customerReference: ctx.customerReference,
  });
  try {
    await deps.setNumberCnam(creds, n.id, company);
  } catch (e) {
    // Caller-name listing is cosmetic and takes 12-72h anyway — never fatal.
    await logEvent(row.id, `Caller name for ${n.phoneNumber} not listed (${telnyxErrorDetail(e)}).`);
  }
  await logEvent(row.id, `Number ${n.phoneNumber} routed — calls to the phone system${ctx.messagingProfileId ? ", texts to the Loopcom inbox" : ""}.`);
}

/** Temporary number for a port sign-up: reuse an earlier run's, else buy one in the same area code. */
async function ensureTemporaryTelnyxDid(creds: StoredTelnyxCredentials, deps: TxDeps, row: any, portedDid: string, ctx: { connectionId: string; messagingProfileId: string | null; customerReference: string }): Promise<{ id: string; phoneNumber: string }> {
  const priorTemp = tenDigits(row?.answers?.provisioning?.temporaryDid);
  if (priorTemp.length === 10) {
    const owned = await deps.findOwnedNumber(creds, e164Of(priorTemp)).catch(() => null);
    if (owned) {
      await logEvent(row.id, `Reusing temporary number ${owned.phoneNumber} from the earlier run.`);
      return owned;
    }
    // Chosen earlier but not owned yet — ensureTelnyxNumber resumes its order.
    return ensureTelnyxNumber(creds, deps, row, e164Of(priorTemp), ctx);
  }
  const areaCode = portedDid.slice(0, 3) || "845";
  let candidates = await deps.searchAvailable(creds, { numberType: "local", areaCode, limit: 5, features: ["voice", "sms"] }).catch(() => []);
  if (!candidates.length) candidates = await deps.searchAvailable(creds, { numberType: "local", areaCode: "845", limit: 5, features: ["voice", "sms"] }).catch(() => []);
  if (!candidates.length) throw new Error("no_temporary_number_available");
  const pick = tenDigits(candidates[0].phoneNumber);
  // Persist the pick BEFORE ordering, so a crash resumes this number.
  await mergeProvisioningState(row, { temporaryDid: pick });
  return ensureTelnyxNumber(creds, deps, row, e164Of(pick), ctx);
}

/**
 * The Telnyx body of applyOnboardingNumber. The caller already loaded the row,
 * passed the ready/in-flight gates and set numberStatus="provisioning"; this
 * owns the terminal status writes, mirroring its siblings exactly.
 */
export async function applyTelnyxOnboardingNumber(submissionId: string, injected?: Partial<TxDeps>): Promise<ProvisionResult> {
  const deps: TxDeps = { ...realTelnyxDeps(), ...(injected || {}) };
  const live = telnyxAutoProvisionEnabled();

  const row = await (db as any).onboardingSubmission.findUnique({ where: { id: submissionId }, include: { uploadedFiles: true } } as any);
  if (!row) return { ok: false, live, detail: "submission_not_found" };

  const creds = await deps.resolveCreds(db as never).catch(() => null);
  if (!creds) {
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "failed", setupError: "provider_unconfigured" } });
    await logEvent(submissionId, "Telnyx provisioning skipped — platform credentials not configured.");
    return { ok: false, live, detail: "provider_unconfigured" };
  }

  const answers: any = row.answers || {};
  const choice = String(row.phoneNumberChoice || answers?.phone?.choice || "new");
  const company = String(row.companyName || answers?.company?.name || "Loopcom customer").trim();

  try {
    const identity = await ensureProvisioningIdentity(row);
    const customerReference = `loopcom:${identity.tenantSlug}`.slice(0, 100);
    let did = "";
    let temporary = false;

    if (!live) {
      if (choice === "port") {
        temporary = true;
        const portedDid = tenDigits(answers?.phone?.details?.numbers);
        did = portedDid || "8450000000";
        await logEvent(submissionId, `[dry-run] Buy a temporary Telnyx number in area code ${portedDid.slice(0, 3) || "845"}, route it, register 911, then file + submit the Telnyx port of ${portedDid}.`);
      } else {
        did = tenDigits(answers?.phone?.selectedNumber);
        if (did.length !== 10) throw new Error("no_number_selected");
        await logEvent(submissionId, `[dry-run] Buy ${e164Of(did)} on Telnyx, route calls to the phone system + texts to the inbox, list the caller name, register 911.`);
      }
      await (db as any).onboardingSubmission.update({
        where: { id: submissionId },
        data: { numberStatus: "ready_dryrun", provisionedDid: did || null, didIsTemporary: temporary, setupError: null },
      });
      await logEvent(submissionId, `[dry-run] Number stage ready — ${did} on Telnyx.`);
      return { ok: true, live, detail: "number_ready" };
    }

    const connectionId = await resolveTelnyxPbxConnectionId(creds, deps);
    const messagingProfileId = await resolveSignupMessagingProfileId(creds, deps, submissionId);
    const ctx = { connectionId, messagingProfileId, customerReference };

    if (choice === "port") {
      temporary = true;
      const portedDid = tenDigits(answers?.phone?.details?.numbers);
      if (portedDid.length !== 10) throw new Error("port_number_missing");
      const temp = await ensureTemporaryTelnyxDid(creds, deps, row, portedDid, ctx);
      did = tenDigits(temp.phoneNumber);
      await mergeProvisioningState(row, { temporaryDid: did });
      await configureNumber(creds, deps, row, temp, ctx, company);
      await applyTelnyxE911(creds, deps, row, did, temp.id);
      // The irreversible half LAST. Its own failures are recorded for the Port
      // queue inside, never thrown into a paid build.
      try {
        await deps.fileTelnyxPort(row, portedDid, ctx);
      } catch (e) {
        await logEvent(submissionId, `⛔ The Telnyx port of ${portedDid} could not be filed (${telnyxErrorDetail(e)}) — it is in the admin Port queue for a person.`);
      }
    } else {
      did = tenDigits(answers?.phone?.selectedNumber);
      if (did.length !== 10) throw new Error("no_number_selected");
      const owned = await ensureTelnyxNumber(creds, deps, row, e164Of(did), ctx);
      await configureNumber(creds, deps, row, owned, ctx, company);
      await applyTelnyxE911(creds, deps, row, did, owned.id);
    }

    await mergeProvisioningState(row, { telnyx: { connectionId, messagingProfileId, customerReference } });
    await (db as any).onboardingSubmission.update({
      where: { id: submissionId },
      data: { numberStatus: "ready", provisionedDid: did || null, didIsTemporary: temporary, setupError: null },
    });
    await logEvent(submissionId, `Number stage ready — ${did}${temporary ? " (temporary until the port completes)" : ""} on Telnyx.`);
    return { ok: true, live, detail: choice === "port" ? "port_filed_temp_assigned" : "number_ready" };
  } catch (e) {
    const msg = telnyxErrorDetail(e);
    await (db as any).onboardingSubmission.update({ where: { id: submissionId }, data: { numberStatus: "failed", setupError: msg } });
    await logEvent(submissionId, `Telnyx provisioning error: ${msg}`);
    return { ok: false, live, detail: "error" };
  }
}
