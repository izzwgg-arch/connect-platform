/**
 * Desk phone setup — the head that decides, above the hands that do.
 *
 * ⛔⛔ THE DESKTOP APP NEVER DECIDES ANYTHING. It discovers, it performs one named
 * operation, it reports. Every judgement — may this phone be touched, may it be
 * wiped, what happens next, what the customer is told — is made here, where the
 * customer, the permissions and the audit trail live. That split is what makes a
 * compromised office machine unable to invent an action, and it is why `advance`
 * returns an instruction rather than taking one.
 *
 * ⛔ Every route resolves the customer from the signed session. Nothing reads a
 * tenant from a request body. The one route that takes a tenant id at all is the
 * Loopcom-admin one, and it is staff-only.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { userHasActionPermission } from "../permissionGates";
import {
  buildButtonLayout, serializeButtonLayout, customerStateFor, decideReset, formatMac,
  guessVendorFromMac, isTerminal, nextEscalation, normalizeMac, sanitizeDeviceText,
  summarizeRun, vendorCanBeDrivenLocally, vendorSupportsPbxProvisioning,
  pnpArmList, planPhoneRetry, retryClears, retryableCount, inheritedResetCount,
  identifyPhone,
  describeDeviceType, describeProvisioningStatus, identifyDevice, provisioningStatusFor,
  deviceMechanismsFor, manufacturerFromText,
  type DeviceType, type PhoneCondition, type PhoneState, type ProviderReadiness,
} from "@connect/shared";
import { listPbxProvisionedPhones, resolvePbxTenantNumber, type PbxProvisionedPhone } from "../pbxPhoneProvisioning";
import { ensureProvisioningRecord, type RecordOutcome, type RecordQuery } from "./provisioningRecordWriter";
import { resolvePbxRouteHelperConfig } from "@connect/integrations";
import { consoleSavePhone } from "../pbxInboundRouteHelperClient";
import { connectOmbutelMysql } from "../pbxQueueDirectory";
import { clientIpFromForwardedFor } from "../loginThrottle";
import { addEvidence, cloudStateFromRow, evidenceForRow, identityColumns, reportedEvidence, sanitizeEvidence } from "./deviceIdentityStore";
import { createDeviceProviderRegistry, type DeviceProviderRegistry } from "./deviceProviderRegistry";
import { registerDeviceCloudRoutes } from "./deviceCloudRoutes";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };
const getUser = (req: any): JwtUser => req.user as JwtUser;

/**
 * The public address the customer's own computer reached us from: the LAST
 * X-Forwarded-For entry, because earlier entries are whatever the client sent.
 * null when unknown — which the record-move rule treats as unprovable, never as a match.
 */
const requesterIpOf = (req: any): string | null => {
  const ip = clientIpFromForwardedFor(req?.headers?.["x-forwarded-for"]);
  return ip && ip !== "unknown" ? ip : null;
};

export type DeskPhoneDeps = {
  audit: (p: {
    tenantId: string; action: string; entityType: string; entityId: string;
    actorUserId?: string; metadata?: Record<string, unknown> | null;
  }) => Promise<void>;
  /** Hosts whose provisioning addresses count as ours. */
  ourProvisioningHosts: () => string[];
  /** Ask Asterisk whether an endpoint is genuinely registered. */
  isRegistered?: (tenantId: string, extNumber: string) => Promise<boolean>;
  /** Where the PBX serves its installed handset photos, or null when unknown. */
  phoneImageBase?: () => string | null;
  /**
   * The tenant's phones AS THE PBX HAS THEM RECORDED (mac -> model + the person's
   * name), used to NAME what the scan found and to list the phones the system
   * already runs that the scan could not see. Optional and injectable for tests;
   * when absent the in-module default reads the PBX's provisioning records
   * through the read-only connect_read user. ⛔ Best-effort EVERYWHERE it is
   * consumed — a PBX that cannot be read must never fail a discovery ingest.
   */
  provisionedPhones?: (tenantId: string) => Promise<PbxProvisionedPhone[]>;
  /**
   * The tenant's provisioning FOLDER on the PBX — the one URL a factory-reset
   * phone needs (`https://<pbx>/phoneprov/<ombu_tenants.path>/`). Handed to the
   * office machine with the `set_provisioning` instruction; the desktop fences it
   * to a Loopcom PBX before sending it to a phone. Optional and injectable; the
   * default reads `ombu_tenants.path` through the read-only connect_read user.
   * ⛔ Best-effort: no URL means the instruction goes out without one and the
   * driver waits, never a wrong URL.
   */
  provisioningUrlFor?: (tenantId: string) => Promise<string | null>;
  /** Override the phoneprov config fetch (tests). Falls back to fetching cfg<mac>.xml over HTTP. */
  renderDeviceConfig?: (tenantId: string, mac: string) => Promise<string | null>;
  /**
   * Make the PBX hold the `provisioning.devices` row this phone needs, at the moment
   * the person says whose phone it is.
   *
   * ⛔⛔ THIS IS WHAT BREAKS THE CHICKEN AND EGG. The standing PnP responder answers a
   * phone only when its hardware address is already recorded, so without this the
   * wizard could RE-POINT a phone the PBX knew and could never FINISH a new one —
   * which is why Izzy's factory-reset Yealink multicast its SUBSCRIBE exactly as
   * designed and was met with silence.
   *
   * ⛔ Best-effort, always. Assigning a phone is a thing a PERSON did; it must not
   * fail because the phone system is unreachable. Every failure comes back as a
   * reason written onto the row, so the screen says what is missing.
   */
  ensureRecord?: (args: {
    tenantId: string;
    mac: string;
    vendor: string | null;
    model: string | null;
    extNumber: string;
    /** Where our own scan saw the handset on the customer's LAN. */
    discoveredIp?: string | null;
    /** The public address the customer's computer reached us from (last XFF entry). */
    requesterIp?: string | null;
  }) => Promise<RecordOutcome>;
  /**
   * The makers' device clouds (Grandstream GDMS, Yealink RPS, Fanvil, Poly). Injectable
   * for tests; the default builds the real adapters, which answer "not configured"
   * honestly until credentials exist. ⛔ The wizard never branches on a brand — it asks
   * this registry for the provider that matches what was DISCOVERED.
   */
  deviceProviders?: DeviceProviderRegistry;
  /** Serializes claims for one hardware address across customers and api processes. */
  withMacLock?: <T>(key: string, fn: (tx: any) => Promise<T>) => Promise<T>;
  /** Transport for the GDMS credential check; tests inject the simulator. */
  gdmsRequest?: typeof fetch;
};

/**
 * The base of every tenant folder. `PBX_PHONEPROV_BASE_URL` when set, else the
 * origin the handset PHOTOS are already served from (`PBX_PHONE_IMAGE_BASE`, set
 * in production) plus `/phoneprov`, else null. A phone fetches
 * `<base>/<folder>/<mac>.cfg` — the exact path a registered handset in the same
 * office fetches today.
 */
export function phoneprovBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = String(env.PBX_PHONEPROV_BASE_URL ?? "").trim().replace(/\/+$/, "");
  if (explicit) return explicit;
  const images = String(env.PBX_PHONE_IMAGE_BASE ?? "").trim();
  if (!images) return null;
  try { return `${new URL(images).origin}/phoneprov`; } catch { return null; }
}

/** The folder URL, or null unless the folder is exactly the PBX's 16-hex tenant path. */
export function buildPhoneprovUrl(base: string | null, tenantPath: unknown): string | null {
  if (!base) return null;
  const folder = String(tenantPath ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(folder)) return null;
  return `${base.replace(/\/+$/, "")}/${folder}/`;
}

const provisioningUrlCache = new Map<string, { url: string | null; at: number }>();
const PROVISIONING_URL_CACHE_MS = 10 * 60_000;

async function defaultProvisioningUrlFor(tenantId: string): Promise<string | null> {
  const hit = provisioningUrlCache.get(tenantId);
  if (hit && Date.now() - hit.at < PROVISIONING_URL_CACHE_MS) return hit.url;
  let url: string | null = null;
  try {
    const base = phoneprovBaseUrl();
    const link = await db.tenantPbxLink.findUnique({ where: { tenantId } });
    const pbxTenant = resolvePbxTenantNumber(link as any);
    if (base && link?.pbxInstanceId && pbxTenant) {
      const instance = await db.pbxInstance.findUnique({ where: { id: link.pbxInstanceId } });
      const connected = await connectOmbutelMysql((instance as any)?.ombuMysqlUrlEncrypted);
      if (connected.ok) {
        try {
          const [rows] = (await connected.conn.query(
            "SELECT path FROM ombutel.ombu_tenants WHERE tenant_id = ? LIMIT 1", [pbxTenant],
          )) as unknown as [Array<{ path?: string }>];
          url = buildPhoneprovUrl(base, rows?.[0]?.path);
        } finally {
          try { await connected.conn.end(); } catch { /* best-effort */ }
        }
      }
    }
  } catch {
    url = null;
  }
  // ⛔ Only a FOUND folder is cached. A miss is retried next time — a PBX blip must
  // not silence the instruction for ten minutes.
  if (url) provisioningUrlCache.set(tenantId, { url, at: Date.now() });
  return url;
}

/**
 * Default provisionedPhones: Connect tenant -> TenantPbxLink -> PbxInstance ->
 * provisioning.devices (the lan-phones comparison's exact resolution chain).
 * Returns [] on ANY failure — names are decoration on this path, the phone list
 * is the feature.
 */
/**
 * Is this extension's DESK endpoint registered, from the api's own live mirror
 * (`PbxEndpointRegistration`, upserted by the PBX's contact-status pushes).
 *
 * ⛔⛔ THE DEP EXISTED AND WAS NEVER WIRED IN PRODUCTION — server.ts passed no
 * `isRegistered`, so `advance` skipped its Asterisk question and registeredToUs
 * was ALWAYS false: the wizard could never turn a phone green, and a
 * factory-reset phone kept reading as its old self (found live 2026-08-25 when
 * Izzy reset his own ext 103 to test and "it's still showing the same"). This
 * default makes the optional dep real; tests still inject their own.
 *
 * ⛔ The DESK endpoint (`T<n>_<ext>`), never `_1` — the app registering must not
 * make a blank desk phone read as connected.
 */
async function defaultIsRegistered(tenantId: string, extNumber: string): Promise<boolean> {
  try {
    const link = await db.tenantPbxLink.findUnique({ where: { tenantId } });
    const n = resolvePbxTenantNumber(link as any);
    if (!n) return false;
    const row = await db.pbxEndpointRegistration.findUnique({ where: { endpoint: `T${n}_${extNumber}` } });
    return row?.status === "REGISTERED";
  } catch {
    return false;
  }
}

/**
 * One claim per hardware address at a time, platform-wide: the same Postgres advisory
 * lock shape the managed-phone service uses, so two customers (or two api processes
 * during a blue/green cutover) can never both register the same device.
 */
async function defaultWithMacLock<T>(key: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return (db as any).$transaction(async (tx: any) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
    return fn(tx);
  }, { timeout: 30_000, maxWait: 5_000 });
}

async function defaultProvisionedPhones(tenantId: string): Promise<PbxProvisionedPhone[]> {
  try {
    const link = await db.tenantPbxLink.findUnique({ where: { tenantId } });
    if (!link?.pbxInstanceId) return [];
    const instance = await db.pbxInstance.findUnique({ where: { id: link.pbxInstanceId } });
    // ⛔ resolvePbxTenantNumber, never Number(pbxTenantCode) — the code is "T2".
    const pbxTenant = resolvePbxTenantNumber(link as any);
    if (!pbxTenant) return [];
    const out = await listPbxProvisionedPhones((instance as any)?.ombuMysqlUrlEncrypted, { pbxTenant });
    return out.available ? out.phones : [];
  } catch {
    return [];
  }
}

/**
 * Write (or adopt) the `provisioning.devices` row for one phone.
 *
 * ⛔ The DECISION is pure and lives in `@connect/shared`; this resolves the two things
 * that cannot be pure — a read-only connection to the PBX and the helper that runs
 * `save_phone` — and hands them to `ensureProvisioningRecord`.
 *
 * ⛔⛔ THE HELPER CONFIG IS RESOLVED FROM THE PBX INSTANCE, NOT FROM A DEFAULT. A
 * `save_phone` aimed at the wrong PBX writes a customer's handset into somebody else's
 * phone system, and the MAC uniqueness rule then makes it unfixable from the wizard.
 */
async function defaultEnsureRecord(args: {
  tenantId: string;
  mac: string;
  vendor: string | null;
  model: string | null;
  extNumber: string;
  discoveredIp?: string | null;
  requesterIp?: string | null;
}): Promise<RecordOutcome> {
  const link = await db.tenantPbxLink.findUnique({ where: { tenantId: args.tenantId } });
  if (!link?.pbxInstanceId) return { kind: "unavailable", detail: "this account is not linked to a phone system" };
  // ⛔ resolvePbxTenantNumber, never Number(pbxTenantCode) — the code is "T2".
  const pbxTenantNumber = resolvePbxTenantNumber(link as any);
  if (!pbxTenantNumber) return { kind: "unavailable", detail: "no PBX tenant number on the link" };
  const instance = await db.pbxInstance.findUnique({ where: { id: link.pbxInstanceId } });
  const cfg = resolvePbxRouteHelperConfig(link.pbxInstanceId);
  if (!cfg) return { kind: "unavailable", detail: "the phone system helper is not configured" };

  // ⛔ ONE connection for the whole read, closed in a finally. Leaking a MySQL
  // connection per assignment is how a helper wedged at 1024 file descriptors before.
  let conn: any = null;
  return ensureProvisioningRecord(
    {
      query: async (): Promise<RecordQuery | null> => {
        const connected = await connectOmbutelMysql((instance as any)?.ombuMysqlUrlEncrypted);
        if (!connected.ok) return null;
        conn = connected.conn;
        return async (sql: string, params: any[] = []) => {
          const [rows] = (await conn.query(sql, params)) as any;
          return (rows ?? []) as any[];
        };
      },
      savePhone: (a) => consoleSavePhone(cfg, a as any),
      auditRehome: async (info) => {
        await db.auditLog.create({
          data: {
            tenantId: args.tenantId,
            action: "DESK_PHONE_RECORD_REHOMED",
            entityType: "desk_phone",
            entityId: info.mac,
            metadata: info as any,
          },
        });
      },
      // ⛔ The live registration mirror, consulted ONLY when a write would move a record
      // off another account: it is the evidence that the other extension is not in use.
      registrations: async (endpoints) => {
        const rows = await db.pbxEndpointRegistration.findMany({
          where: { endpoint: { in: endpoints } },
          select: { endpoint: true, status: true, lastRegisteredAt: true, contactUri: true },
        });
        return rows as any;
      },
    },
    {
      pbxTenantNumber, mac: args.mac, vendor: args.vendor, model: args.model, extNumber: args.extNumber,
      discoveredIp: args.discoveredIp ?? null, requesterIp: args.requesterIp ?? null,
    },
  ).finally(() => {
    try { conn?.end?.(); } catch { /* already gone */ }
  });
}

/**
 * ⛔⛔ ONE PLACE DECIDES WHETHER A PERSON MAY DO THIS, AND IT IS NOT THE ROUTE
 * BODY. Two keys, deliberately separate: running the wizard reads a network and
 * points phones at us; authorising a reset ERASES a customer's device.
 */
async function mayRunSetup(req: any, reply: any): Promise<JwtUser | null> {
  const user = getUser(req);
  if (!user?.tenantId) { reply.status(401).send({ error: "unauthorized" }); return null; }
  if (!(await userHasActionPermission(user, "can_setup_desk_phones"))) {
    reply.status(403).send({ error: "forbidden" }); return null;
  }
  return user;
}

// mayAuthorizeReset() was deleted deliberately. It resolved the caller and checked
// the reset permission in one step, which forced every caller to answer 403 before
// it could answer 404. Use ownRun() then allowedToReset(); do not reintroduce a
// helper that checks a permission before ownership.

/**
 * OWNERSHIP IS CHECKED BEFORE ANYTHING ELSE, AND THAT ORDER IS THE SECURITY
 * PROPERTY. A run that belongs to another customer must be indistinguishable from
 * one that never existed - for EVERY caller, whatever permissions they hold and
 * whatever they put in the body. Checking the permission first answers 403, and
 * validating the body first answers 400; either one tells a stranger their request
 * reached a real endpoint and got further than it should have. Resolve the run
 * scoped to the caller's own tenant, answer 404, and there is nothing to read.
 *
 * Found by the chaos suite, which drove the routes in random orders and caught the
 * 400 and the 403 that used to escape ahead of the 404.
 */
async function ownRun(req: any, reply: any): Promise<{ user: JwtUser; run: any } | null> {
  const user = getUser(req);
  if (!user?.tenantId) { reply.status(401).send({ error: "unauthorized" }); return null; }
  const run = await db.deskPhoneSetupRun.findFirst({
    where: { id: String(req.params.id), tenantId: user.tenantId },
  });
  if (!run) { reply.status(404).send({ error: "not_found" }); return null; }
  return { user, run };
}

/** Permission, asked AFTER ownership. Returns false having already replied. */
async function allowedToSetUp(user: JwtUser, reply: any): Promise<boolean> {
  if (!(await userHasActionPermission(user, "can_setup_desk_phones"))) {
    reply.status(403).send({ error: "forbidden" }); return false;
  }
  return true;
}

async function allowedToReset(user: JwtUser, reply: any): Promise<boolean> {
  if (!(await allowedToSetUp(user, reply))) return false;
  if (!(await userHasActionPermission(user, "can_authorize_phone_reset"))) {
    reply.status(403).send({
      error: "forbidden",
      message: "You are not allowed to clear a phone. Ask somebody who is.",
    });
    return false;
  }
  return true;
}

const isSuper = (user: JwtUser) => String(user?.role || "").toUpperCase() === "SUPER_ADMIN";

/**
 * The live truth beside the record: is this phone's extension registered RIGHT
 * NOW. ⛔ The record says whose phone it IS; only Asterisk says whether it is
 * CONNECTED — a factory-reset phone keeps its name and loses its connection,
 * and a screen showing the first without the second reads as a lie (Izzy's
 * ext-103 reset test, 2026-08-25). Best-effort: null when unknowable.
 */
async function withConnectedNow(
  deps: DeskPhoneDeps, tenantId: string, views: Array<Record<string, unknown> & { extNumber?: string | null }>,
): Promise<Array<Record<string, unknown>>> {
  const isReg = deps.isRegistered ?? defaultIsRegistered;
  return Promise.all(views.map(async (v) => {
    if (!v.extNumber) return { ...v, connectedNow: null };
    try { return { ...v, connectedNow: await isReg(tenantId, String(v.extNumber)) }; }
    catch { return { ...v, connectedNow: null }; }
  }));
}

/** What the customer's screen gets. ⛔ Nothing technical crosses this boundary. */
/**
 * What the wizard is told about the record write, in customer-safe terms.
 *
 * ⛔ NEVER the technical `explain`, the PBX tenant number or the model id. A customer
 * screen must not learn that their handset was recorded under another company — that is
 * an audit fact for us, and it is already written to the audit log.
 */
function recordView(outcome: RecordOutcome | null) {
  if (!outcome) return null;
  switch (outcome.kind) {
    case "written": return { state: "ready" as const, message: null };
    case "adopted": return { state: "ready" as const, message: null };
    case "refused": return { state: "needs_us" as const, message: outcome.customerMessage };
    // ⛔ An unreachable phone system is NOT presented as the customer's problem, and
    // NOT as a failure of the thing they just did. The assignment landed; only the
    // record is pending, and the wizard retries it on its own.
    case "unavailable": return { state: "pending" as const, message: null };
  }
}

const DOTTED_IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A device-reported address is shown only when it really is one. */
function dottedIpv4(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return DOTTED_IPV4.test(s) ? s : null;
}

function customerPhoneView(row: any) {
  const provisioningStatus = provisioningStatusFor({
    phoneState: row.state,
    vendorCloudState: row.vendorCloudState ?? null,
    identityConfidence: row.identityConfidence ?? null,
  });
  return {
    id: row.id,
    // ⛔ The MAC is DELIBERATELY in the customer view since 2026-08-25 — Izzy,
    // testing live at A plus center: "mac addresses should all be displayed."
    // It is the one identifier printed on the sticker under the handset, so it is
    // how a person tells two identical phones apart. The rest of the technical
    // fields (ip, state, provisioningUrl…) stay diagnostic-only.
    mac: row.macAddress ? formatMac(String(row.macAddress)) : null,
    model: row.model || null,
    vendor: row.vendor || null,
    displayName: row.displayName || null,
    extNumber: row.extNumber || null,
    status: customerStateFor(row.state as PhoneState),
    note: row.customerNote || null,
    needsAttention: row.state === "NEEDS_ATTENTION" || row.state === "FAILED",
    // ⛔ Whether the PERSON ticked this phone on the found screen. False = "left
    // exactly as it is": never advanced, never reset, not counted towards done.
    selected: !row.skippedAt,
    // ⛔ 2026-09-14: the card says WHAT was detected — the kind of device, where it sits
    // on the network, and how sure we are — so a person picks a device by what it IS,
    // never by a brand they were asked to choose. Firmware, the serial number and the
    // evidence trail stay in the technician's view.
    ip: dottedIpv4(row.ipAddress),
    // ⛔ Whether the maker's serial number is already on file. The extension screen asks for it on
    // any phone where it is not — ONE question, at the moment the person is already looking at that
    // phone's row, in place of the password prompt that used to interrupt the setup. The number
    // itself stays out of the customer view; only whether we have it.
    serialOnFile: Boolean(row.serialNumber),
    deviceType: row.deviceType || null,
    deviceTypeLabel: row.deviceType && row.deviceType !== "unknown" ? describeDeviceType(row.deviceType as DeviceType) : null,
    identityConfidence: row.identityConfidence || null,
    provisioningStatus,
    provisioningStatusLabel: describeProvisioningStatus(provisioningStatus),
  };
}

/**
 * The phones a run is actually working on: the ones the person did not untick.
 * ⛔ Every summary is built from THIS list, never from every row of the run —
 * otherwise a phone deliberately left alone keeps "finished" false forever and the
 * wizard never reaches its last screen (the "only lets me provision all at once"
 * report, 2026-09-02).
 */
function inSetup<T extends { skippedAt?: Date | null }>(rows: T[]): T[] {
  return rows.filter((r) => !r.skippedAt);
}

/**
 * The technician's view. ⛔ Everything real, and still no secret: passwords and
 * provisioning tokens are never stored on these rows in the first place, so there is
 * no code path here that could print one.
 */
function diagnosticPhoneView(row: any) {
  return {
    ...customerPhoneView(row),
    mac: row.macAddress,
    ip: row.ipAddress || null,
    previousIp: row.previousIp || null,
    firmware: row.firmware || null,
    provisioningUrl: row.provisioningUrl || null,
    state: row.state,
    attempts: row.attempts,
    resetCount: row.resetCount,
    resetRequestedAt: row.resetRequestedAt || null,
    registeredAt: row.registeredAt || null,
    haltedReason: row.haltedReason || null,
    technicalNote: row.technicalNote || null,
    serialNumber: row.serialNumber || null,
    vendorCloudState: row.vendorCloudState || "unchecked",
    vendorCloudCheckedAt: row.vendorCloudCheckedAt || null,
    identification: diagnosticIdentification(row),
  };
}

/**
 * How the identification was reached — every source that described the device, what each
 * contributed, and where they disagreed. ⛔ Technician-only: it names probes and platforms.
 */
function diagnosticIdentification(row: any) {
  const id = identifyDevice({
    mac: String(row.macAddress ?? ""),
    ip: row.ipAddress ?? null,
    evidence: evidenceForRow(row),
    cloud: cloudStateFromRow(row),
  });
  return {
    manufacturer: id.manufacturer,
    model: id.model,
    deviceType: id.deviceType,
    confidence: id.confidence,
    confidenceScore: id.confidenceScore,
    firmware: id.firmware,
    serialNumber: id.serialNumber,
    sources: id.identificationSources,
    conflicts: id.conflicts,
  };
}

const discoveredBody = z.object({
  subnet: z.string().max(64).optional(),
  outcome: z.enum(["ok", "partial", "failed"]).optional(),
  phones: z.array(z.object({
    mac: z.string().min(1),
    ip: z.string().max(64).optional(),
    vendor: z.string().max(80).optional(),
    model: z.string().max(120).optional(),
    firmware: z.string().max(120).optional(),
    provisioningUrl: z.string().max(500).optional(),
    /**
     * Which probe named the device (http_banner | sip_user_agent | http_device_api | none).
     * ⛔ Free text on purpose: an unrecognised value is read as a plain banner, never a
     * reason to refuse the whole discovery.
     */
    identitySource: z.string().max(32).optional(),
    serialNumber: z.string().max(64).optional(),
  })).max(500),
});

/**
 * The phone ids a run's reset approval actually named.
 *
 * ⛔⛔ AN APPROVAL COVERS THE PHONES THE PERSON TICKED, AND NOTHING ELSE. Until
 * 2026-09-14 the ladder read only `run.resetAuthorizedAt`, so approving phone A made a
 * reset "authorised" for every other phone in the same run — including one the person
 * never saw on the clearing screen. Unreadable stored text reads as "nobody approved".
 */
export function approvedResetPhoneIds(run: { resetAuthorizedPhoneIds?: string | null }): string[] {
  try {
    const parsed = JSON.parse(run.resetAuthorizedPhoneIds || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** The approval time as the ladder must see it for THIS phone: null unless it was named. */
export function resetApprovalFor(
  run: { resetAuthorizedAt?: Date | null; resetAuthorizedPhoneIds?: string | null },
  phoneId: string,
): string | null {
  if (!run.resetAuthorizedAt) return null;
  return approvedResetPhoneIds(run).includes(phoneId) ? run.resetAuthorizedAt.toISOString() : null;
}

/**
 * How long a phone we have just told to wipe itself is treated as "restarting".
 * After that the ladder looks at it afresh: the standing PnP listener has been armed for
 * it the whole time, so a phone that came back quickly has already been answered.
 */
export const RESET_REBOOT_WAIT_MS = 120_000;

export async function registerDeskPhoneSetupRoutes(app: FastifyInstance, deps: DeskPhoneDeps) {
  // The makers' device clouds, one registry for the whole wizard (the ladder asks it which
  // mechanism clears and restarts a brand; the cloud routes perform the steps).
  const registry = deps.deviceProviders ?? createDeviceProviderRegistry({ db, request: deps.gdmsRequest });
  // ⛔ Readiness is asked on every advance of a phone whose maker has a cloud provider, and the
  // wizard advances every four seconds. Held briefly; a failure reads as "no cloud", which only
  // ever makes LESS happen (the phone takes the path it took before the cloud existed).
  let readinessCache: { at: number; list: ProviderReadiness[] } | null = null;
  const cloudReadiness = async (): Promise<ProviderReadiness[]> => {
    if (readinessCache && Date.now() - readinessCache.at < 30_000) return readinessCache.list;
    let list: ProviderReadiness[] = [];
    try { list = await registry.allReadiness(); } catch { list = []; }
    readinessCache = { at: Date.now(), list };
    return list;
  };

  /* ── starting ──────────────────────────────────────────────────────────── */

  app.post("/desk-phones/runs", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const body = z.object({ deviceLabel: z.string().max(200).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    // ⛔ One live run per customer. Two wizards racing on the same office would
    // each believe they owned the reset counters, which is exactly how a phone
    // gets wiped twice.
    const existing = await db.deskPhoneSetupRun.findFirst({
      where: { tenantId: user.tenantId, status: "running" },
      orderBy: { startedAt: "desc" },
    });
    if (existing) return reply.send({ ok: true, run: { id: existing.id, resumed: true } });

    const run = await db.deskPhoneSetupRun.create({
      data: {
        tenantId: user.tenantId,
        startedByUserId: user.sub,
        deviceLabel: body.data.deviceLabel || null,
        origin: "customer",
      },
    });
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_SETUP_STARTED",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
    });
    return reply.send({ ok: true, run: { id: run.id, resumed: false } });
  });

  /* ── what the office machine found ─────────────────────────────────────── */

  app.post("/desk-phones/runs/:id/discovered", async (req: any, reply: any) => {
    // Ownership first - see ownRun(). 404 before any 403 or 400.
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const parsed = discoveredBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });
    // ⛔ 404, not 403: a run belonging to another customer must be indistinguishable
    // from one that does not exist.
    if (!run) return reply.status(404).send({ error: "not_found" });

    let stored = 0, dropped = 0;
    for (const p of parsed.data.phones) {
      const mac = normalizeMac(p.mac);
      // ⛔ A phone whose hardware id we cannot read is counted and NOT stored. It
      // could never be matched to a PBX record, so storing it would put a device in
      // the list that is guaranteed to look broken forever.
      if (!mac) { dropped += 1; continue; }
      const existing = await db.deskPhoneSetupPhone.findFirst({ where: { runId: run.id, macAddress: mac } });
      // ⛔ The office machine's fingerprint only knows the vendor when the phone's
      // web page admitted it — a locked phone says nothing, and on the first real
      // customer run (A plus center, 2026-08-25) all six devices stored vendor
      // "unknown" while their hardware addresses had ALREADY identified them (it
      // is the very evidence the discovery filter admitted them on). The MAC
      // block is the fallback, here at the ingest so every submit path gets it.
      const claimedVendor = p.vendor && p.vendor.toLowerCase() !== "unknown" ? p.vendor : null;
      const ouiVendor = guessVendorFromMac(mac).vendor;
      const vendor = claimedVendor ?? (ouiVendor !== "unknown" ? ouiVendor : null);
      const facts = {
        ipAddress: p.ip ? sanitizeDeviceText(p.ip, 64) : null,
        vendor: vendor ? sanitizeDeviceText(vendor, 80) : null,
        model: p.model ? sanitizeDeviceText(p.model, 120) : null,
        firmware: p.firmware ? sanitizeDeviceText(p.firmware, 120) : null,
        provisioningUrl: p.provisioningUrl ? sanitizeDeviceText(p.provisioningUrl, 500) : null,
      };
      // ⛔⛔ IDENTIFICATION (2026-09-14). What the office machine read is ONE source of
      // evidence, kept beside every other source that has described this device — the
      // phone system's record, the maker's cloud, the label, a person. The pipeline names
      // the manufacturer from the hardware address and the MODEL only from evidence, and
      // writes down how sure it is. One row per hardware address per run, so a device seen
      // twice (or at a new address) merges into the same record.
      const observed = reportedEvidence({
        vendor: claimedVendor,
        model: p.model,
        firmware: p.firmware,
        serialNumber: p.serialNumber,
        identitySource: p.identitySource,
      }, new Date().toISOString());
      const identity = identityColumns({
        mac,
        ip: facts.ipAddress,
        evidence: addEvidence(existing ? evidenceForRow(existing) : [], [observed]),
      }).data;
      if (existing) {
        // ⛔ THE ADDRESS MOVING IS EXPECTED, NOT A NEW PHONE. Record where it was.
        const moved = existing.ipAddress && facts.ipAddress && existing.ipAddress !== facts.ipAddress;
        await db.deskPhoneSetupPhone.update({
          where: { id: existing.id },
          data: {
            ...facts,
            // ⛔ A rescan that could not read the model does not erase the one we already
            // had — from an earlier read, the phone system's record, or a person naming it.
            vendor: facts.vendor ?? existing.vendor ?? null,
            model: facts.model ?? existing.model ?? null,
            firmware: facts.firmware ?? existing.firmware ?? null,
            previousIp: moved ? existing.ipAddress : existing.previousIp,
            ...identity,
          },
        });
      } else {
        await db.deskPhoneSetupPhone.create({
          data: { tenantId: user.tenantId, runId: run.id, macAddress: mac, state: "IDENTIFIED", ...facts, ...identity },
        });
      }
      stored += 1;
    }

    await db.deskPhoneSetupRun.update({
      where: { id: run.id },
      data: { subnet: parsed.data.subnet || run.subnet },
    });

    // ── Name what we found, and be honest about what we did not ────────────
    // The PBX's provisioning records are the ground truth of "this hardware IS
    // extension N" — the MAC on the record is exactly what the config file is
    // named after. Matching on it names the phone with the person's own name and
    // fills the model (which is also what puts the handset PHOTO on screen).
    // ⛔ Best-effort, never blocking: a PBX that cannot be read costs the names,
    // never the discovery. ⛔ A row a human already assigned (extensionId set) is
    // never overwritten — the person's explicit choice beats the record.
    let knownElsewhere: Array<{ mac: string; model: string | null; vendor: string | null; name: string | null; extNumber?: string | null }> = [];
    try {
      const lookup = deps.provisionedPhones ?? defaultProvisionedPhones;
      let recorded: PbxProvisionedPhone[] = [];
      try { recorded = await lookup(user.tenantId); } catch { recorded = []; }
      {
        const byMac = new Map(recorded.filter((r) => r.mac).map((r) => [r.mac, r]));
        const rows = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id } });
        const seen = new Set<string>();
        for (const row of rows) {
          seen.add(String(row.macAddress));
          const patch: Record<string, unknown> = {};
          // ⛔ Rows from EARLIER passes too: ARP is ephemeral, so a rescan often
          // resubmits only part of the list — on the first live run 4 of 6 rows
          // kept vendor null because only the resubmitted two went through the
          // ingest fallback. The hardware address does not change; fill it here.
          if (!row.vendor || row.vendor === "unknown") {
            const oui = guessVendorFromMac(String(row.macAddress)).vendor;
            if (oui !== "unknown") patch.vendor = oui;
          }
          const rec = byMac.get(String(row.macAddress));
          if (!rec) {
            if (Object.keys(patch).length) {
              await db.deskPhoneSetupPhone.update({ where: { id: row.id }, data: patch });
            }
            continue;
          }
          if (!row.model && rec.model) patch.model = sanitizeDeviceText(rec.model, 120);
          if ((!row.vendor || row.vendor === "unknown") && rec.brand) {
            patch.vendor = sanitizeDeviceText(rec.brand.toLowerCase(), 80);
          }
          if (!row.extensionId && !row.extNumber) {
            const extNumber = rec.extension || (rec.description && /^\d{2,6}$/.test(rec.description) ? rec.description : null);
            const name = rec.extensionName || rec.description || null;
            if (extNumber) patch.extNumber = sanitizeDeviceText(extNumber, 16);
            if (name) patch.displayName = sanitizeDeviceText(name, 120);
            // The Connect extension row, when exactly this number exists for this
            // customer — the same write a human's assign click makes, sourced from
            // the record that provisioned the phone in the first place.
            if (extNumber) {
              const ext = await db.extension.findFirst({ where: { tenantId: user.tenantId, extNumber } });
              if (ext) {
                patch.extensionId = ext.id;
                if (ext.displayName) patch.displayName = sanitizeDeviceText(ext.displayName, 120);
              }
            }
          }
          // The phone system's record is evidence too — deliberately below the device's
          // own words, because records go stale (three phones on Izzy's desk carried other
          // customers' records). Written only when what the record says has changed.
          const storedEvidence = evidenceForRow(row);
          const recordSays = sanitizeEvidence({
            source: "pbx_provisioning_record",
            manufacturer: rec.brand ? rec.brand.toLowerCase() : null,
            model: rec.model,
            observedAt: new Date().toISOString(),
          });
          const priorRecord = storedEvidence.find((e) => e.source === "pbx_provisioning_record");
          if (recordSays && (!priorRecord || priorRecord.model !== recordSays.model || priorRecord.manufacturer !== recordSays.manufacturer)) {
            Object.assign(patch, identityColumns({
              mac: String(row.macAddress),
              ip: row.ipAddress ?? null,
              evidence: addEvidence(storedEvidence, [recordSays]),
            }).data);
          }
          if (Object.keys(patch).length) {
            await db.deskPhoneSetupPhone.update({ where: { id: row.id }, data: patch });
          }
        }
        // The phones the system ALREADY RUNS that this scan could not see — on a
        // different network in the building, usually. Without this list a six-phone
        // result in a thirteen-phone office reads as "the wizard lost my phones".
        knownElsewhere = recorded
          .filter((r) => r.mac && !seen.has(r.mac))
          .map((r) => ({
            mac: formatMac(r.mac),
            model: r.model,
            vendor: r.brand ? r.brand.toLowerCase() : null,
            name: r.extensionName || r.description || null,
            // The extension, so the response can say whether this phone is
            // CONNECTED right now — "already set up" from a record alone is a
            // lie about a factory-reset or unplugged phone.
            extNumber: r.extension || null,
          }));
      }
    } catch { /* names and context are decoration; discovery already succeeded */ }

    const phones = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    return reply.send({
      ok: true,
      // ⛔ The subnet is always returned, so a short list reads as "here is where we
      // looked" and never as "this office has three phones".
      subnet: parsed.data.subnet || run.subnet || null,
      dropped,
      stored,
      phones: await withConnectedNow(deps, user.tenantId, phones.map(customerPhoneView)),
      knownElsewhere: await withConnectedNow(deps, user.tenantId, knownElsewhere),
    });
  });

  /* ── who sits where ────────────────────────────────────────────────────── */

  app.post("/desk-phones/runs/:id/phones/:phoneId/assign", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const body = z.object({ extensionId: z.string().min(1).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    if (body.data.extensionId === null) {
      // Un-assigning is allowed: a blank row is skipped, never failed.
      const updated = await db.deskPhoneSetupPhone.update({
        where: { id: phone.id },
        data: { extensionId: null, extNumber: null, displayName: null, state: "IDENTIFIED" },
      });
      return reply.send({ ok: true, phone: customerPhoneView(updated) });
    }

    // ⛔ The extension must belong to THIS customer. Without this check a phone
    // could be pointed at another company's extension by id.
    const ext = await db.extension.findFirst({
      where: { id: body.data.extensionId, tenantId: user.tenantId },
    });
    if (!ext) return reply.status(404).send({ error: "extension_not_found" });

    let updated = await db.deskPhoneSetupPhone.update({
      where: { id: phone.id },
      data: {
        extensionId: ext.id, extNumber: ext.extNumber, displayName: ext.displayName,
        state: "ASSIGNED",
      },
    });

    /**
     * ⛔⛔ THE MOMENT THE RECORD BECOMES WRITEABLE, AND THE REASON IT IS HERE.
     * Every input exists for the first time right now: the hardware address (our own
     * scan), the model (the phone's banner or the person's dropdown pick) and the
     * extension they just chose. Before this, the PnP responder only ever answered
     * phones the PBX already knew — so a brand-new phone asked and was met with
     * silence, which is exactly what happened to Izzy's Yealink.
     *
     * ⛔ Wrapped, and it can only ever ADD a note. The person has already made their
     * choice; a phone system that is slow, unreachable or missing a settings profile
     * must not lose it. `skippedAt` is honoured too — a phone somebody deliberately
     * unticked is not written to the PBX at all.
     */
    let record: RecordOutcome | null = null;
    if (!updated.skippedAt && ext.extNumber) {
      try {
        record = await (deps.ensureRecord ?? defaultEnsureRecord)({
          tenantId: user.tenantId,
          mac: phone.macAddress,
          vendor: phone.vendor ?? null,
          model: phone.model ?? null,
          extNumber: String(ext.extNumber),
          discoveredIp: phone.ipAddress ?? null,
          requesterIp: requesterIpOf(req),
        });
      } catch (e: any) {
        record = { kind: "unavailable", detail: e?.message || String(e) };
      }
      try {
        if (record.kind === "refused") {
          updated = await db.deskPhoneSetupPhone.update({
            where: { id: phone.id },
            data: { customerNote: record.customerMessage, technicalNote: record.explain },
          });
        } else if (record.kind === "written" || record.kind === "adopted") {
          // ⛔ The note is CLEARED on success. A stale sentence left on a row that has
          // since been fixed is exactly what made Izzy's second run read identically
          // to his first.
          updated = await db.deskPhoneSetupPhone.update({
            where: { id: phone.id },
            data: { customerNote: null, technicalNote: record.explain },
          });
        }
        if (record.kind === "written" && record.rehomedFromTenant != null) {
          await deps.audit({
            tenantId: user.tenantId,
            action: "DESK_PHONE_RECORD_REHOMED",
            entityType: "desk_phone_setup_phone",
            entityId: phone.id,
            actorUserId: user.sub,
            metadata: { mac: phone.macAddress, fromTenant: record.rehomedFromTenant, extNumber: ext.extNumber },
          });
        }
      } catch { /* the note is a nicety; the assignment is the thing */ }
    }

    return reply.send({ ok: true, phone: customerPhoneView(updated), record: recordView(record) });
  });

  /* ── what IS this phone ────────────────────────────────────────────────── */

  /**
   * THE PERSON TELLS US WHAT THE PHONE IS, OFF THE LABEL ON THE BACK.
   *
   * ⛔⛔ THIS IS THE SENTENCE `planProvisioningRecord` HAS BEEN SAYING SINCE IT SHIPPED:
   * "Tell us the make and model on the back of this phone and we can set it up." There
   * was no way to tell us. A phone whose model our fingerprint could not read had no
   * catalogue row, so no `provisioning.devices` write, so no PnP answer, so a handset
   * asking into silence — permanently, with the wizard printing an instruction nobody
   * could follow.
   *
   * ⛔ A PERSON'S ANSWER BEATS THE FINGERPRINT, because they are holding the thing and
   * reading the label, and our fingerprint is a guess at a banner. What it replaced is
   * written to the audit, so a mis-pick is traceable rather than silent.
   *
   * ⛔ AND IT IS STORED AS THE CATALOGUE SPELLS IT, never as it arrived — `identifyPhone`
   * refuses anything the phone system does not hold rather than letting a guess through.
   * A wrong model renders a settings file the handset silently ignores, which on a desk
   * looks exactly like a dead phone.
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/identify", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const body = z.object({
      /** Optional: the model names the make by itself, so this only ever cross-checks. */
      make: z.string().trim().max(64).nullable().optional(),
      model: z.string().trim().min(1).max(64),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    const picked = identifyPhone({ make: body.data.make ?? null, model: body.data.model });
    if (!picked.ok) {
      // ⛔ 400 with the plain-English reason, never a bare code: this route exists
      // because somebody is trying to help us, and a slug on screen reads as a refusal
      // of them rather than of what they picked.
      return reply.status(400).send({ error: picked.reason, message: picked.message });
    }

    // ⛔ The person's answer is recorded as evidence too, so the identification and its
    // confidence reflect it; the audit below still keeps what it replaced.
    const namedByPerson = sanitizeEvidence({
      source: "manual_entry",
      manufacturer: picked.vendor,
      model: picked.model,
      observedAt: new Date().toISOString(),
    });
    let updated = await db.deskPhoneSetupPhone.update({
      where: { id: phone.id },
      data: {
        vendor: picked.vendor,
        model: picked.model,
        ...identityColumns({
          mac: String(phone.macAddress),
          ip: phone.ipAddress ?? null,
          evidence: addEvidence(evidenceForRow(phone), [namedByPerson]),
        }).data,
      },
    });

    /**
     * ⛔⛔ NAMING THE PHONE IS WHAT UNBLOCKS IT, so the record is re-attempted here — a
     * route that only stored the answer would leave the person having done exactly what
     * was asked and watched nothing happen.
     */
    let record: RecordOutcome | null = null;
    if (!updated.skippedAt && updated.extNumber) {
      try {
        record = await (deps.ensureRecord ?? defaultEnsureRecord)({
          tenantId: user.tenantId,
          mac: phone.macAddress,
          vendor: picked.vendor,
          model: picked.model,
          extNumber: String(updated.extNumber),
          discoveredIp: phone.ipAddress ?? null,
          requesterIp: requesterIpOf(req),
        });
        if (record.kind === "refused") {
          updated = await db.deskPhoneSetupPhone.update({
            where: { id: phone.id },
            data: { customerNote: record.customerMessage, technicalNote: record.explain },
          });
        } else if (record.kind === "written" || record.kind === "adopted") {
          updated = await db.deskPhoneSetupPhone.update({
            where: { id: phone.id },
            data: { customerNote: null, technicalNote: record.explain },
          });
          /**
           * ⛔⛔ AND ONLY THEN IS A STUCK PHONE LET GO ROUND AGAIN — through the SAME
           * rules a person pressing "try again" gets, so this path can no more forgive
           * a reset than that one can. ⛔ Gated on the record having actually landed: a
           * phone released while its record is still refused walks the ladder straight
           * back to the same halt, which is a reboot loop on somebody's desk and is
           * precisely what `TRANSITIONS` refuses to do on its own.
           */
          if (isTerminal(updated.state as PhoneState) && updated.state !== "REGISTERED") {
            const plan = planPhoneRetry({
              state: updated.state as PhoneState,
              resetCount: updated.resetCount,
              attempts: updated.attempts,
              hasExtension: Boolean(updated.extensionId && updated.extNumber),
            });
            if (plan.allowed) {
              updated = await db.deskPhoneSetupPhone.update({
                where: { id: phone.id },
                data: retryClears(plan),
              });
            }
          }
        }
      } catch (e: any) {
        record = { kind: "unavailable", detail: e?.message || String(e) };
      }
    }

    await deps.audit({
      tenantId: user.tenantId,
      action: "DESK_PHONE_IDENTIFIED",
      entityType: "desk_phone_setup_phone",
      entityId: phone.id,
      actorUserId: user.sub,
      // ⛔ What it REPLACED is the useful half — a mis-pick that overwrote a correct
      // fingerprint is only findable if the old answer was written down.
      metadata: {
        mac: phone.macAddress,
        wasVendor: phone.vendor ?? null, wasModel: phone.model ?? null,
        vendor: picked.vendor, model: picked.model, pbxModelId: picked.pbxModelId,
        setupSupported: picked.setupSupported, drivableLocally: picked.drivableLocally,
      },
    });

    return reply.send({ ok: true, phone: customerPhoneView(updated), record: recordView(record) });
  });

  /* ── try this one again ────────────────────────────────────────────────── */

  /**
   * NOTHING MAY BE PERMANENTLY STUCK.
   *
   * ⛔⛔ THE DEFECT THIS CLOSES, measured on Izzy's own run 2026-09-11. His Yealink sat
   * in `NEEDS_ATTENTION`; that state has an EMPTY transition list and `isTerminal()`
   * returns true for it, so there was no way out — not by re-running the wizard, not by
   * re-scanning, not by anything a customer could do. Worse, the halt had been written
   * BEFORE the fix that deleted the hour-long give-up, so deleting that clock could do
   * nothing for a phone already halted. He pressed the button again, the same stale
   * sentence came back, and the run reported zero attempts.
   *
   * ⛔ THIS IS NOT A LADDER TRANSITION, deliberately. `TRANSITIONS` says what the wizard
   * will do ON ITS OWN, and a terminal state genuinely is terminal there — the ladder
   * must never quietly restart a phone it gave up on, because that is a reboot loop on
   * somebody's desk. A retry is a PERSON saying "go again": its own route, its own
   * audit, its own rules.
   *
   * ⛔⛔ AND IT NEVER FORGIVES A RESET. `resetCount` and `resetRequestedAt` are the
   * record of hardware we have actually wiped; they are absent from what this writes.
   * Losing our place must never turn into wiping somebody's phone a second time.
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/retry", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;

    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    const plan = planPhoneRetry({
      state: phone.state as PhoneState,
      resetCount: phone.resetCount,
      attempts: phone.attempts,
      hasExtension: Boolean(phone.extensionId && phone.extNumber),
    });
    if (!plan.allowed) {
      // ⛔ 409, not 400: the request was perfectly well formed and the phone is simply
      // in a state where a retry would do harm. A 400 reads like the app is broken.
      return reply.status(409).send({ error: plan.reason, message: plan.customerMessage });
    }

    const updated = await db.deskPhoneSetupPhone.update({
      where: { id: phone.id },
      data: retryClears(plan),
    });

    /**
     * ⛔ A retry re-attempts the RECORD too, and that matters more than the state
     * change. Most halts are a phone the PBX has no row for; sending it round the
     * ladder again with the same missing record produces the same halt. Best-effort
     * as everywhere else — a phone system that cannot be reached still leaves the
     * phone un-stuck and moving.
     */
    let record: RecordOutcome | null = null;
    if (!updated.skippedAt && updated.extNumber) {
      try {
        record = await (deps.ensureRecord ?? defaultEnsureRecord)({
          tenantId: user.tenantId,
          mac: phone.macAddress,
          vendor: phone.vendor ?? null,
          model: phone.model ?? null,
          extNumber: String(updated.extNumber),
          discoveredIp: phone.ipAddress ?? null,
          requesterIp: requesterIpOf(req),
        });
        if (record.kind === "refused") {
          await db.deskPhoneSetupPhone.update({
            where: { id: phone.id },
            data: { customerNote: record.customerMessage, technicalNote: record.explain },
          });
        }
      } catch { /* the retry itself already landed */ }
    }

    await deps.audit({
      tenantId: user.tenantId,
      action: "DESK_PHONE_RETRY",
      entityType: "desk_phone_setup_phone",
      entityId: phone.id,
      actorUserId: user.sub,
      // The reset count BEFORE the retry is recorded: a retry is a fresh go and gets a
      // fresh reset-first (2026-09-14), so the audit keeps what was cleared before.
      metadata: { from: phone.state, to: plan.nextState, resetCount: phone.resetCount, explain: plan.explain },
    });

    const after = await db.deskPhoneSetupPhone.findFirst({ where: { id: phone.id } });
    return reply.send({ ok: true, phone: customerPhoneView(after ?? updated), record: recordView(record) });
  });

  /* ── which phones to set up at all ─────────────────────────────────────── */

  /**
   * The person's pick from the found screen: exactly these phones are in the
   * setup, every other phone in the run is left alone (2026-09-02, Izzy testing
   * on a factory-reset phone: "I want to be able to select which phone I want
   * to provision. It is only letting me provision all at once.").
   *
   * ⛔ Whole-run, idempotent: the list REPLACES the selection, so pressing
   * Continue twice or coming back from the next screen with different ticks
   * lands the same way. ⛔ Stored on the rows, not in the app — a reopened window
   * or a second machine cannot silently widen what a person chose. ⛔ A phone
   * being deselected is never failed and never loses its name: `skippedAt` is
   * the only thing that moves.
   */
  app.post("/desk-phones/runs/:id/selection", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const body = z.object({ phoneIds: z.array(z.string().min(1)).max(500) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const wanted = new Set(body.data.phoneIds);
    const rows = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id, tenantId: user.tenantId } });
    const known = new Set(rows.map((r: any) => String(r.id)));
    // ⛔ The pick covers exactly the phones the person was shown. An id that is
    // not in this run is a stale screen or a guess; either way, ask again.
    for (const id of wanted) {
      if (!known.has(id)) return reply.status(400).send({ error: "phone_list_mismatch" });
    }

    const now = new Date();
    const chosen = rows.filter((r: any) => wanted.has(String(r.id))).map((r: any) => r.id);
    const skipped = rows.filter((r: any) => !wanted.has(String(r.id))).map((r: any) => r.id);
    if (chosen.length) {
      await db.deskPhoneSetupPhone.updateMany({
        where: { runId: run.id, tenantId: user.tenantId, id: { in: chosen } },
        data: { skippedAt: null },
      });
    }
    if (skipped.length) {
      await db.deskPhoneSetupPhone.updateMany({
        where: { runId: run.id, tenantId: user.tenantId, id: { in: skipped } },
        data: { skippedAt: now },
      });
    }
    // ⛔⛔ TICKING A PHONE IS THE CONSENT TO FACTORY RESET IT (Izzy, 2026-09-14: "The
    // first thing that happens before connecting any phone to my system is a factory
    // reset"). The pick is recorded as the run's reset approval and covers EXACTLY the
    // ticked phones — it replaces the list, so an unticked phone is never covered.
    await db.deskPhoneSetupRun.update({
      where: { id: run.id },
      data: {
        resetAuthorizedAt: chosen.length ? now : null,
        resetAuthorizedByUserId: chosen.length ? user.sub : null,
        resetAuthorizedPhoneIds: JSON.stringify(chosen.map((id: any) => String(id))),
      },
    });
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_SELECTION_SET",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
      metadata: { selected: chosen.length, skipped: skipped.length, resetApprovedByTick: chosen.length },
    });

    const phones = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    return reply.send({
      ok: true,
      selected: chosen.length,
      skipped: skipped.length,
      phones: await withConnectedNow(deps, user.tenantId, phones.map(customerPhoneView)),
    });
  });

  /* ── permission to wipe ────────────────────────────────────────────────── */

  app.post("/desk-phones/runs/:id/authorize-reset", async (req: any, reply: any) => {
    // 404 BEFORE the reset permission and before the body. This is the route that
    // erases a customer's device; a stranger must not learn that their run id
    // guessed right, and must not be told "you lack the permission" for a run that
    // was never theirs.
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (run.status !== "running") return reply.status(404).send({ error: "not_found" });
    if (!(await allowedToReset(user, reply))) return;
    const body = z.object({ phoneIds: z.array(z.string().min(1)).min(1).max(500) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const phones = await db.deskPhoneSetupPhone.findMany({
      where: { runId: run.id, tenantId: user.tenantId, id: { in: body.data.phoneIds } },
    });
    // ⛔ The approval covers exactly the phones the person was shown. A phone that
    // was not on that list is not covered, and asking again is cheap.
    if (phones.length !== body.data.phoneIds.length) {
      return reply.status(400).send({ error: "phone_list_mismatch" });
    }

    // ⛔ A second approval ADDS to the first. Replacing the list would silently take
    // the approval away from a phone the person already said yes to, and the wizard
    // would ask them about it again.
    const approvedIds = [...new Set([...approvedResetPhoneIds(run), ...phones.map((p: any) => String(p.id))])];
    await db.deskPhoneSetupRun.update({
      where: { id: run.id },
      data: {
        resetAuthorizedAt: new Date(),
        resetAuthorizedByUserId: user.sub,
        resetAuthorizedPhoneIds: JSON.stringify(approvedIds),
      },
    });
    for (const p of phones) {
      if (isTerminal(p.state as PhoneState)) continue;
      await db.deskPhoneSetupPhone.update({ where: { id: p.id }, data: { state: "RESET_AUTHORIZED" } });
    }
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_RESET_AUTHORIZED",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
      metadata: { phoneCount: phones.length, macs: phones.map((p: any) => p.macAddress) },
    });
    return reply.send({ ok: true, authorized: phones.length });
  });

  /* ── the brain: what should happen to this phone next ──────────────────── */

  app.post("/desk-phones/runs/:id/phones/:phoneId/advance", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const observed = z.object({
      reachableOnLan: z.boolean().optional(),
      locked: z.boolean().optional(),
      defaultCredentialsTried: z.boolean().optional(),
      haveCustomerCredentials: z.boolean().optional(),
      onACall: z.boolean().optional(),
      awaitingReboot: z.boolean().optional(),
      networkSuppliesOldProvisioning: z.boolean().optional(),
      // The two answers a person can give: "I don't know the password" and
      // "don't clear this one". Both are safe in the caller's hands — each can
      // only make LESS happen to a phone, never more.
      passwordUnavailable: z.boolean().optional(),
      resetDeclined: z.boolean().optional(),
      // The office machine tried to hand this phone its folder over PnP and gave
      // up (bounded restarts, then listen-only). Can only make LESS happen.
      provisioningHandoffFailed: z.boolean().optional(),
      // The office machine refused to wipe this phone on its own fence (an analog
      // adapter, a cordless base, a phone that may be on Wi-Fi, an unknown model, an
      // app too old to have the step). Can only make LESS happen: the phone gets the
      // non-destructive hand-off instead.
      resetRefusedLocally: z.boolean().optional(),
      /**
       * The maker's cloud is spent for this phone: the person has no serial number for it, or the
       * cloud refused in a way that will not change. ⛔ Can only make LESS happen — it closes the
       * SECOND door, so the phone ends at the honest hands-on halt instead of being asked again.
       */
      makerCloudUnavailable: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!observed.success) return reply.status(400).send({ error: "invalid_request" });

    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    // ⛔ A phone the person left unticked is not in the setup. Nothing is asked
    // of it, nothing is written to it, and no reset can ever be spent on it —
    // whatever the driver sends. The driver skips these itself; this is the
    // server refusing on its own record, which is the only copy that counts.
    if (phone.skippedAt) {
      return reply.send({
        ok: true, action: "do_nothing", rung: 0, halted: false, handOff: null,
        skipped: true, customerMessage: null, phone: customerPhoneView(phone),
      });
    }

    // ⛔⛔ REGISTRATION IS ASKED OF ASTERISK, NEVER INFERRED. A phone that accepted
    // our settings is not a working phone; only the PBX reporting the endpoint
    // registered turns anything green.
    let registeredToUs = false;
    if (phone.extNumber) {
      const isReg = deps.isRegistered ?? defaultIsRegistered;
      try { registeredToUs = await isReg(user.tenantId, phone.extNumber); }
      catch { registeredToUs = false; }
    }

    const provisioningIsOurs = classifyOurs(phone.provisioningUrl, deps.ourProvisioningHosts());
    const condition: PhoneCondition = {
      registeredToUs,
      provisioningIsOurs,
      reachableOnLan: observed.data.reachableOnLan ?? true,
      locked: observed.data.locked ?? false,
      defaultCredentialsTried: observed.data.defaultCredentialsTried ?? false,
      haveCustomerCredentials: observed.data.haveCustomerCredentials ?? false,
      modelProfileMissing: false,
      firmwareTooOld: false,
      provisioningRevertedAfterReset: phone.resetCount > 0 && !provisioningIsOurs && !!phone.provisioningUrl,
      networkSuppliesOldProvisioning: observed.data.networkSuppliesOldProvisioning ?? false,
      awaitingReboot: observed.data.awaitingReboot ?? (
        phone.state === "WAITING_FOR_REBOOT"
        && (!phone.resetRequestedAt || Date.now() - new Date(phone.resetRequestedAt).getTime() < RESET_REBOOT_WAIT_MS)
      ),
      onACall: observed.data.onACall ?? false,
      passwordUnavailable: observed.data.passwordUnavailable ?? false,
      resetDeclined: observed.data.resetDeclined ?? false,
    };

    const resetApprovedAt = resetApprovalFor(run, phone.id);
    let decision = nextEscalation(condition, {
      state: phone.state as PhoneState,
      resetCount: phone.resetCount,
      resetAuthorizedAt: resetApprovedAt,
      attempts: phone.attempts,
    });
    // ⛔ The office machine's own fence said no (or it cannot do the step at all). The
    // phone still gets set up — through the hand-off, which erases nothing.
    if (decision.action === "reset_over_lan" && observed.data.resetRefusedLocally) {
      decision = {
        action: "set_provisioning", rung: 3,
        reason: "the office machine refused the reset on its own safety fence; hand the phone its folder instead",
      };
    }
    // ⛔ A hand-off the office machine has given up on is ended here, not retried:
    // every further "set_provisioning" would restart somebody's phone again. The
    // ladder itself stays pure; this is the one caller-observed fact it acts on.
    if (decision.action === "set_provisioning" && observed.data.provisioningHandoffFailed) {
      // ⛔⛔ THIS FLAG CHANGED MEANING ON 2026-09-11 AND THE WORDING HAD TO FOLLOW.
      // It used to be set by a CLOCK — an hour after the office machine first asked
      // — and the sentence below said we had given up. That was false: the desktop
      // responder is STANDING, so a phone power-cycled the next morning is still
      // provisioned. The driver now raises this ONLY when the machine could not open
      // its listening socket at all, which is the one case where waiting really is
      // pointless, so the message says that and names the thing a person can fix.
      decision = {
        action: "halt", rung: -1, halted: true, handOff: "support",
        reason: "the office machine could not open the PnP listening socket (repeated cannot_listen)",
        customerMessage:
          "This computer could not listen for the phone on your network. If Windows asked whether to " +
          "allow Loopcom, choose Allow and run setup again — or Loopcom Support can finish this one with you.",
      };
    }
    // ⛔⛔ A vendor with NO brand in the PBX's provisioning catalog (Panasonic —
    // checked read-only against provisioning.brands, 2026-09-03) has exactly two
    // honest outcomes, decided here like the hand-off override above so the pure
    // ladder and its 12.6M-decision invariant suite stay untouched.
    //   • REGISTERED wins outright: such a phone's only possible configuration is
    //     a hand-typed SIP account, so "not pointed at our provisioning" is its
    //     normal working shape, never something to re-sync out of it.
    //   • Anything else goes to a person NOW: there is no template to point the
    //     phone at, so a provisioning step would stall forever, a password would
    //     buy the power to do nothing, and a reset would ERASE the one
    //     configuration that could ever make it work.
    // The ladder's own halts (unreachable, attempt cap) keep their more specific
    // wording; only actions that would DO something are converted.
    const handConfiguredVendor = !vendorSupportsPbxProvisioning(phone.vendor);
    if (handConfiguredVendor) {
      if (registeredToUs) {
        decision = {
          action: "do_nothing", rung: 0, halted: false,
          reason: "registered; this model is configured by hand and registration is the whole test",
        };
      } else if (decision.action !== "do_nothing" && decision.action !== "halt") {
        decision = {
          action: "halt", rung: -1, halted: true, handOff: "support",
          reason: `no provisioning template exists for vendor "${sanitizeDeviceText(phone.vendor, 40)}" — the PBX provisioning catalog has no such brand`,
          customerMessage:
            "Loopcom can't set this model of phone up automatically yet. " +
            "Loopcom Support can connect it for you — the rest of your phones keep going.",
        };
      }
    }
    // ⛔⛔ A BRAND NO COMPUTER ON THE LAN CAN DRIVE MUST REACH A FINISHED STATE.
    // Four brands in the PBX catalogue — Alcatel-Lucent, Dinstar, Nurivoice and
    // Hanyang Digitech, 31 models between them — publish no mechanism a machine on
    // the same network can use: no PnP multicast, no HTTP action, no mDNS. Before
    // this, the ladder would keep naming `set_provisioning`, the driver could not
    // perform it, and the phone sat on "Preparing" for ever — the run never
    // finished and the customer was watching a progress bar for something that was
    // never going to happen. Same route-level shape as the hand-configured branch
    // above, so the pure ladder and its exhaustive invariant suite stay untouched.
    const drivableLocally = vendorCanBeDrivenLocally(phone.vendor);
    if (!handConfiguredVendor && !drivableLocally) {
      if (registeredToUs) {
        // ⛔ Registration is the whole test for a phone we cannot re-point. Chasing
        // provisioning on it would leave a working phone amber for ever.
        decision = {
          action: "do_nothing", rung: 0, halted: false,
          reason: "registered; nothing on the LAN can drive this brand and registration is the whole test",
        };
      } else if (decision.action !== "do_nothing" && decision.action !== "halt") {
        decision = {
          action: "halt", rung: -1, halted: true, handOff: "support",
          reason: `no LAN-drivable mechanism exists for vendor "${sanitizeDeviceText(phone.vendor, 40)}" — no PnP, no HTTP action, no mDNS`,
          customerMessage:
            "This phone has to be pointed at Loopcom by hand — its maker gives us no way to do it " +
            "from your computer. Loopcom Support will do it with you; the rest of your phones keep going.",
        };
      }
    }

    // ⛔⛔ WHICH MECHANISM DOES THE STEP — decided HERE, per brand, never by the office machine.
    // The ladder says WHAT (clear it, hand it its settings); `deviceMechanismsFor` says HOW for
    // this brand. A brand whose maker cloud is connected and can clear/restart it (a Grandstream
    // with GDMS) is told `via: "vendor_cloud"`: the office machine listens, and the step itself
    // runs through `/prepare`. Every other brand is answered exactly as before this existed.
    let via: "vendor_cloud" | null = null;
    if (registry.providerFor(manufacturerFromText(phone.vendor))) {
      const mechanisms = deviceMechanismsFor(phone.vendor, await cloudReadiness());
      if (decision.action === "reset_over_lan" && mechanisms.reset === "vendor_cloud") via = "vendor_cloud";
      if (decision.action === "set_provisioning" && mechanisms.restart === "vendor_cloud") via = "vendor_cloud";

      // ⛔⛔ NEVER ASK FOR A PASSWORD WHEN THE MAKER'S CLOUD IS THE ONE DOING THE WIPE (Izzy,
      // 2026-09-14: "I don't want it to ask for the password"). The pure ladder still reaches for a
      // password on a locked phone — it knows nothing about brands — so that question is converted
      // here into the cloud route. The key that route needs is the SERIAL, and the wizard now asks
      // for that ONCE, on the screen where the person picks who sits at the phone, rather than
      // interrupting them mid-setup for something most people do not have.
      // ⛔ Only while the one reset is unspent, the phone is ticked, it is not already working, and
      // the person has not already said the serial is unavailable too — then the ladder's own halt
      // stands and the phone ends honestly at hands-on.
      // ⛔ THE THREE SHAPES THE PASSWORD QUESTION TAKES, all of them the same question. The ladder
      // is pure and brand-blind: on a locked phone it tries the documented default, then asks the
      // person, then HALTS when they say they do not have it. All three are the password door —
      // and for a brand the maker's cloud can wipe from its serial, that door is the wrong one to
      // be standing at. ⛔ The halt is included deliberately: without it, a customer who once said
      // "I don't have the password" is sent to hands-on while the cloud route sits open.
      const laddersPasswordQuestion =
        decision.action === "ask_for_password"
        || decision.action === "try_default_credentials"
        || (decision.action === "halt" && condition.locked && condition.passwordUnavailable);
      if (
        laddersPasswordQuestion
        && mechanisms.reset === "vendor_cloud"
        && observed.data.makerCloudUnavailable !== true
        && Number(phone.resetCount ?? 0) === 0
        && resetApprovedAt
        && !registeredToUs
      ) {
        decision = {
          action: "reset_over_lan",
          rung: 1,
          reason: "the maker's cloud clears this brand from its serial; no password is asked of the customer",
        };
        via = "vendor_cloud";
      }
    }

    // The folder a reset phone needs, resolved only when the instruction is to
    // point the phone at us — or to clear it through the maker's cloud, so the office
    // machine is listening before the wipe. Null means "no URL known" — the driver waits.
    let provisioningUrl: string | null = null;
    if (decision.action === "set_provisioning" || via === "vendor_cloud") {
      try { provisioningUrl = await (deps.provisioningUrlFor ?? defaultProvisioningUrlFor)(user.tenantId); }
      catch { provisioningUrl = null; }
    }

    // ⛔ A reset instruction is issued only if the stored record still allows it.
    // The ladder already checked; this checks again against the row, because the row
    // is the thing that survives a crash.
    //
    // ⛔⛔ AND IT IS NO LONGER SPENT HERE (2026-09-14). This branch used to claim the
    // reset — RESET_REQUESTED, resetCount + 1 — the moment it DECIDED one was due. But
    // nothing had wiped anything yet: the wizard's driver had no branch for this
    // instruction and `reset_over_sip` has no executor at all, so a phone reaching this
    // rung lost its one reset (a reset is never given back) without being touched. The
    // reset is now counted by POST …/reset-sent, which the office machine calls only
    // after its own fence let the wipe leave the machine. The single-send guarantee
    // moves with it: the atomic claim lives there now.
    let resetAuthorizationId: string | null = null;
    if (decision.action === "reset_over_lan" || decision.action === "reset_over_sip") {
      const verdict = decideReset({
        state: phone.state as PhoneState, resetCount: phone.resetCount,
        resetAuthorizedAt: resetApprovedAt,
        attempts: phone.attempts,
      });
      if (!verdict.allowed) {
        return reply.send({
          ok: true, action: "halt", halted: true,
          customerMessage: verdict.explain,
          phone: customerPhoneView(phone),
        });
      }
      // Ties the wipe the office machine is about to send to THIS run's approval. The
      // desktop refuses a reset without one; the server checks it names this run.
      if (run.resetAuthorizedAt) resetAuthorizationId = `${run.id}.${new Date(run.resetAuthorizedAt).getTime()}`;
    } else if (decision.halted) {
      await db.deskPhoneSetupPhone.update({
        where: { id: phone.id },
        data: {
          state: "NEEDS_ATTENTION",
          customerNote: decision.customerMessage || null,
          technicalNote: sanitizeDeviceText(decision.reason, 300),
          haltedReason: decision.handOff || "support",
        },
      });
    } else if (decision.action === "do_nothing" && registeredToUs && (provisioningIsOurs || handConfiguredVendor || !drivableLocally)) {
      // ⛔ `handConfiguredVendor` joins `provisioningIsOurs` here on purpose: a
      // Panasonic can never point at our provisioning, so registration alone is
      // the green light for it — demanding both would leave a working phone
      // amber forever. ⛔ `!drivableLocally` joins them for the same reason: an
      // Alcatel or a Dinstar was pointed at us by a person, so there is nothing
      // left for us to verify beyond the PBX saying it is registered.
      await db.deskPhoneSetupPhone.update({
        where: { id: phone.id },
        data: { state: "REGISTERED", registeredAt: phone.registeredAt ?? new Date(), customerNote: null },
      });
    }

    const fresh = await db.deskPhoneSetupPhone.findFirst({ where: { id: phone.id } });
    return reply.send({
      ok: true,
      action: decision.action,
      rung: decision.rung,
      halted: Boolean(decision.halted),
      handOff: decision.handOff ?? null,
      customerMessage: decision.customerMessage ?? null,
      ...(decision.action === "set_provisioning" || via === "vendor_cloud" ? { provisioningUrl } : {}),
      ...(via ? { via } : {}),
      ...(decision.action === "reset_over_lan" ? { resetAuthorizationId } : {}),
      phone: customerPhoneView(fresh),
    });
  });

  /* ── the office machine says the wipe left it ──────────────────────────── */

  /**
   * ⛔⛔ THIS IS WHERE A RESET IS COUNTED, AND ONLY HERE.
   *
   * The office machine calls it once its own fence let a factory reset leave the
   * machine — or when the request may have reached the phone (a wipe that "timed out"
   * was very likely received, because the phone stops answering BECAUSE it is doing
   * what it was told). A reset it refused on its own fence is never reported, so it is
   * never counted.
   *
   * ⛔ The claim is atomic on the counter and state just read: twenty reports landing at
   * once produce one reset and one audit row. The approval must still name this phone.
   */
  app.post("/desk-phones/runs/:id/phones/:phoneId/reset-sent", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (run.status !== "running") return reply.status(404).send({ error: "not_found" });
    if (!(await allowedToSetUp(user, reply))) return;
    const body = z.object({ authorizationId: z.string().trim().min(1).max(160) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    // ⛔ The approval id must belong to THIS run. It is not a secret, it is a binding:
    // a report carrying another run's id is not a report about this run's approval.
    if (!body.data.authorizationId.startsWith(`${run.id}.`)) {
      return reply.status(409).send({ error: "authorization_mismatch" });
    }

    // Already counted (a retried report, or the other of two racing ones): say so.
    if (phone.state === "WAITING_FOR_REBOOT" && phone.resetCount > 0) {
      return reply.send({ ok: true, counted: false, alreadyCounted: true, phone: customerPhoneView(phone) });
    }

    const verdict = phone.skippedAt
      ? { allowed: false as const, reason: "not_selected", explain: "This phone was left out of the setup." }
      : decideReset({
        state: phone.state as PhoneState, resetCount: phone.resetCount,
        resetAuthorizedAt: resetApprovalFor(run, phone.id),
        attempts: phone.attempts,
      });
    if (!verdict.allowed) {
      return reply.status(409).send({ error: "reset_not_allowed", reason: verdict.reason });
    }

    const claim = await db.deskPhoneSetupPhone.updateMany({
      where: { id: phone.id, resetCount: phone.resetCount, state: phone.state },
      data: {
        state: "WAITING_FOR_REBOOT", resetCount: phone.resetCount + 1,
        resetRequestedAt: new Date(), attempts: phone.attempts + 1,
        // ⛔ The address the phone had is the old provider's, and a wiped phone no
        // longer has it. Keeping it would make the very next look read "it went straight
        // back to the old provider" and hand the phone to Support seconds after its reset.
        provisioningUrl: null,
      },
    });
    const fresh = await db.deskPhoneSetupPhone.findFirst({ where: { id: phone.id } });
    if (!claim || claim.count !== 1) {
      return reply.send({ ok: true, counted: false, alreadyCounted: true, phone: customerPhoneView(fresh ?? phone) });
    }
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_RESET_REQUESTED",
      entityType: "DeskPhoneSetupPhone", entityId: phone.id, actorUserId: user.sub,
      metadata: { mac: phone.macAddress, via: "reset_over_lan", reportedBy: "office_machine" },
    });
    return reply.send({ ok: true, counted: true, phone: customerPhoneView(fresh ?? phone) });
  });

  /* ── progress ──────────────────────────────────────────────────────────── */

  app.get("/desk-phones/runs/:id", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const phones = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    const wantsDiagnostics = String((req.query || {}).view || "") === "diagnostics";
    const summary = summarizeRun(inSetup(phones).map((p: any) => p.state as PhoneState));
    return reply.send({
      ok: true,
      run: { id: run.id, status: run.status, subnet: run.subnet, startedAt: run.startedAt, origin: run.origin },
      summary,
      phones: await withConnectedNow(
        deps, user.tenantId, phones.map(wantsDiagnostics ? diagnosticPhoneView : customerPhoneView),
      ),
    });
  });

  /**
   * ⛔ The card on the settings page is driven by this. When nothing is left to do
   * the wizard disappears entirely and the customer never sees provisioning
   * terminology again.
   */
  app.get("/desk-phones/state", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const run = await db.deskPhoneSetupRun.findFirst({
      where: { tenantId: user.tenantId, status: "running" }, orderBy: { startedAt: "desc" },
    });
    const pendingInvite = await db.deskPhoneSetupRun.findFirst({
      where: { tenantId: user.tenantId, status: "running", origin: "admin" }, orderBy: { startedAt: "desc" },
    });
    const phones = run
      ? await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } })
      : [];
    const summary = summarizeRun(inSetup(phones).map((p: any) => p.state as PhoneState));
    return reply.send({
      ok: true,
      hasActiveRun: Boolean(run),
      showSetupCard: Boolean(run) && !summary.finished,
      invitedByLoopcom: Boolean(pendingInvite),
      runId: run?.id ?? null,
      summary,
    });
  });

  /**
   * What the office app's STANDING PnP listener needs: this tenant's provisioning
   * folder and the hardware addresses of the phones the PBX records for them. The
   * desktop answers those phones — and only those — whenever they boot on the office
   * network, so a factory-reset phone is provisioned the moment it is plugged in.
   * ⛔ Same gate as the wizard (`can_setup_desk_phones`); best-effort on both reads —
   * no folder means `url: null` and the app arms nothing.
   */
  app.get("/desk-phones/pnp-config", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    let url: string | null = null;
    try { url = await (deps.provisioningUrlFor ?? defaultProvisioningUrlFor)(user.tenantId); } catch { url = null; }
    let phones: PbxProvisionedPhone[] = [];
    try { phones = await (deps.provisionedPhones ?? defaultProvisionedPhones)(user.tenantId); } catch { phones = []; }

    /**
     * ⛔⛔ THE PHONES IN A LIVE RUN ARE ARMED TOO, AND THIS IS HALF THE FIX.
     * The PBX list is what the phone system already knows — which is precisely the set
     * that does NOT include a phone somebody is setting up right now. Arming from that
     * alone is what left a factory-reset Yealink asking into silence.
     *
     * ⛔ Only phones that are IN the setup and assigned: a phone the person unticked is
     * never answered (we would be pointing a handset they deliberately left alone at
     * us), and one with nobody assigned has nothing to be pointed at yet. `pnpArmList`
     * is the one place that rule lives.
     */
    let runMacs: string[] = [];
    try {
      const active = await db.deskPhoneSetupRun.findFirst({
        where: { tenantId: user.tenantId, status: "running" },
        orderBy: { startedAt: "desc" },
        select: { id: true },
      });
      if (active) {
        const rows = await db.deskPhoneSetupPhone.findMany({
          where: { runId: active.id, tenantId: user.tenantId },
          select: { macAddress: true, skippedAt: true, extNumber: true },
        });
        runMacs = pnpArmList(rows);
      }
    } catch { runMacs = []; }

    const macs = Array.from(new Set([
      ...phones.map((ph) => String(ph.mac ?? "").toLowerCase()).filter((m) => /^[0-9a-f]{12}$/.test(m)),
      ...runMacs,
    ]));
    return reply.send({ ok: true, url, macs });
  });

  /* ── the Loopcom side ──────────────────────────────────────────────────── */

  app.post("/admin/desk-phones/send-setup", async (req: any, reply: any) => {
    const user = getUser(req);
    // ⛔ Staff only, and checked on the ROLE rather than on a permission a customer
    // could be granted. Sending a setup request into somebody's office is ours.
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const body = z.object({
      tenantId: z.string().min(1),
      /** false = just invite them (the old behaviour); default true = Loopcom drives. */
      drive: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const tenant = await db.tenant.findFirst({ where: { id: body.data.tenantId } });
    if (!tenant) return reply.status(404).send({ error: "not_found" });

    const existing = await db.deskPhoneSetupRun.findFirst({
      where: { tenantId: tenant.id, status: "running" }, orderBy: { startedAt: "desc" },
    });
    if (existing) return reply.send({ ok: true, run: { id: existing.id, resumed: true } });

    const run = await db.deskPhoneSetupRun.create({
      data: {
        tenantId: tenant.id,
        startedByUserId: user.sub,
        requestedByUserId: user.sub,
        origin: "admin",
        // ⛔ "admin" means Loopcom drives it from their end while one of the
        // tenant's OWN installed apps does the network work. It still performs
        // nothing until somebody in that office presses the consent card.
        driveMode: body.data.drive === false ? "self" : "admin",
      },
    });
    // ⛔⛔ SENDING IS NOT CONSENTING. This creates an invitation, and nothing else.
    // No reset authorisation is implied, and the wizard will still ask a person in
    // that office before anything is erased.
    await deps.audit({
      tenantId: tenant.id, action: "DESK_PHONE_SETUP_SENT",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
      metadata: { sentBy: user.email },
    });
    return reply.send({ ok: true, run: { id: run.id, resumed: false } });
  });

  /* ── admin-driven runs: the office app is the hands, Loopcom is the head ── */

  /**
   * The office app asks: is Loopcom waiting for us to do anything here?
   *
   * ⛔⛔ THIS IS THE ONLY WAY AN ADMIN-STARTED RUN REACHES A CUSTOMER'S NETWORK,
   * and it is a POLL, not a push. Same shape remote support already uses: no new
   * socket, no inbound connection to a customer's machine, and the office app is
   * always the one that initiates. A compromised server cannot reach into an
   * office; it can only leave a note that the office may choose to read.
   *
   * ⛔ It answers with `needsConsent` until somebody THERE agrees. Scanning a
   * customer's network with nobody present to say yes is the line the whole
   * design draws.
   */
  app.get("/desk-phones/pending", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const run = await db.deskPhoneSetupRun.findFirst({
      where: { tenantId: user.tenantId, status: "running", driveMode: "admin" },
      orderBy: { startedAt: "desc" },
    });
    if (!run) return reply.send({ ok: true, pending: false });

    // ⛔ Best-effort heartbeat: the admin's screen shows "their app is connected"
    // from this, and a failure to stamp it must never stop the office working.
    try {
      await db.deskPhoneSetupRun.update({
        where: { id: run.id },
        data: {
          officeAgentSeenAt: new Date(),
          officeAgentLabel: run.officeAgentLabel || String((req.query || {}).label || "").slice(0, 120) || null,
        },
      });
    } catch { /* non-fatal */ }

    return reply.send({
      ok: true,
      pending: true,
      runId: run.id,
      needsConsent: !run.officeConsentAt,
      // Plain words for the card the office person sees. ⛔ No jargon, and it
      // names Loopcom so nobody wonders who is asking.
      message: run.officeConsentAt
        ? "Loopcom is setting up the phones in your office."
        : "Loopcom would like to find the phones in your office and connect them.",
    });
  });

  /**
   * Somebody in that office says yes.
   *
   * ⛔⛔ THE ADMIN WHO SENT THE REQUEST CANNOT SUPPLY THIS. The consent is
   * recorded against the office person's own session, and the route lives on the
   * CUSTOMER side of the permission fence — a staff token switched onto a tenant
   * still has to have a real person in that office press the card, because the
   * whole point is that somebody there agreed.
   */
  app.post("/desk-phones/runs/:id/office-consent", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    if (run.status !== "running") return reply.status(404).send({ error: "not_found" });

    // ⛔ Idempotent, and the FIRST consent wins: re-pressing must never re-stamp a
    // different person as the one who agreed.
    if (!run.officeConsentAt) {
      await db.deskPhoneSetupRun.updateMany({
        where: { id: run.id, officeConsentAt: null },
        data: { officeConsentAt: new Date(), officeConsentByUserId: user.sub },
      });
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_OFFICE_CONSENT",
        entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
        metadata: { consentedBy: user.email },
      });
    }
    return reply.send({ ok: true, consented: true });
  });

  /**
   * The office person declines, or stops a run that is already going.
   * ⛔ Always available, and it consults no permission beyond being in that
   * tenant — a stop button that can refuse is not a stop button.
   */
  app.post("/desk-phones/runs/:id/office-stop", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    await db.deskPhoneSetupRun.updateMany({
      where: { id: run.id, status: "running" },
      data: { status: "abandoned", finishedAt: new Date() },
    });
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_OFFICE_STOPPED",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
      metadata: { stoppedBy: user.email },
    });
    return reply.send({ ok: true, stopped: true });
  });

  app.get("/admin/desk-phones/runs/:id", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const run = await db.deskPhoneSetupRun.findFirst({ where: { id: String(req.params.id) } });
    if (!run) return reply.status(404).send({ error: "not_found" });
    const phones = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    return reply.send({
      ok: true,
      run: {
        id: run.id, tenantId: run.tenantId, status: run.status, subnet: run.subnet,
        origin: run.origin, startedAt: run.startedAt,
        // ⛔ The technician must be able to see WHY nothing is happening: waiting
        // for the office to agree, and whether their app has checked in at all,
        // are the two states that otherwise look identical from this end.
        driveMode: run.driveMode,
        officeConsentAt: run.officeConsentAt || null,
        officeAgentLabel: run.officeAgentLabel || null,
        officeAgentSeenAt: run.officeAgentSeenAt || null,
      },
      summary: summarizeRun(inSetup(phones).map((p: any) => p.state as PhoneState)),
      // The technician sees everything the customer does not.
      phones: phones.map(diagnosticPhoneView),
    });
  });

  /* ── what a phone should be given ──────────────────────────────────────── */

  /**
   * The button layout for one phone, computed from the customer's own extension
   * list. ⛔ Read-only: it returns what WOULD be written so the screen can show it,
   * and writing to the PBX is a separate, audited operation.
   */
  app.get("/desk-phones/runs/:id/phones/:phoneId/buttons", async (req: any, reply: any) => {
    const owned = await ownRun(req, reply); if (!owned) return;
    const { user, run } = owned;
    if (!(await allowedToSetUp(user, reply))) return;
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    const extensions = await db.extension.findMany({
      where: { tenantId: user.tenantId, status: "ACTIVE" },
      orderBy: { extNumber: "asc" },
    });
    const layout = buildButtonLayout({
      model: phone.model,
      ownExtension: phone.extNumber || "",
      colleagues: extensions.map((e: any) => ({ extension: e.extNumber, displayName: e.displayName || e.extNumber })),
    });
    return reply.send({
      ok: true,
      capacity: layout.capacity,
      free: layout.free,
      colleagues: layout.placed.map((c) => ({ extension: c.extension, name: c.displayName })),
      // ⛔ Never silently dropped: a 10-key phone in a 30-person office is normal,
      // and the screen must be able to say "the first nine fit".
      omitted: layout.omitted.map((c) => ({ extension: c.extension, name: c.displayName })),
      keysJson: serializeButtonLayout(layout),
    });
  });

  /* ── what the wizard needs to draw itself ───────────────────────── */

  /** The people a phone can be assigned to. ⛔ This customer's own, and only theirs. */
  app.get("/desk-phones/extensions", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const rows = await db.extension.findMany({
      where: { tenantId: user.tenantId, status: "ACTIVE" },
      orderBy: { extNumber: "asc" },
    });
    return reply.send({
      ok: true,
      extensions: rows.map((e: any) => ({
        id: e.id, extNumber: e.extNumber, displayName: e.displayName || e.extNumber,
      })),
    });
  });

  /**
   * A handset's product photo.
   *
   * ⛔⛔ PROXIED, NEVER LINKED. The portal's CSP is `default-src 'self'`, so an
   * <img> pointed straight at the PBX is blocked by the browser as a silent console
   * violation - the picture simply never appears, with no failed request to find.
   * The same trap has already cost this repo an afternoon on voice samples.
   *
   * ⛔ The model is the ONLY input and it is reduced to A-Z0-9 before use, so this
   * cannot be turned into a way to fetch arbitrary paths off the PBX.
   */
  app.get("/desk-phones/photo/:model", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const model = String(req.params.model || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24);
    if (!model) return reply.status(404).send({ error: "not_found" });
    const base = deps.phoneImageBase?.();
    if (!base) return reply.status(404).send({ error: "not_configured" });

    for (const brand of PHOTO_BRANDS) {
      try {
        const res = await fetch(`${base}/images/${brand}/${model}.png`, {
          signal: AbortSignal.timeout(4000),
        } as any);
        if (!res.ok) continue;
        // ⛔ Bounded. The photos are ~100 KB; anything past 5 MB is not a product
        // photo and must not be buffered into api memory.
        const len = Number(res.headers.get("content-length") || 0);
        if (len > 5 * 1024 * 1024) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) continue;
        // ⛔ Forced to image/png rather than echoed. A CDN once served us MP3 audio
        // labelled text/plain and the browser silently declined to decode it.
        reply.header("Content-Type", "image/png");
        reply.header("Cache-Control", "public, max-age=86400, immutable");
        return reply.send(buf);
      } catch { /* try the next brand */ }
    }
    // ⛔ An honest 404: the screen falls back to a drawn phone rather than a broken
    // image icon, which reads as a broken product.
    return reply.status(404).send({ error: "not_found" });
  });

  /* ── the makers' device clouds: identify, register, prepare ────────────── */

  // ⛔ Same guards, same audit, same wizard. These routes live in their own file only
  // because this one is long; deskPhoneRouteOrder.test.ts holds both to the same rules.
  registerDeviceCloudRoutes(app, {
    deps,
    db,
    getUser,
    ownRun,
    allowedToSetUp,
    allowedToReset,
    isSuper,
    mayRunSetup,
    customerPhoneView,
    resetApprovalFor,
    isOurProvisioningUrl: (url) => classifyOurs(url, deps.ourProvisioningHosts()),
    isRegistered: deps.isRegistered ?? defaultIsRegistered,
    registry,
    withMacLock: deps.withMacLock ?? defaultWithMacLock,
    // The rendered gs_provision config the PBX serves this device — fetched the same way the
    // phone would (the tenant's phoneprov base + cfg<mac>.xml). Now sourced from a CLEAN per-model
    // template, so the server is correct. Used to SEND the config over the maker cloud.
    renderDeviceConfig: deps.renderDeviceConfig ?? (async (tenantId: string, mac: string) => {
      try {
        const base = await (deps.provisioningUrlFor ?? defaultProvisioningUrlFor)(tenantId);
        if (!base) return null;
        const m = String(mac ?? "").toLowerCase().replace(/[^0-9a-f]/g, "");
        if (m.length !== 12) return null;
        const root = /^https?:\/\//.test(base) ? base : `http://${base}`;
        const res = await fetch(`${root.replace(/\/+$/, "")}/cfg${m}.xml`, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const xml = await res.text();
        return xml.includes("<gs_provision") ? xml : null;
      } catch { return null; }
    }),
  });
}

/** Brands whose product photos are installed on the PBX, most likely first. */
const PHOTO_BRANDS = [
  "yealink", "polycom", "grandstream", "fanvil", "snom", "cisco", "sangoma",
  "htek", "vtech", "atcom", "alcatel-lucent", "aastra-mitel", "gigaset",
];
function classifyOurs(url: string | null | undefined, hosts: string[]): boolean {
  const raw = String(url ?? "").trim();
  if (!raw) return false;
  let host: string;
  try { host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname.toLowerCase(); }
  catch { return false; }
  for (const h of hosts) {
    const want = String(h || "").toLowerCase().trim();
    if (!want) continue;
    // ⛔ Dot boundary, never a substring: `loopcom.net.evil.com` is not ours.
    if (host === want || host.endsWith(`.${want}`)) return true;
  }
  return false;
}
