/**
 * The makers' device clouds, driven from the EXISTING desk phone wizard.
 *
 * ⛔⛔ ONE WIZARD. These routes sit beside the wizard's own, receive the wizard's own
 * guards, and are held to its rules by the same source guard (deskPhoneRouteOrder.test.ts):
 * ownership resolved first on every run-scoped route, staff routes gated before they read
 * anything, no tenant ever taken from a request body.
 *
 * ⛔⛔ THE WIZARD NEVER ASKS WHAT BRAND THE CUSTOMER PICKED. Every route identifies the
 * device from its evidence, asks the registry for the provider that matches what was
 * DISCOVERED, and lets the provider and `capabilitiesFor` decide what is possible.
 *
 * ⛔ Nothing here marks a device working. A maker accepting a request is "accepted"; only
 * the phone system reporting the endpoint registered is online, and that is `advance`.
 * ⛔ RESET FIRST (Izzy, 2026-09-14: "reset every time you connect the phone"). Every phone
 * being connected is factory reset before it gets its settings — but only once it was
 * TICKED (the consent), only once per setup, never one registered to us or held by another
 * account, and the reset is the last thing sent in that request.
 * ⛔ No secret crosses these routes except the GDMS credential SAVE, which is staff-only,
 * write-only, and never echoed, logged or audited.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  cleanSerialNumber,
  decideReset,
  describeProvisioningStatus,
  formatMac,
  identifyDevice,
  identifyPhone,
  // The maker read off the sticker's own hardware address. Covers exactly the makers
  // we are approved for (grandstream | yealink | fanvil | poly); anything else comes
  // back "other"/"unknown" rather than being guessed at.
  manufacturerFromOui,
  normalizeMac,
  normalizeUsCanadaToE164,
  parseDeviceLabel,
  planDevicePreparation,
  provisioningStatusFor,
  type CloudDeviceState,
  type DeviceCapabilities,
  type DeviceIdentification,
  type PhoneState,
  type PreparationPlan,
  type PreparationStep,
  type ProviderReadiness,
} from "@connect/shared";
import type { DeskPhoneDeps } from "./deskPhoneRoutes";
import {
  failureFromError,
  providerFailure,
  serialEmbeddedMacTail,
  type ActionResult,
  type DeviceProvider,
  type PrepareHooks,
  type ProviderFailure,
} from "./deviceProvider";
import type { DeviceProviderRegistry } from "./deviceProviderRegistry";
import {
  addEvidence,
  cloudStateFromRow,
  evidenceForRow,
  identityColumns,
  sanitizeEvidence,
  vendorCloudStateFor,
} from "./deviceIdentityStore";
import { assertGdmsRuntimeMode, GdmsClient } from "./gdmsClient";
import { labelTextsFromSymbols, readLabelBarcodes } from "./labelBarcodes";
import {
  describeGdmsCredentials,
  resolveGdmsCredentials,
  storeGdmsCredentials,
  validateGdmsCredentials,
} from "./gdmsCredentials";
// Reading a PHOTO of the label. ⛔ The same engine the CRM uses — one OCR implementation in this
// api, one switch (CRM_OCR_ENABLED). When it is off these routes say so in plain words.
import {
  assertOcrSizeLimit,
  extractTextAdaptive,
  getOcrProvider,
  loadOcrConfig,
  OcrLimitError,
  resolveImageMime,
} from "../crm/docOcrProvider";
import { readChatAttachmentBuffer } from "../chatAttachmentStorage";
// ⛔ The platform's public identity lives in ONE module — the customer link must be
// built from the same origin the pay links and billing emails use, never a literal.
import { canonicalPortalOrigin } from "../publicOrigins";
// ⛔ The office wizard's own RPS claim (Izzy, 2026-09-17). `recordLabel` is where a
// Yealink's serial usually arrives, so it is the moment worth trying the claim.
import { ensureYealinkRedirect, type OfficeWizardClaimer } from "./yealinkRedirectClaim";
// ⛔ Duplicated in miniature from deskPhoneRoutes.ts's requesterIpOf rather than
// imported: that file imports `registerDeviceCloudRoutes` FROM this one, so an
// import the other way would be a runtime circular value-import.
import { clientIpFromForwardedFor } from "../loginThrottle";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };

export type DeviceCloudRouteContext = {
  deps: DeskPhoneDeps;
  db: any;
  getUser: (req: any) => JwtUser;
  ownRun: (req: any, reply: any) => Promise<{ user: JwtUser; run: any } | null>;
  allowedToSetUp: (user: JwtUser, reply: any) => Promise<boolean>;
  allowedToReset: (user: JwtUser, reply: any) => Promise<boolean>;
  isSuper: (user: JwtUser) => boolean;
  mayRunSetup: (req: any, reply: any) => Promise<JwtUser | null>;
  customerPhoneView: (row: any) => Record<string, unknown>;
  resetApprovalFor: (run: any, phoneId: string) => string | null;
  isOurProvisioningUrl: (url: string | null | undefined) => boolean;
  isRegistered: (tenantId: string, extNumber: string) => Promise<boolean>;
  /** The tenant's `/phoneprov/<16 hex>/` folder — threaded in from deskPhoneRoutes.ts's
   * own `deps.provisioningUrlFor ?? defaultProvisioningUrlFor` so this file never
   * imports that one back (it already imports `registerDeviceCloudRoutes` FROM here). */
  provisioningUrlFor: (tenantId: string) => Promise<string | null>;
  /** Injectable for tests only — threaded from `DeskPhoneDeps.managedPhoneService`,
   * the same seam `deskPhoneRoutes.ts` uses. See yealinkRedirectClaim.ts. */
  managedPhoneService?: OfficeWizardClaimer;
  /**
   * The rendered gs_provision config the PBX would serve this device (from its clean per-model
   * template), or null if none can be rendered. Used to SEND the config over the maker cloud —
   * the delivery that actually reaches a GDMS-claimed Grandstream when PnP/LAN do not.
   */
  renderDeviceConfig?: (tenantId: string, mac: string) => Promise<string | null>;
  registry: DeviceProviderRegistry;
  withMacLock: <T>(key: string, fn: (tx: any) => Promise<T>) => Promise<T>;
};

/** A claim with no answer after this long is treated as abandoned (its request died). */
export const CLAIM_STALE_MS = 10 * 60_000;

const MAKER_NAMES: Record<string, string> = {
  grandstream: "Grandstream", yealink: "Yealink", fanvil: "Fanvil", poly: "Poly",
};
const makerName = (provider: DeviceProvider) => MAKER_NAMES[provider.manufacturer] ?? "The maker";

const NOT_IN_SETUP = "This device was left out of the setup. Tick it on the list first.";
const NO_PROVIDER = "Loopcom can't manage this kind of device through its maker yet. It can still be set up over your network.";

const MANAGED_BY_US: CloudDeviceState = { checked: true, found: true, managedByUs: true, ownedElsewhere: false, online: null };

const serialTail = (s: string | null | undefined) => (s ? `…${s.slice(-4)}` : null);

async function readinessList(registry: DeviceProviderRegistry): Promise<ProviderReadiness[]> {
  try {
    return await registry.allReadiness();
  } catch {
    return [];
  }
}

function identify(row: any, readiness: ProviderReadiness[], cloud?: CloudDeviceState | null): DeviceIdentification {
  return identifyDevice({
    mac: String(row?.macAddress ?? ""),
    ip: row?.ipAddress ?? null,
    evidence: evidenceForRow(row ?? {}),
    readiness,
    cloud: cloud ?? cloudStateFromRow(row ?? {}),
  });
}

const isFreshClaim = (row: any, now = Date.now()) =>
  row?.vendorCloudState === "claiming"
  && Boolean(row.vendorCloudCheckedAt)
  && now - new Date(row.vendorCloudCheckedAt).getTime() < CLAIM_STALE_MS;

/**
 * Does ANOTHER Loopcom customer already manage, or is it registering, this hardware address?
 *
 * ⛔ Loopcom holds ONE account with each maker, so the maker's cloud saying "this device is
 * in our account" cannot tell customers apart. Our own records can, and they decide.
 * ⛔ Errors are NOT swallowed: an unreadable answer must stop a claim, never wave it through.
 */
export async function otherTenantHolds(client: any, mac: string, tenantId: string, now = Date.now()): Promise<boolean> {
  const rows = await client.deskPhoneSetupPhone.findMany({
    where: { macAddress: mac, tenantId: { not: tenantId }, vendorCloudState: { in: ["managed", "claiming"] } },
  });
  const live = (rows ?? []).some((r: any) => r.vendorCloudState === "managed" || isFreshClaim(r, now));
  if (live) return true;
  const managed = await client.managedDeskPhone.findFirst({
    where: { macAddress: mac, retiredAt: null, tenantId: { not: tenantId } },
  });
  return Boolean(managed);
}

async function reread(db: any, id: string, fallback: any): Promise<any> {
  const row = await db.deskPhoneSetupPhone.findFirst({ where: { id } });
  return row ?? fallback;
}

function capabilityView(caps: DeviceCapabilities) {
  const { paths: _paths, notes: _notes, ...flags } = caps;
  return flags;
}

function identificationView(id: DeviceIdentification, row: any, staff: boolean) {
  const status = provisioningStatusFor({
    phoneState: row?.state,
    vendorCloudState: row?.vendorCloudState ?? null,
    identityConfidence: id.confidence,
  });
  const base = {
    manufacturer: id.manufacturer,
    model: id.model,
    deviceType: id.deviceType,
    deviceTypeLabel: id.deviceTypeLabel,
    confidence: id.confidence,
    mac: id.macFormatted,
    ip: id.ip,
    needsIdentifying: id.needsIdentifying,
    serialOnFile: Boolean(id.serialNumber),
    vendorCloudState: row?.vendorCloudState || "unchecked",
    // ⛔ Plain English, never a maker name — same derivation as customerPhoneView's
    // zeroTouch in deskPhoneRoutes.ts, kept in the two places that project a row.
    zeroTouch: row?.vendorCloudState === "managed" ? "on" as const
      : row?.vendorCloudState === "conflict" ? "held_by_previous_provider" as const
      : "off" as const,
    provisioningStatus: status,
    provisioningStatusLabel: describeProvisioningStatus(status),
    capabilities: capabilityView(id.capabilities),
  };
  if (!staff) return base;
  return {
    ...base,
    confidenceScore: id.confidenceScore,
    firmware: id.firmware,
    serialNumber: id.serialNumber,
    sources: id.identificationSources,
    conflicts: id.conflicts,
    capabilityPaths: id.capabilities.paths,
    notes: id.capabilities.notes,
    vendorCloudCheckedAt: row?.vendorCloudCheckedAt || null,
  };
}

function failureView(f: ProviderFailure, staff: boolean) {
  return {
    ok: false,
    error: f.code,
    message: f.message,
    retryable: f.retryable,
    ...(f.possibleOwnershipConflict ? { possibleOwnershipConflict: true } : {}),
    ...(staff ? { staffMessage: f.staffMessage } : {}),
  };
}

function planView(plan: PreparationPlan) {
  return {
    status: plan.status,
    statusLabel: describeProvisioningStatus(plan.status),
    steps: plan.steps.map((s) => ({ step: s.step, via: s.via, why: s.why })),
    manualAction: plan.manualAction,
    resetNeeded: plan.resetNeeded,
    resetAuthorized: plan.resetAuthorized,
  };
}

function refusalStatus(f: ProviderFailure): number {
  if (f.code === "serial_number_required") return 400;
  if (f.retryable) return 503;
  return 409;
}

async function auditStep(
  deps: DeskPhoneDeps, user: JwtUser, row: any, provider: DeviceProvider,
  step: PreparationStep, result: ActionResult, extra: Record<string, unknown> = {},
): Promise<void> {
  const action = step === "claim"
    ? (result.ok ? "DESK_PHONE_CLAIMED" : "DESK_PHONE_CLAIM_REFUSED")
    : step === "factory_reset" && result.ok ? "DESK_PHONE_RESET_REQUESTED"
      : "DESK_PHONE_PREPARE_STEP";
  await deps.audit({
    tenantId: user.tenantId,
    action,
    entityType: "DeskPhoneSetupPhone",
    entityId: String(row?.id),
    actorUserId: user.sub,
    metadata: {
      mac: row?.macAddress ?? null,
      step,
      via: "vendor_cloud",
      platform: provider.platform,
      ok: result.ok,
      ...(result.ok
        ? { outcome: result.outcome, taskId: result.taskId }
        : { code: result.code, possibleOwnershipConflict: Boolean(result.possibleOwnershipConflict) }),
      ...extra,
    },
  });
}

type LookupOutcome =
  | { ok: true; state: CloudDeviceState; row: any; identification: DeviceIdentification }
  | { ok: false; failure: ProviderFailure; row: any; identification: DeviceIdentification };

/** Ask the maker's cloud about the device and write down what it said. */
async function lookupAndRecord(
  db: any, provider: DeviceProvider, phone: any, readiness: ProviderReadiness[], tenantId: string,
): Promise<LookupOutcome> {
  const mac = String(phone.macAddress);
  let result;
  try {
    result = await provider.lookup(mac);
  } catch (err) {
    result = failureFromError(err, makerName(provider));
  }
  if (!result.ok) {
    // ⛔ A failed read proves nothing: a device we know is ours, in conflict, or mid-claim
    // keeps that state. Only "we never knew" becomes "unavailable".
    const keep = ["managed", "conflict", "claiming"].includes(String(phone.vendorCloudState));
    const row = keep
      ? phone
      : await db.deskPhoneSetupPhone.update({ where: { id: phone.id }, data: { vendorCloudState: "unavailable" } });
    return { ok: false, failure: result, row, identification: identify(row, readiness) };
  }
  if (!result.state.checked) {
    return { ok: true, state: result.state, row: phone, identification: identify(phone, readiness) };
  }
  const now = new Date();
  const heldElsewhere = await otherTenantHolds(db, mac, tenantId, now.getTime());
  const state: CloudDeviceState = heldElsewhere ? { ...result.state, managedByUs: false, ownedElsewhere: true } : result.state;
  let next: string = heldElsewhere ? "conflict" : vendorCloudStateFor(state);
  const stillClaiming = !heldElsewhere && state.managedByUs !== true && isFreshClaim(phone, now.getTime());
  if (stillClaiming) next = "claiming";
  const cloudEvidence = result.device
    ? sanitizeEvidence({
      source: "vendor_cloud",
      manufacturer: provider.manufacturer,
      model: result.device.model,
      firmware: result.device.firmware,
      serialNumber: result.device.serialNumber,
      mac,
      observedAt: now.toISOString(),
    })
    : null;
  const ident = identityColumns({
    mac,
    ip: phone.ipAddress ?? null,
    evidence: addEvidence(evidenceForRow(phone), [cloudEvidence]),
    readiness,
    cloud: state,
  });
  const row = await db.deskPhoneSetupPhone.update({
    where: { id: phone.id },
    data: {
      ...ident.data,
      vendorCloudState: next,
      vendorCloudCheckedAt: stillClaiming ? phone.vendorCloudCheckedAt : now,
    },
  });
  return { ok: true, state, row, identification: ident.identification };
}

/**
 * Register a device to Loopcom with its maker — once, by one customer, at a time.
 *
 * ⛔ The ownership check and the "claiming" mark happen inside a lock on the hardware
 * address; the maker is called OUTSIDE it (a vendor call must never hold a database
 * transaction open). A second request that arrives while the first is in flight sees
 * "claiming" and backs off. Another customer holding the device is a proven conflict.
 */
async function runClaim(ctx: DeviceCloudRouteContext, input: {
  tenantId: string; phone: any; provider: DeviceProvider; serialNumber: string | null; readiness: ProviderReadiness[];
}): Promise<{ result: ActionResult; row: any }> {
  const { db } = ctx;
  const mac = String(input.phone.macAddress);
  const maker = makerName(input.provider);
  const begun = await ctx.withMacLock(`desk-phone-claim:${mac}`, async (tx: any) => {
    if (await otherTenantHolds(tx, mac, input.tenantId)) {
      await tx.deskPhoneSetupPhone.updateMany({
        where: { id: input.phone.id, tenantId: input.tenantId },
        data: { vendorCloudState: "conflict", vendorCloudCheckedAt: new Date() },
      });
      return { kind: "conflict" as const, previous: null };
    }
    const current = await tx.deskPhoneSetupPhone.findFirst({ where: { id: input.phone.id, tenantId: input.tenantId } });
    if (isFreshClaim(current)) return { kind: "busy" as const, previous: null };
    await tx.deskPhoneSetupPhone.updateMany({
      where: { id: input.phone.id, tenantId: input.tenantId },
      data: { vendorCloudState: "claiming", vendorCloudCheckedAt: new Date() },
    });
    return { kind: "claiming" as const, previous: (current?.vendorCloudState as string | null) ?? null };
  });
  if (begun.kind === "conflict") {
    return { result: providerFailure("device_ownership_conflict", maker), row: await reread(db, input.phone.id, input.phone) };
  }
  if (begun.kind === "busy") {
    return { result: providerFailure("claim_in_progress", maker), row: input.phone };
  }

  let result: ActionResult;
  try {
    result = await input.provider.claim({ mac, serialNumber: input.serialNumber, deviceName: input.phone.displayName ?? null });
  } catch (err) {
    result = failureFromError(err, maker);
  }

  // ⛔ Name the real mistake when we can attribute it (Izzy, 2026-09-15: "let the user know
  // that they mixed up the serial numbers"): the maker refused the MAC+serial pair AND the
  // serial's embedded MAC tail reads as a different handset's. Two agreeing signals — the
  // tail heuristic alone must never refuse a serial, or a phone whose serial breaks the
  // convention locks its own owner out with nothing to argue with.
  if (!result.ok && result.code === "gdms_request_rejected" && input.serialNumber) {
    const tail = serialEmbeddedMacTail(input.serialNumber);
    const n = normalizeMac(mac);
    if (tail && n && !n.endsWith(tail)) {
      result = providerFailure("serial_for_different_device", maker);
    }
  }

  const now = new Date();
  let data: Record<string, unknown>;
  if (result.ok) {
    // The claim is already verified by the provider's read-back; the facts are a bonus.
    let cloudEvidence = null;
    try {
      const look = await input.provider.lookup(mac);
      if (look.ok && look.device) {
        cloudEvidence = sanitizeEvidence({
          source: "vendor_cloud",
          manufacturer: input.provider.manufacturer,
          model: look.device.model,
          firmware: look.device.firmware,
          serialNumber: look.device.serialNumber,
          mac,
          observedAt: now.toISOString(),
        });
      }
    } catch { /* keep what we have */ }
    const serialEvidence = input.serialNumber
      ? sanitizeEvidence({ source: "serial_number", serialNumber: input.serialNumber, observedAt: now.toISOString() })
      : null;
    const ident = identityColumns({
      mac,
      ip: input.phone.ipAddress ?? null,
      evidence: addEvidence(evidenceForRow(input.phone), [serialEvidence, cloudEvidence]),
      readiness: input.readiness,
      cloud: MANAGED_BY_US,
    });
    data = { ...ident.data, vendorCloudState: "managed", vendorCloudCheckedAt: now };
    if (input.serialNumber) data.serialNumber = input.serialNumber;
  } else {
    // ⛔ A refusal proves nothing about ownership: the state goes back to what it was, and a
    // write that may have landed is left "unchecked" so the next look reads it back.
    const back = result.code === "gdms_write_uncertain_check_again" || begun.previous === "claiming"
      ? "unchecked"
      : begun.previous;
    data = { vendorCloudState: back };
    if (input.serialNumber && result.retryable) data.serialNumber = input.serialNumber;
  }
  const row = await db.deskPhoneSetupPhone.update({ where: { id: input.phone.id }, data });
  return { result, row };
}

export function registerDeviceCloudRoutes(app: FastifyInstance, ctx: DeviceCloudRouteContext): void {
  const {
    deps, db, getUser, ownRun, allowedToSetUp, isSuper, mayRunSetup,
    customerPhoneView, resetApprovalFor, registry, provisioningUrlFor, managedPhoneService,
  } = ctx;

  /** The public address the customer's own computer reached us from — the LAST
   * X-Forwarded-For entry, exactly as deskPhoneRoutes.ts's requesterIpOf reads it. */
  const requesterIpOf = (req: any): string | null => {
    const ip = clientIpFromForwardedFor(req?.headers?.["x-forwarded-for"]);
    return ip && ip !== "unknown" ? ip : null;
  };

  /** What each maker's cloud can do in THIS deployment, in words a customer can read. */
  app.get("/desk-phones/providers", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const readiness = await readinessList(registry);
    const staff = isSuper(user);
    return reply.send({
      ok: true,
      providers: readiness.map((r) => ({
        manufacturer: r.manufacturer,
        cloudConnected: r.cloudConfigured,
        canRegisterDevices: r.cloudConfigured && r.supportedActions.includes("claim"),
        needsSerialToRegister: r.claimRequiresSerial === true,
        note: r.note,
        ...(staff ? { platform: r.platform, supportedActions: r.supportedActions, redirectOnly: r.redirectOnly } : {}),
      })),
    });
  });

  /** What this device IS, how sure we are, and what can be done with it. */
  app.get("/desk-phones/runs/:id/phones/:phoneId/identification", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });
    const id = identify(phone, await readinessList(registry));
    return reply.send({ ok: true, identification: identificationView(id, phone, isSuper(user)) });
  });

  /** Ask the maker's cloud about the device. Read-only at the maker. */
  app.post("/desk-phones/runs/:id/phones/:phoneId/vendor-lookup", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    const staff = isSuper(user);
    const readiness = await readinessList(registry);
    const provider = registry.providerFor(identify(phone, readiness).manufacturer);
    if (!provider) {
      return reply.send({
        ok: true, checked: false, message: NO_PROVIDER,
        phone: customerPhoneView(phone), identification: identificationView(identify(phone, readiness), phone, staff),
      });
    }
    const looked = await lookupAndRecord(db, provider, phone, readiness, user.tenantId);
    await deps.audit({
      tenantId: user.tenantId,
      action: "DESK_PHONE_VENDOR_LOOKUP",
      entityType: "DeskPhoneSetupPhone",
      entityId: phone.id,
      actorUserId: user.sub,
      metadata: looked.ok
        ? { mac: phone.macAddress, platform: provider.platform, ok: true, checked: looked.state.checked, found: looked.state.found, managedByUs: looked.state.managedByUs, online: looked.state.online }
        : { mac: phone.macAddress, platform: provider.platform, ok: false, code: looked.failure.code },
    });
    if (!looked.ok) {
      return reply.send({
        ...failureView(looked.failure, staff),
        phone: customerPhoneView(looked.row),
        identification: identificationView(looked.identification, looked.row, staff),
      });
    }
    const ready = readiness.find((r) => r.manufacturer === provider.manufacturer) ?? null;
    return reply.send({
      ok: true,
      checked: looked.state.checked,
      message: looked.state.checked ? null : ready?.note ?? null,
      cloud: {
        found: looked.state.found, managedByUs: looked.state.managedByUs,
        ownedElsewhere: looked.state.ownedElsewhere, online: looked.state.online,
      },
      phone: customerPhoneView(looked.row),
      identification: identificationView(looked.identification, looked.row, staff),
    });
  });

  /** Register the device to Loopcom with its maker. */
  app.post("/desk-phones/runs/:id/phones/:phoneId/claim", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const body = z.object({ serialNumber: z.string().trim().max(64).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });
    if (phone.skippedAt) return reply.status(409).send({ ok: false, error: "phone_not_in_setup", message: NOT_IN_SETUP });

    const staff = isSuper(user);
    const readiness = await readinessList(registry);
    const provider = registry.providerFor(identify(phone, readiness).manufacturer);
    if (!provider) return reply.status(409).send({ ok: false, error: "not_supported", message: NO_PROVIDER });
    const maker = makerName(provider);
    const ready = readiness.find((r) => r.manufacturer === provider.manufacturer) ?? null;
    if (!ready?.cloudConfigured) return reply.status(409).send(failureView(providerFailure("cloud_not_configured", maker), staff));
    if (!ready.supportedActions.includes("claim")) return reply.status(409).send(failureView(providerFailure("not_supported", maker), staff));

    const typed = body.data.serialNumber ? cleanSerialNumber(body.data.serialNumber) : null;
    if (body.data.serialNumber && !typed) {
      return reply.status(400).send({
        ok: false, error: "serial_number_invalid",
        message: "That doesn't look like a serial number. Scan the barcode on the label, or type it exactly as printed.",
      });
    }
    const serial = typed ?? cleanSerialNumber(phone.serialNumber);
    if (ready.claimRequiresSerial && !serial) {
      return reply.status(400).send({ ...failureView(providerFailure("serial_number_required", maker), staff), needsSerial: true });
    }

    const claimed = await runClaim(ctx, {
      tenantId: user.tenantId, phone, provider, serialNumber: serial, readiness,
    });
    await auditStep(deps, user, claimed.row, provider, "claim", claimed.result, { serialTail: serialTail(serial) });
    if (!claimed.result.ok) {
      return reply.status(refusalStatus(claimed.result)).send({
        ...failureView(claimed.result, staff),
        needsSerial: claimed.result.code === "serial_number_required",
        phone: customerPhoneView(claimed.row),
      });
    }
    return reply.send({
      ok: true,
      outcome: claimed.result.outcome,
      message: claimed.result.message,
      phone: customerPhoneView(claimed.row),
      identification: identificationView(identify(claimed.row, readiness), claimed.row, staff),
    });
  });

  /* ── the label, however it reaches us ─────────────────────────────────── */

  /** Below this, OCR's own reading of the picture is not sharp enough to trust a serial from. */
  const MIN_LABEL_PHOTO_CONFIDENCE = 55;
  /** Matches the OCR engine's own default ceiling; a phone camera shot is far under it. */
  const MAX_LABEL_PHOTO_BYTES = 10 * 1024 * 1024;
  const PHOTO_UNREADABLE =
    "We couldn't read that picture clearly enough to be sure. Take another one straight on, "
    + "close enough that the small print is sharp, with the light behind you rather than behind the phone.";
  const PHOTO_READING_OFF =
    "Reading photos isn't switched on for your account yet. Type the serial number instead — "
    + "it's the line on the sticker that starts with S/N.";

  /**
   * The bit of a photo's text that could hold a label. ⛔ `parseDeviceLabel` reads the first 600
   * characters, which is plenty for a typed line but NOT for a photo: a picture of the underside
   * catches regulatory small print, barcodes and a compliance paragraph, and the serial can easily
   * sit past the cut. So whitespace is collapsed and, when it is still too long, the window is
   * centred on whichever marker appears — otherwise the serial is silently truncated away and the
   * customer is told their own clear photo was unreadable.
   */
  function labelTextFromPhoto(raw: string): string {
    const flat = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (flat.length <= 600) return flat;
    const marker = /\b(?:S\/?N|SERIAL|MAC)\b/i.exec(flat);
    if (!marker) return flat.slice(0, 600);
    const start = Math.max(0, marker.index - 120);
    return flat.slice(start, start + 600);
  }

  type PhotoText =
    | { ok: true; text: string; confidence: number; pass: string; passesRun: number }
    | { ok: false; status: number; error: string; message: string };

  /**
   * A PREVIEW of recordLabel's accept test, used only to pick WHICH OCR pass of a photo
   * is worth submitting — sideways and upside-down phone photos read as garbage until the
   * right rotation is tried. ⛔ recordLabel stays the ONE judge: a pass this preview
   * approves is still judged there in full, and when no pass is approved the best-reading
   * pass goes through the same refusals as before. Nothing is accepted more easily.
   */
  function photoPassLooksAcceptable(phone: any): (raw: string, confidence: number) => boolean {
    return (raw, confidence) => {
      const label = parseDeviceLabel(labelTextFromPhoto(raw));
      if (label.mac && label.mac !== phone.macAddress) return false;
      if (!label.serialNumber && !label.model) return false;
      return confidence >= MIN_LABEL_PHOTO_CONFIDENCE || label.mac === phone.macAddress;
    };
  }

  /** OCRs one image in memory. ⛔ The picture is never written anywhere and never logged. */
  async function readLabelPhoto(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
    looksGood: (text: string, confidence: number) => boolean,
  ): Promise<PhotoText> {
    const config = loadOcrConfig();
    const provider = getOcrProvider(config);
    // ⛔ OFF IS AN HONEST ANSWER, NOT A FAILURE. Reading photos is one switch on the api; while it
    // is off the person is told to type the serial, which always works and needs no password.
    if (!provider) return { ok: false, status: 503, error: "photo_reading_off", message: PHOTO_READING_OFF };
    const mime = resolveImageMime(mimeType, fileName);
    if (!mime || !provider.supports(mime)) {
      return {
        ok: false, status: 400, error: "unsupported_image",
        message: "That file isn't a photo we can read. Send a JPG or PNG straight from the phone's camera.",
      };
    }
    try {
      assertOcrSizeLimit(buffer, config);
    } catch (err) {
      if (err instanceof OcrLimitError) {
        return {
          ok: false, status: 400, error: "photo_too_large",
          message: "That picture is too big to read. Send it at normal quality rather than full resolution.",
        };
      }
      throw err;
    }
    // ⛔ BARCODES FIRST. The sticker's MAC and serial are Code-128 symbols; decoding them is
    // rotation-proof and checksummed where OCR mangles exactly the characters that matter
    // (proven 2026-09-15: the first real label photo — upside-down, flash glare — read as
    // nothing through four OCR passes while both barcodes decode exactly). A decoded symbol
    // is reported at confidence 100 because a Code-128 read is checksum-verified, not a
    // guess; the ONE gate (recordLabel) still judges it — MAC mismatch refuses as always.
    const barcodes = await readLabelBarcodes(buffer);
    if (barcodes.texts.length > 0) {
      return { ok: true, text: barcodes.texts.join("\n"), confidence: 100, pass: "barcode", passesRun: 0 };
    }
    try {
      const out = await extractTextAdaptive(provider, { buffer, mimeType: mime, fileName }, config, looksGood);
      return {
        ok: true,
        text: out.text ?? "",
        confidence: typeof out.confidence === "number" ? out.confidence : 0,
        pass: out.pass,
        passesRun: out.passesRun,
      };
    } catch {
      // ⛔ The engine's own error text never reaches a customer — it is noise to them and may name
      // internals. An unreadable picture gets the sentence that tells them what to do instead.
      return { ok: false, status: 400, error: "photo_unreadable", message: PHOTO_UNREADABLE };
    }
  }

  type LabelOutcome =
    | { ok: false; status: number; error: string; message: string }
    | { ok: true; body: Record<string, unknown> };

  /**
   * ⛔⛔ ONE GATE FOR EVERY WAY A LABEL REACHES US — typed, scanned off a barcode, photographed,
   * or texted in. There were three arrivals added on 2026-09-14 and there must stay ONE set of
   * rules: a second copy is how one door comes to accept what another refuses, which on this
   * screen means a serial silently attached to the wrong handset.
   */
  async function recordLabel(
    user: JwtUser,
    phone: any,
    text: string,
    /** How it arrived. Audit only — see the evidence note below. */
    via: "typed_or_scanned" | "photo" | "texted_photo",
    /** OCR's 0–100 reading of how sharp the text was; null when a person typed or scanned it. */
    confidence: number | null,
    /** Which OCR pass produced the text and how many ran. Names and counts only — audit material. */
    photoRead?: { pass: string; passesRun: number } | null,
    /** For `ensureYealinkRedirect`'s presence pair — the request that carried this label,
     * from whichever of the six doors it arrived through (office wizard or a customer's
     * own scan link). */
    req?: any,
  ): Promise<LabelOutcome> {
    const label = parseDeviceLabel(text);

    // ⛔⛔ A MISREAD ADDRESS MUST NOT READ AS "THAT IS A DIFFERENT PHONE". The hardware address is
    // the first thing OCR mangles on a soft photo (8/B, 0/D, 5/S, 1/I), so below the confidence
    // bar a mismatch is far more likely a poor picture than the wrong handset — and "that label
    // belongs to a different device" is an accusation the person cannot argue with while holding
    // the right phone. Under the bar we ask for a clearer picture; at or above it, a mismatch is
    // real and is refused exactly as a scanned label always has been.
    const trusted = confidence === null || confidence >= MIN_LABEL_PHOTO_CONFIDENCE;
    if (label.mac && label.mac !== phone.macAddress) {
      if (!trusted) return { ok: false, status: 400, error: "photo_unreadable", message: PHOTO_UNREADABLE };
      return {
        ok: false, status: 409, error: "label_for_different_device",
        message: `That label belongs to a different device (${formatMac(label.mac)}). Scan the label on this one.`,
      };
    }
    if (!label.serialNumber && !label.model) {
      return confidence === null
        ? {
          ok: false, status: 400, error: "label_unreadable",
          message: "We couldn't read a model or serial number from that. Scan the barcode again, or type what the label says.",
        }
        : { ok: false, status: 400, error: "photo_unreadable", message: PHOTO_UNREADABLE };
    }
    // ⛔ A serial read off a picture we cannot vouch for is WORSE than no serial: it is stored, the
    // maker's cloud rejects it minutes later, and the customer is left holding an error about a
    // number they never typed. The address on the sticker matching this phone is the one thing
    // that proves the read came out clean, so a soft photo is accepted only when it does.
    if (!trusted && label.mac !== phone.macAddress) {
      return { ok: false, status: 400, error: "photo_unreadable", message: PHOTO_UNREADABLE };
    }

    const staff = isSuper(user);
    const readiness = await readinessList(registry);
    // ⛔ A photograph of the label IS the label, so the evidence source stays `barcode_label`.
    // Inventing a `label_photo` source would mean touching the shared identification union and its
    // confidence ordering — a change across every brand — to record something only the audit needs.
    const fromLabel = sanitizeEvidence({
      source: "barcode_label",
      manufacturer: label.manufacturer !== "unknown" ? label.manufacturer : null,
      model: label.model,
      serialNumber: label.serialNumber,
      mac: label.mac,
      observedAt: new Date().toISOString(),
    });
    const ident = identityColumns({
      mac: String(phone.macAddress),
      ip: phone.ipAddress ?? null,
      evidence: addEvidence(evidenceForRow(phone), [fromLabel]),
      readiness,
      cloud: cloudStateFromRow(phone),
    });
    const data: Record<string, unknown> = { ...ident.data };
    if (label.serialNumber) data.serialNumber = label.serialNumber;
    // A label naming a model the phone system knows fills an EMPTY model the same way a
    // person picking it would — spelled as the catalogue spells it, never as scanned.
    let modelAccepted = false;
    if (!phone.model && label.model) {
      const picked = identifyPhone({ make: null, model: label.model });
      if (picked.ok) {
        data.vendor = picked.vendor;
        data.model = picked.model;
        modelAccepted = true;
      }
    }
    const updated = await db.deskPhoneSetupPhone.update({ where: { id: phone.id }, data });
    await deps.audit({
      tenantId: user.tenantId,
      action: "DESK_PHONE_LABEL_SCANNED",
      entityType: "DeskPhoneSetupPhone",
      entityId: phone.id,
      actorUserId: user.sub,
      metadata: {
        mac: phone.macAddress, model: label.model, serialTail: serialTail(label.serialNumber),
        manufacturer: label.manufacturer, modelAccepted, via,
        // ⛔ The reading, never the text: OCR output can carry anything that was in shot.
        photoConfidence: confidence === null ? null : Math.round(confidence),
        ...(photoRead ? { photoPass: photoRead.pass, photoPassesRun: photoRead.passesRun } : {}),
      },
    });

    // ⛔⛔ THE SERIAL JUST LANDED — for a Yealink this is usually the LAST input Yealink's
    // RPS claim needed, so this is where "scan → claimed" becomes true through every one
    // of the six doors above (office wizard or the customer's own scan link), never a
    // seventh copy of the RPS logic. Awaited and re-read so the response below carries the
    // real outcome; best-effort — ensureYealinkRedirect itself never throws.
    let afterCloud = updated;
    try {
      await ensureYealinkRedirect(updated, user, req, {
        audit: deps.audit, db, managedPhoneService, provisioningUrlFor, requesterIp: requesterIpOf,
      });
      afterCloud = (await db.deskPhoneSetupPhone.findFirst({ where: { id: phone.id } })) ?? updated;
    } catch { /* best-effort; the label itself is already saved above */ }

    return {
      ok: true,
      body: {
        ok: true,
        found: { model: label.model, manufacturer: label.manufacturer, serialFound: Boolean(label.serialNumber) },
        phone: customerPhoneView(afterCloud),
        identification: identificationView(identify(afterCloud, readiness), afterCloud, staff),
      },
    };
  }

  /** (845) 555-0112 — how a number is shown to a person, never the raw E.164. */
  function prettyNumber(e164: string): string {
    const d = String(e164 ?? "").replace(/\D/g, "");
    const ten = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
    return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : String(e164 ?? "");
  }

  /**
   * The label underneath the device, when nothing on the network could name it: whatever a
   * barcode/QR scanner typed, or what a person copied off the sticker.
   * ⛔ A label for a DIFFERENT device is refused, never attached to this one.
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/scan-label", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const body = z.object({ text: z.string().trim().min(1).max(600) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    // ⛔ Typed or scanned text is trusted as read — a person looking at the sticker is not an OCR
    // guess — so no confidence is passed. Every refusal below lives in `recordLabel`, shared with
    // the photo and text-message doors.
    const outcome = await recordLabel(user, phone, body.data.text, "typed_or_scanned", null, undefined, req);
    if (!outcome.ok) {
      return reply.status(outcome.status).send({ ok: false, error: outcome.error, message: outcome.message });
    }
    return reply.send(outcome.body);
  });

  /**
   * A PHOTO of the sticker (Izzy, 2026-09-14: "upload a photo of the back of the phone").
   *
   * ⛔ THE PICTURE IS READ AND DROPPED. Nothing is written to storage and no image or OCR text is
   * logged — only what the label said (model, serial) is kept, exactly as a typed label would be.
   * ⛔ "Is it a clear picture?" is answered here rather than left to the customer to judge
   * (Izzy: "the system should check if it's a clear picture … tell them to send a clear picture").
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/label-photo", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    if (!req.isMultipart?.()) return reply.status(400).send({ error: "multipart_required" });
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    let file: any = null;
    try {
      file = await req.file({ limits: { fileSize: MAX_LABEL_PHOTO_BYTES } });
    } catch (err: any) {
      return reply.status(400).send({ error: "multipart_parse_failed", detail: err?.message });
    }
    if (!file) return reply.status(400).send({ error: "file_required" });
    const buffer = await file.toBuffer();
    if (!buffer?.length) return reply.status(400).send({ error: "file_required" });

    const read = await readLabelPhoto(
      buffer, String(file.mimetype || ""), String(file.filename || "label.jpg"), photoPassLooksAcceptable(phone),
    );
    if (!read.ok) return reply.status(read.status).send({ ok: false, error: read.error, message: read.message });
    const outcome = await recordLabel(
      user, phone, labelTextFromPhoto(read.text), "photo", read.confidence,
      { pass: read.pass, passesRun: read.passesRun }, req,
    );
    if (!outcome.ok) {
      // Numbers only — so "it couldn't read my photo" is answerable from the audit next time.
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_LABEL_PHOTO_REFUSED",
        entityType: "DeskPhoneSetupPhone", entityId: phone.id, actorUserId: user.sub,
        metadata: {
          error: outcome.error, via: "photo",
          photoConfidence: Math.round(read.confidence), photoPass: read.pass, photoPassesRun: read.passesRun,
        },
      });
      return reply.status(outcome.status).send({ ok: false, error: outcome.error, message: outcome.message });
    }
    return reply.send(outcome.body);
  });

  /**
   * "I'll text the photo" — the customer says WHICH number it will come from, and we say which
   * number to send it to (Izzy, 2026-09-14: "make the system prompt them which number they're
   * going to send it from, so the system knows what to look for").
   *
   * ⛔ Asking for the sending number is what makes the next step a LOOKUP rather than a watch: we
   * read one thread, from one number, for messages after this moment — never the tenant's inbox
   * at large, and never on a timer (Izzy: "we don't need an OCR that would constantly check").
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/label-photo/expect", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    // ⛔ ONE JUDGE OF "IS THIS A PHONE NUMBER", and it is the normaliser below — not this length
    // bound. A schema minimum here would answer a short typo with a bare `invalid_request` and no
    // sentence, so the person reads the browser's fallback wording instead of being told to enter
    // the 10 digits. The bound stays only to cap what we parse.
    const body = z.object({ fromNumber: z.string().trim().min(1).max(30) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    const parsed = normalizeUsCanadaToE164(body.data.fromNumber);
    if (!parsed.ok || !parsed.e164) {
      return reply.status(400).send({
        ok: false, error: "bad_number",
        message: "That doesn't look like a US or Canadian mobile number. Enter the 10 digits of the phone you'll text from.",
      });
    }
    // ⛔ A picture can only arrive on a number that can RECEIVE pictures. Promising "text it to us"
    // on an SMS-only number would leave the customer texting into a hole and blaming themselves.
    const inbox = await db.tenantSmsNumber.findFirst({
      where: { tenantId: user.tenantId, active: true, mmsCapable: true },
      orderBy: [{ isTenantDefault: "desc" }, { createdAt: "asc" }],
    });
    if (!inbox?.phoneE164) {
      return reply.status(409).send({
        ok: false, error: "no_texting_number",
        message: "None of your numbers can receive photos yet, so texting one in won't work. Type the serial number instead, or upload the photo here.",
      });
    }
    await db.deskPhoneSetupPhone.update({
      where: { id: phone.id },
      data: { labelPhotoFromE164: parsed.e164, labelPhotoAskedAt: new Date() },
    });
    return reply.send({
      ok: true,
      textTo: prettyNumber(inbox.phoneE164),
      fromNumber: prettyNumber(parsed.e164),
      message: `Text one photo of the sticker to ${prettyNumber(inbox.phoneE164)} from ${prettyNumber(parsed.e164)}, then press "I've sent it".`,
    });
  });

  /**
   * "I've sent it" — read the chat ONCE and look for that picture.
   *
   * ⛔ Bounded on every axis, deliberately: the customer's own tenant, the one number they named,
   * messages that arrived AFTER they were asked, inbound only, newest first, one message, one
   * image. An older photo already sitting in the thread can never be mistaken for this answer.
   * ⛔ An unreadable picture does NOT clear the expectation — they can simply text a better one
   * and press this again. Only a label we actually accepted stops us looking.
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/label-photo/check", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });
    if (!phone.labelPhotoFromE164 || !phone.labelPhotoAskedAt) {
      return reply.status(409).send({
        ok: false, error: "not_expecting_a_photo",
        message: "Tell us which number you'll text from first.",
      });
    }

    const waiting = {
      ok: true, waiting: true,
      message: `We haven't seen a photo from ${prettyNumber(phone.labelPhotoFromE164)} yet. Send it, give it a moment, then press this again.`,
    };
    const thread = await db.connectChatThread.findFirst({
      where: { tenantId: user.tenantId, externalSmsE164: phone.labelPhotoFromE164 },
      orderBy: { lastMessageAt: "desc" },
    });
    if (!thread) return reply.send(waiting);
    const msg = await db.connectChatMessage.findFirst({
      where: {
        tenantId: user.tenantId,
        threadId: thread.id,
        direction: "INBOUND",
        createdAt: { gte: phone.labelPhotoAskedAt },
        attachments: { some: {} },
      },
      orderBy: { createdAt: "desc" },
      include: { attachments: true },
    });
    const picture = (msg?.attachments ?? []).find(
      (a: any) => a?.mediaKind === "image" || String(a?.mimeType ?? "").toLowerCase().startsWith("image/"),
    );
    if (!picture?.storageKey) return reply.send(waiting);

    const buffer = await readChatAttachmentBuffer(picture.storageKey).catch(() => null);
    if (!buffer?.length) return reply.send(waiting);
    const read = await readLabelPhoto(
      buffer, String(picture.mimeType || ""), String(picture.fileName || "label.jpg"), photoPassLooksAcceptable(phone),
    );
    if (!read.ok) return reply.status(read.status).send({ ok: false, error: read.error, message: read.message });
    const outcome = await recordLabel(
      user, phone, labelTextFromPhoto(read.text), "texted_photo", read.confidence,
      { pass: read.pass, passesRun: read.passesRun }, req,
    );
    if (!outcome.ok) {
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_LABEL_PHOTO_REFUSED",
        entityType: "DeskPhoneSetupPhone", entityId: phone.id, actorUserId: user.sub,
        metadata: {
          error: outcome.error, via: "texted_photo",
          photoConfidence: Math.round(read.confidence), photoPass: read.pass, photoPassesRun: read.passesRun,
        },
      });
      return reply.status(outcome.status).send({ ok: false, error: outcome.error, message: outcome.message });
    }
    // Read and accepted — stop looking, so a later unrelated picture from the same number is
    // never pulled into this phone's record.
    await db.deskPhoneSetupPhone.update({
      where: { id: phone.id },
      data: { labelPhotoFromE164: null, labelPhotoAskedAt: null },
    });
    return reply.send(outcome.body);
  });

  /**
   * "Prepare Device": identify → validate ownership → register with the maker →
   * re-point → reset ONLY when needed and allowed → restart → phone system → verify.
   *
   * ⛔ Runs only the steps the maker's cloud performs. Steps that belong to the network
   * path (the office machine) or the phone system are returned in `leftForOthers` and are
   * carried out by the existing wizard ladder, which is also what turns a device Ready.
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/prepare", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    // A finished run of another customer still reads 404; a finished run of theirs prepares nothing.
    if (run.status !== "running") return reply.status(404).send({ error: "not_found" });
    if (!(await allowedToSetUp(user, reply))) return;
    const body = z.object({ dryRun: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });
    if (phone.skippedAt) return reply.status(409).send({ ok: false, error: "phone_not_in_setup", message: NOT_IN_SETUP });

    const staff = isSuper(user);
    const readiness = await readinessList(registry);
    let row: any = phone;
    const provider = registry.providerFor(identify(row, readiness).manufacturer);
    const ready = provider ? readiness.find((r) => r.manufacturer === provider.manufacturer) ?? null : null;

    // 1. What does the maker's cloud know, when this deployment can ask?
    let cloud: CloudDeviceState = cloudStateFromRow(row);
    let lookupFailure: ProviderFailure | null = null;
    if (provider && ready?.cloudConfigured && ready.supportedActions.includes("lookup")) {
      const looked = await lookupAndRecord(db, provider, row, readiness, user.tenantId);
      row = looked.row;
      if (looked.ok) cloud = looked.state;
      else lookupFailure = looked.failure;
    }

    // 2. Decide — ownership first.
    const decide = async (current: any, currentCloud: CloudDeviceState) => {
      const heldElsewhere = await otherTenantHolds(db, String(current.macAddress), user.tenantId);
      const effective: CloudDeviceState = heldElsewhere
        ? { ...currentCloud, managedByUs: false, ownedElsewhere: true }
        : currentCloud;
      const ownership = heldElsewhere ? "other_tenant" as const
        : effective.ownedElsewhere === true ? "other_vendor_account" as const
          : effective.managedByUs === true ? "ours" as const
            : effective.found === false ? "unclaimed" as const
              : "unknown" as const;
      let registeredToUs = false;
      if (current.extNumber) {
        try { registeredToUs = await ctx.isRegistered(user.tenantId, String(current.extNumber)); } catch { registeredToUs = false; }
      }
      const plan = planDevicePreparation({
        identification: identify(current, readiness, effective),
        cloud: effective,
        ownership,
        registeredToUs,
        lockedByOtherProvider: current.provisioningUrl ? !ctx.isOurProvisioningUrl(current.provisioningUrl) : null,
        resetAuthorized: Boolean(resetApprovalFor(run, current.id)),
        // Reset-first: the one reset for this phone in this setup, whichever path sent it.
        resetAlreadyDone: Number(current.resetCount ?? 0) > 0,
      });
      return { plan, heldElsewhere };
    };

    let { plan, heldElsewhere } = await decide(row, cloud);
    if (plan.status === "conflict" && heldElsewhere && row.vendorCloudState !== "conflict") {
      row = await db.deskPhoneSetupPhone.update({
        where: { id: row.id },
        data: { vendorCloudState: "conflict", vendorCloudCheckedAt: new Date() },
      });
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_OWNERSHIP_CONFLICT",
        entityType: "DeskPhoneSetupPhone", entityId: row.id, actorUserId: user.sub,
        metadata: { mac: row.macAddress, heldBy: "another_loopcom_customer" },
      });
    }

    const ran: Array<{ step: PreparationStep; result: ActionResult }> = [];

    // SEND the settings over the cloud, once the device is in the maker's account and it is NOT
    // being wiped this round. ⛔ For Grandstream this is the delivery that WORKS: a GDMS-claimed
    // phone never hears the office machine's PnP multicast and silently ignores an HTTP config
    // write, but it pulls and applies a config pushed through GDMS (proven live 2026-09-15). The
    // config comes from a CLEAN per-model template (correct server), not another customer's. A
    // wiping phone can take nothing, so it is sent on the next prepare, once the phone is back.
    async function sendConfigOverCloud(): Promise<void> {
      if (!provider || provider.manufacturer !== "grandstream") return;
      if (row.vendorCloudState !== "managed" && cloud.managedByUs !== true) return;
      if (ran.some((r) => r.step === "factory_reset" && r.result.ok)) return; // wiping — next time
      if (!ctx.renderDeviceConfig) return;
      const xml = await ctx.renderDeviceConfig(user.tenantId, String(row.macAddress)).catch(() => null);
      if (!xml) return;
      const pushed = await provider.pushConfig({ mac: String(row.macAddress), xml });
      ran.push({ step: "reprovision", result: pushed });
      await auditStep(deps, user, row, provider, "reprovision", pushed);
    }

    const respond = async (stoppedAt: PreparationStep | null, leftForOthers: PreparationStep[] = []) => {
      await sendConfigOverCloud();
      const fresh = await reread(db, row.id, row);
      return reply.send({
        ok: true,
        dryRun: Boolean(body.data.dryRun),
        plan: planView(plan),
        ran: ran.map(({ step, result }) => (result.ok
          ? { step, ok: true, outcome: result.outcome, message: result.message }
          : { step, ...failureView(result, staff) })),
        stoppedAt,
        leftForOthers,
        lookup: lookupFailure ? failureView(lookupFailure, staff) : null,
        phone: customerPhoneView(fresh),
        identification: identificationView(identify(fresh, readiness), fresh, staff),
      });
    };
    const hasCloudStep = (p: PreparationPlan, step?: PreparationStep) =>
      p.steps.some((s) => s.via === "vendor_cloud" && (!step || s.step === step));

    if (body.data.dryRun || !provider || plan.manualAction || !hasCloudStep(plan)) return respond(null);
    // ⛔ Reset-first, exactly as the ladder: TICKING the phone is the consent to clear it
    // (Izzy, 2026-09-14). The plan names a reset only when this phone was ticked, and
    // decideReset re-checks that approval right before the reset is spent.

    const maker = makerName(provider);

    // 3. Register it with its maker first — what the cloud can do afterwards depends on it.
    if (hasCloudStep(plan, "claim")) {
      const serial = cleanSerialNumber(row.serialNumber) ?? identify(row, readiness).serialNumber;
      const claimed = await runClaim(ctx, {
        tenantId: user.tenantId, phone: row, provider, serialNumber: serial, readiness,
      });
      ran.push({ step: "claim", result: claimed.result });
      row = claimed.row;
      await auditStep(deps, user, row, provider, "claim", claimed.result, { serialTail: serialTail(serial) });
      if (!claimed.result.ok) return respond("claim");
      ({ plan, heldElsewhere } = await decide(row, MANAGED_BY_US));
      if (plan.manualAction || !hasCloudStep(plan)) return respond(null);
    }

    // 4. Everything else the maker's cloud does, through the provider's one loop.
    const approvedAt = resetApprovalFor(run, row.id);
    const before = {
      state: row.state as PhoneState,
      resetCount: Number(row.resetCount ?? 0),
      resetRequestedAt: row.resetRequestedAt ?? null,
      attempts: Number(row.attempts ?? 0),
    };
    let resetClaimed = false;
    const refuse = async (step: PreparationStep, failure: ProviderFailure) => {
      await auditStep(deps, user, row, provider, step, failure);
      return failure;
    };
    const hooks: PrepareHooks = {
      beforeStep: async (step) => {
        if ((step === "reboot" || step === "factory_reset") && !row.extNumber) {
          return refuse(step, providerFailure("needs_assignment", maker));
        }
        if (step !== "factory_reset") return null;
        const verdict = decideReset({
          state: before.state, resetCount: before.resetCount, resetAuthorizedAt: approvedAt, attempts: before.attempts,
        });
        if (!verdict.allowed) {
          const code = verdict.reason === "already_reset" ? "reset_already_used"
            : verdict.reason === "not_authorized" ? "reset_authorization_required" : "reset_not_allowed";
          return refuse(step, providerFailure(code, maker));
        }
        // ⛔ The reset is SPENT atomically on the counter just read, BEFORE the maker is
        // asked: two prepares racing produce one reset, and a request that read the row
        // after the other's claim is refused by decideReset above.
        const claim = await db.deskPhoneSetupPhone.updateMany({
          where: { id: row.id, resetCount: before.resetCount },
          data: { resetCount: before.resetCount + 1, resetRequestedAt: new Date() },
        });
        if (!claim || claim.count !== 1) return refuse(step, providerFailure("reset_in_flight", maker));
        resetClaimed = true;
        return null;
      },
      afterStep: async (step, result) => {
        if (step === "factory_reset" && resetClaimed) {
          // ⛔ Stays counted when it LEFT for the device: an accepted task, or a write that
          // may have landed (a wiping device stops answering). A definite refusal — nothing
          // reached the device — gives the claim back, guarded on the count this request set.
          const mayHaveLanded = result.ok || result.code === "gdms_write_uncertain_check_again";
          if (mayHaveLanded) {
            await db.deskPhoneSetupPhone.update({
              where: { id: row.id },
              data: {
                state: "WAITING_FOR_REBOOT",
                attempts: before.attempts + 1,
                // The old provider's address is gone from a wiped device.
                provisioningUrl: null,
              },
            });
          } else {
            await db.deskPhoneSetupPhone.updateMany({
              where: { id: row.id, resetCount: before.resetCount + 1 },
              data: { resetCount: before.resetCount, resetRequestedAt: before.resetRequestedAt },
            });
          }
        }
        await auditStep(deps, user, row, provider, step, result);
      },
    };

    // ⛔ A reset is the LAST thing sent in this request: a wiping phone cannot take its
    // settings or a restart. Those run on the next prepare, once it is back online (the
    // reset is then spent, so the plan carries no second one).
    const resetAt = plan.steps.findIndex((s) => s.step === "factory_reset");
    const sentNow = resetAt >= 0 ? { ...plan, steps: plan.steps.slice(0, resetAt + 1) } : plan;
    const afterReset = resetAt >= 0 ? plan.steps.slice(resetAt + 1).map((s) => s.step) : [];

    const prepared = await provider.prepare({
      mac: String(row.macAddress),
      serialNumber: cleanSerialNumber(row.serialNumber),
      deviceName: row.displayName ?? null,
      plan: sentNow,
      resetAuthorization: approvedAt
        ? { runId: run.id, phoneId: row.id, approvedAtMs: new Date(approvedAt).getTime() }
        : null,
      hooks,
    });
    ran.push(...prepared.ran);
    return respond(prepared.stoppedAt, [...prepared.leftForOthers, ...afterReset]);
  });

  /* ── Loopcom staff: the Grandstream GDMS credentials ─────────────────────── */

  /** Masked hints only — never a value. */
  app.get("/admin/desk-phones/gdms-credentials", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    return reply.send({ ok: true, credentials: await describeGdmsCredentials(db) });
  });

  /** Save (or clear) the credentials. ⛔ Write-only: the response carries hints, the audit carries none of the values. */
  app.post("/admin/desk-phones/gdms-credentials", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const body = z.object({
      clear: z.boolean().optional(),
      region: z.string().max(8).optional(),
      apiId: z.string().max(200).optional(),
      secretKey: z.string().max(300).optional(),
      username: z.string().max(200).optional(),
      password: z.string().max(300).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const cleared = body.data.clear === true;
    let value = null;
    if (!cleared) {
      const check = validateGdmsCredentials(body.data);
      if (!check.ok) return reply.status(400).send({ ok: false, error: "invalid_credentials", message: check.message });
      value = check.value;
    }
    try {
      await storeGdmsCredentials(db, value, user.email || user.sub);
    } catch (err: any) {
      if (String(err?.message) === "credentials_master_key_missing") {
        return reply.status(503).send({
          ok: false, error: "credentials_master_key_missing",
          message: "Credentials can't be stored securely on this server yet — its encryption key isn't set. Nothing was saved.",
        });
      }
      return reply.status(500).send({ ok: false, error: "store_failed", message: "The credentials couldn't be saved. Nothing was changed." });
    }
    const described = await describeGdmsCredentials(db);
    await deps.audit({
      tenantId: user.tenantId,
      action: cleared ? "GDMS_CREDENTIALS_CLEARED" : "GDMS_CREDENTIALS_SAVED",
      entityType: "PlatformIntegration",
      entityId: "gdms",
      actorUserId: user.sub,
      metadata: { region: described.region, apiIdHint: described.apiIdHint },
    });
    return reply.send({ ok: true, credentials: described });
  });

  /** Read-only proof the saved credentials work: a token plus one list call. Changes nothing at GDMS. */
  app.post("/admin/desk-phones/gdms-credentials/verify", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    try {
      assertGdmsRuntimeMode(process.env);
    } catch (err) {
      const f = failureFromError(err, "Grandstream");
      return reply.status(409).send({ ok: false, error: f.code, message: f.staffMessage });
    }
    const creds = await resolveGdmsCredentials(db);
    if (!creds) return reply.status(409).send({ ok: false, error: "cloud_not_configured", message: "No GDMS credentials are saved." });
    try {
      const out = await new GdmsClient(creds, deps.gdmsRequest ?? fetch).verify();
      await deps.audit({
        tenantId: user.tenantId, action: "GDMS_CREDENTIALS_VERIFIED",
        entityType: "PlatformIntegration", entityId: "gdms", actorUserId: user.sub,
        metadata: { organizations: out.organizations },
      });
      return reply.send({ ok: true, organizations: out.organizations });
    } catch (err) {
      const f = failureFromError(err, "Grandstream");
      await deps.audit({
        tenantId: user.tenantId, action: "GDMS_CREDENTIALS_VERIFY_FAILED",
        entityType: "PlatformIntegration", entityId: "gdms", actorUserId: user.sub,
        metadata: { code: f.code },
      });
      return reply.status(f.retryable ? 503 : 409).send({ ok: false, error: f.code, message: f.staffMessage });
    }
  });

  /**
   * Read-only: does GDMS know this one device? The first live proof that the saved account
   * and the field names are right. ⛔ Looks only — never adds, restarts or resets anything.
   */
  app.post("/admin/desk-phones/gdms-credentials/lookup", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const parsed = z.object({ mac: z.string().max(40) }).safeParse(req.body ?? {});
    const mac = parsed.success ? normalizeMac(parsed.data.mac) : null;
    if (!mac) return reply.status(400).send({ ok: false, error: "invalid_mac", message: "Enter the device's hardware (MAC) address." });
    try {
      assertGdmsRuntimeMode(process.env);
    } catch (err) {
      const f = failureFromError(err, "Grandstream");
      return reply.status(409).send({ ok: false, error: f.code, message: f.staffMessage });
    }
    const creds = await resolveGdmsCredentials(db);
    if (!creds) return reply.status(409).send({ ok: false, error: "cloud_not_configured", message: "No GDMS credentials are saved." });
    try {
      const d = await new GdmsClient(creds, deps.gdmsRequest ?? fetch).findDevice(mac);
      await deps.audit({
        tenantId: user.tenantId, action: "GDMS_DEVICE_LOOKUP",
        entityType: "PlatformIntegration", entityId: "gdms", actorUserId: user.sub,
        metadata: { mac, found: Boolean(d) },
      });
      if (!d) return reply.send({ ok: true, found: false });
      return reply.send({
        ok: true, found: true,
        device: { model: d.model ?? null, online: d.online ?? null, firmware: d.firmware ?? null, serialTail: serialTail(d.serialNumber ?? null) },
      });
    } catch (err) {
      const f = failureFromError(err, "Grandstream");
      await deps.audit({
        tenantId: user.tenantId, action: "GDMS_DEVICE_LOOKUP_FAILED",
        entityType: "PlatformIntegration", entityId: "gdms", actorUserId: user.sub,
        metadata: { mac, code: f.code },
      });
      return reply.status(f.retryable ? 503 : 409).send({ ok: false, error: f.code, message: f.staffMessage });
    }
  });

  /* ── THE CUSTOMER'S SCAN LINK ────────────────────────────────────────────────
   * Izzy, 2026-09-16: "they open the link, and it would open to a camera … scan 1,
   * scan 2, scan 3, and the system will already match it to where it's supposed to go."
   *
   * ⛔⛔ THE SAME ONE GATE. Every label that arrives here goes through `recordLabel`
   * exactly as a typed, uploaded or texted one does. This is a new DOOR, never a
   * second set of rules — a second copy is how one door comes to accept what another
   * refuses, which on this screen means a serial attached to the wrong handset.
   * ⛔ The token is the whole credential (hashed at rest, one run, revocable), so
   * every read and write below is scoped to that run and answers the CUSTOMER
   * projection only — never the technician's view.
   * ⛔ BRAND-AGNOSTIC BY THE STICKER, not by a brand the customer picks: the MAC on
   * the barcode names the maker through `manufacturerFromOui`, which covers exactly
   * the makers we are approved for (grandstream | yealink | fanvil | poly) and says
   * "other"/"unknown" honestly for anything else.
   * ────────────────────────────────────────────────────────────────────────── */

  const hashScanToken = (raw: string) => createHash("sha256").update(String(raw)).digest("hex");

  /** The run behind a link, or null for missing / revoked / expired — never says which. */
  async function scanLink(rawToken: unknown): Promise<{ row: any; run: any } | null> {
    const raw = String(rawToken ?? "");
    if (!raw || raw.length < 20 || raw.length > 200) return null;
    const row = await db.deskPhoneScanToken.findUnique({ where: { tokenHash: hashScanToken(raw) } });
    if (!row || row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
    const run = await db.deskPhoneSetupRun.findFirst({ where: { id: row.runId, tenantId: row.tenantId } });
    if (!run) return null;
    return { row, run };
  }

  /**
   * ⛔ The actor for a customer scan is the PERSON WHO MINTED THE LINK. Two reasons,
   * both deliberate: the audit's actor must be a real user row, and "who put this link
   * in a customer's hands" is the accountable party. It is never a super-admin, so
   * `isSuper` is false and the staff-only projection stays closed.
   * ⛔ The audit's `via` is the ordinary `photo` / `typed_or_scanned` of the one gate —
   * a customer scan is NOT a separate kind of evidence and must not claim to be. That a
   * label arrived through a customer link is recoverable from this actor plus the link's
   * own `scanCount` / `lastUsedAt`, which are the rows that actually record it.
   */
  const scanActor = (row: any): JwtUser =>
    ({ sub: String(row.createdByUserId), tenantId: String(row.tenantId), email: "", role: "USER" });

  /** What the customer may see about one phone — the customer projection, plus done-ness. */
  const scanPhoneView = (p: any) => ({ ...customerPhoneView(p), done: Boolean(p.serialNumber) });

  /**
   * ⛔ Round 21 follow-up (2026-09-17): the CSP fix makes the on-device decoder run again,
   * but nothing before this told us WHICH path a customer actually got — the round-20
   * checklist proved the wasm FILE downloaded, not that it ran, and that gap is exactly
   * what hid the CSP break for a full day. `recordLabel` already writes ONE audit per
   * label and its signature is shared by typed/photo/scan-link doors alike — bolting a
   * `mode` field onto it would touch every caller for one door's telemetry. This is a
   * SECOND, tiny, telemetry-only audit, deliberately never a gate: it never changes what
   * a scan does, only what production tells us it did.
   * ⛔ Deduped IN MEMORY, at most once per token per hour — a customer scanning a dozen
   * stickers on the fast path must not write a dozen near-identical audit rows.
   */
  const scanModeAuditedAt = new Map<string, number>();
  const SCAN_MODE_AUDIT_INTERVAL_MS = 60 * 60_000;
  async function auditScanMode(link: { row: any }, mode: "device" | "photo"): Promise<void> {
    const tokenId = String(link.row.id);
    const now = Date.now();
    const last = scanModeAuditedAt.get(tokenId);
    if (last && now - last < SCAN_MODE_AUDIT_INTERVAL_MS) return;
    scanModeAuditedAt.set(tokenId, now);
    await deps.audit({
      tenantId: String(link.row.tenantId),
      action: "DESK_PHONE_SCAN_MODE",
      entityType: "DeskPhoneScanToken",
      entityId: tokenId,
      actorUserId: String(link.row.createdByUserId),
      metadata: { mode, tokenId },
    }).catch(() => null);
  }

  /** GET the link: which phones this order has, and which are already scanned. */
  app.get("/phone-setup/:token", async (req: any, reply: any) => {
    const link = await scanLink(req.params.token);
    if (!link) return reply.status(404).send({ ok: false, error: "link_not_found", message: "This link is no longer active. Ask Loopcom for a new one." });
    const [tenant, phones] = await Promise.all([
      db.tenant.findUnique({ where: { id: link.row.tenantId } }),
      db.deskPhoneSetupPhone.findMany({ where: { runId: link.run.id, tenantId: link.row.tenantId }, orderBy: { createdAt: "asc" } }),
    ]);
    if (!link.row.firstOpenedAt) {
      await db.deskPhoneScanToken.update({ where: { id: link.row.id }, data: { firstOpenedAt: new Date() } }).catch(() => null);
    }
    const wanted = phones.filter((p: any) => !p.skippedAt);
    return reply.send({
      ok: true,
      company: tenant?.name ?? null,
      total: wanted.length,
      scanned: wanted.filter((p: any) => p.serialNumber).length,
      phones: wanted.map(scanPhoneView),
      // ⛔ Lets the page know THIS server can judge decoded barcode TEXT (the fast,
      // on-device path added round 20). An older server that predates this field never
      // sends it — the page treats anything but an explicit `false` as support, so a
      // server would have to opt OUT, never silently drop out by being older.
      decoderExpected: true,
    });
  });

  /**
   * A camera frame. We decode it, read the hardware address off the sticker, and find
   * WHICH phone of this order it belongs to — the customer never picks from a list.
   * ⛔ Unknown MAC = an honest refusal, never attached to "the next" phone.
   */
  app.post("/phone-setup/:token/scan", async (req: any, reply: any) => {
    const link = await scanLink(req.params.token);
    if (!link) return reply.status(404).send({ ok: false, error: "link_not_found", message: "This link is no longer active. Ask Loopcom for a new one." });
    if (!req.isMultipart?.()) return reply.status(400).send({ ok: false, error: "multipart_required" });

    const phones = await db.deskPhoneSetupPhone.findMany({
      where: { runId: link.run.id, tenantId: link.row.tenantId },
    });
    const inOrder = new Map<string, any>(phones.filter((p: any) => !p.skippedAt).map((p: any) => [String(p.macAddress), p]));

    let file: any = null;
    try { file = await req.file({ limits: { fileSize: MAX_LABEL_PHOTO_BYTES } }); }
    catch (err: any) { return reply.status(400).send({ ok: false, error: "multipart_parse_failed", detail: err?.message }); }
    if (!file) return reply.status(400).send({ ok: false, error: "file_required" });
    const buffer = await file.toBuffer();
    if (!buffer?.length) return reply.status(400).send({ ok: false, error: "file_required" });
    // ⛔ Read AFTER toBuffer(): busboy parses multipart in stream order, so a "mode"
    // field placed after "file" in the form only shows up in `file.fields` once the
    // file part has been fully consumed (the package's own README warns of this).
    // Optional and telemetry-only — an absent or unrecognised value just means an
    // older page build, and the scan itself is judged exactly the same either way.
    const modeField = file.fields?.mode;
    const modeRaw = typeof modeField === "object" && modeField ? modeField.value : modeField;
    const mode: "device" | "photo" = modeRaw === "device" ? "device" : "photo";
    await auditScanMode(link, mode);

    // A pass is worth submitting when it yields a hardware address belonging to THIS
    // order — the match-by-MAC form of the single-phone preview used by the other doors.
    const looksGood = (raw: string, _confidence: number) => {
      const seen = parseDeviceLabel(labelTextFromPhoto(raw));
      return Boolean(seen.mac && inOrder.has(seen.mac));
    };
    const read = await readLabelPhoto(buffer, String(file.mimetype || ""), String(file.filename || "scan.jpg"), looksGood);
    if (!read.ok) return reply.status(read.status).send({ ok: false, error: read.error, message: read.message });

    const text = labelTextFromPhoto(read.text);
    const seen = parseDeviceLabel(text);
    if (!seen.mac) {
      return reply.status(400).send({ ok: false, error: "photo_unreadable", message: PHOTO_UNREADABLE });
    }
    const phone = inOrder.get(seen.mac);
    if (!phone) {
      // Name the maker anyway — "a Grandstream we don't have on this order" is a far
      // more useful sentence than "unknown phone", and the OUI gives it for free.
      const maker = manufacturerFromOui(seen.mac).manufacturer;
      const makerWord = MAKER_NAMES[maker] ?? null;
      return reply.status(409).send({
        ok: false, error: "phone_not_in_order",
        message: makerWord
          ? `That ${makerWord} isn't one of the phones on this order. Scan one of the phones we sent you.`
          : "That phone isn't one of the phones on this order. Scan one of the phones we sent you.",
      });
    }

    const actor = scanActor(link.row);
    const outcome = await recordLabel(actor, phone, text, "photo", read.confidence, { pass: read.pass, passesRun: read.passesRun }, req);
    if (!outcome.ok) {
      return reply.status(outcome.status).send({ ok: false, error: outcome.error, message: outcome.message });
    }
    await db.deskPhoneScanToken.update({
      where: { id: link.row.id },
      data: { lastUsedAt: new Date(), scanCount: { increment: 1 } },
    }).catch(() => null);

    const after = await db.deskPhoneSetupPhone.findMany({ where: { runId: link.run.id, tenantId: link.row.tenantId } });
    const wanted = after.filter((p: any) => !p.skippedAt);
    const updated = wanted.find((p: any) => p.id === phone.id) ?? phone;
    const maker = manufacturerFromOui(seen.mac).manufacturer;
    return reply.send({
      ok: true, matched: true,
      phone: scanPhoneView(updated),
      maker, makerLabel: MAKER_NAMES[maker] ?? null,
      total: wanted.length,
      scanned: wanted.filter((p: any) => p.serialNumber).length,
    });
  });

  /**
   * Decoded barcode VALUES from the customer's browser — the fast path (Izzy, 2026-09-16:
   * "It needs to scan very efficiently right away"). The page runs the SAME zxing engine
   * on-device at several attempts per second, so a decode lands in one round trip instead
   * of a JPEG upload every 1.5s. ⛔ THE BROWSER IS A READER, NEVER A JUDGE: the values are
   * re-shaped by the same rule as the photo path (labelTextsFromSymbols), re-parsed, matched
   * by hardware address against THIS order, and pushed through the one gate exactly like
   * every other door. A forged or garbled value ends at the same refusals.
   */
  app.post("/phone-setup/:token/scan-text", async (req: any, reply: any) => {
    const link = await scanLink(req.params.token);
    if (!link) return reply.status(404).send({ ok: false, error: "link_not_found", message: "This link is no longer active. Ask Loopcom for a new one." });
    const body = z.object({
      texts: z.array(z.string().trim().min(1).max(64)).min(1).max(8),
      // ⛔ Telemetry only (round 21 follow-up) — this door IS the device path by
      // construction, so "photo" here would be a lying client, not a different judge.
      mode: z.enum(["device", "photo"]).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ ok: false, error: "invalid_request" });
    await auditScanMode(link, body.data.mode === "photo" ? "photo" : "device");

    const lines = labelTextsFromSymbols(body.data.texts);
    const text = labelTextFromPhoto(lines.join("\n"));
    const seen = parseDeviceLabel(text);
    // No hardware address yet — the normal state while symbols arrive one at a time.
    // Silent on the page, exactly like a not-yet-readable photo.
    if (!seen.mac) return reply.status(400).send({ ok: false, error: "nothing_matched_yet" });

    const phones = await db.deskPhoneSetupPhone.findMany({
      where: { runId: link.run.id, tenantId: link.row.tenantId },
    });
    const inOrder = new Map<string, any>(phones.filter((p: any) => !p.skippedAt).map((p: any) => [String(p.macAddress), p]));
    const phone = inOrder.get(seen.mac);
    if (!phone) {
      const maker = manufacturerFromOui(seen.mac).manufacturer;
      const makerWord = MAKER_NAMES[maker] ?? null;
      return reply.status(409).send({
        ok: false, error: "phone_not_in_order",
        message: makerWord
          ? `That ${makerWord} isn't one of the phones on this order. Scan one of the phones we sent you.`
          : "That phone isn't one of the phones on this order. Scan one of the phones we sent you.",
      });
    }

    // ⛔ via "typed_or_scanned": a barcode scanner's output, which is literally what this is.
    const outcome = await recordLabel(scanActor(link.row), phone, text, "typed_or_scanned", null, undefined, req);
    if (!outcome.ok) return reply.status(outcome.status).send({ ok: false, error: outcome.error, message: outcome.message });
    await db.deskPhoneScanToken.update({
      where: { id: link.row.id }, data: { lastUsedAt: new Date(), scanCount: { increment: 1 } },
    }).catch(() => null);

    const after = await db.deskPhoneSetupPhone.findMany({ where: { runId: link.run.id, tenantId: link.row.tenantId } });
    const wanted = after.filter((p: any) => !p.skippedAt);
    const updated = wanted.find((p: any) => p.id === phone.id) ?? phone;
    const maker = manufacturerFromOui(seen.mac).manufacturer;
    return reply.send({
      ok: true, matched: true,
      phone: scanPhoneView(updated),
      maker, makerLabel: MAKER_NAMES[maker] ?? null,
      total: wanted.length,
      scanned: wanted.filter((p: any) => p.serialNumber).length,
    });
  });

  /** Typed fallback for a phone with no usable camera — same gate, same refusals. */
  app.post("/phone-setup/:token/phones/:phoneId/label", async (req: any, reply: any) => {
    const link = await scanLink(req.params.token);
    if (!link) return reply.status(404).send({ ok: false, error: "link_not_found", message: "This link is no longer active. Ask Loopcom for a new one." });
    const body = z.object({ text: z.string().trim().min(1).max(600) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ ok: false, error: "invalid_request" });
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: link.run.id, tenantId: link.row.tenantId },
    });
    if (!phone) return reply.status(404).send({ ok: false, error: "not_found" });

    const outcome = await recordLabel(scanActor(link.row), phone, body.data.text, "typed_or_scanned", null, undefined, req);
    if (!outcome.ok) return reply.status(outcome.status).send({ ok: false, error: outcome.error, message: outcome.message });
    await db.deskPhoneScanToken.update({
      where: { id: link.row.id }, data: { lastUsedAt: new Date(), scanCount: { increment: 1 } },
    }).catch(() => null);
    return reply.send(outcome.body);
  });

  /* ── minting the link (STAFF, JWT-gated) ─────────────────────────────────── */

  /** Create (or replace) the customer link for a run. Returns the URL once — we store only its hash. */
  app.post("/desk-phones/runs/:id/scan-link", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    // ⛔ One live link per run: minting again revokes the old one, so a link that was
    // sent to the wrong person stops working the moment a new one is made.
    await db.deskPhoneScanToken.updateMany({
      where: { runId: run.id, tenantId: user.tenantId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    const raw = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000);
    await db.deskPhoneScanToken.create({
      data: { tenantId: user.tenantId, runId: run.id, tokenHash: hashScanToken(raw), createdByUserId: user.sub, expiresAt },
    });
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_SCAN_LINK_CREATED",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
      metadata: { expiresAt: expiresAt.toISOString() },
    });
    return reply.send({ ok: true, url: `${canonicalPortalOrigin()}/phone-setup/${raw}`, expiresAt: expiresAt.toISOString() });
  });

  /** Kill the link. */
  app.post("/desk-phones/runs/:id/scan-link/revoke", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const out = await db.deskPhoneScanToken.updateMany({
      where: { runId: run.id, tenantId: user.tenantId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_SCAN_LINK_REVOKED",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub, metadata: { revoked: out.count },
    });
    return reply.send({ ok: true, revoked: out.count });
  });
}
