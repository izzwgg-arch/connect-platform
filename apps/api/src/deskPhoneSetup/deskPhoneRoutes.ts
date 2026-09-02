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
  summarizeRun, type PhoneCondition, type PhoneState,
} from "@connect/shared";
import { listPbxProvisionedPhones, resolvePbxTenantNumber, type PbxProvisionedPhone } from "../pbxPhoneProvisioning";
import { connectOmbutelMysql } from "../pbxQueueDirectory";

type JwtUser = { sub: string; tenantId: string; email: string; role: string };
const getUser = (req: any): JwtUser => req.user as JwtUser;

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
function customerPhoneView(row: any) {
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
  })).max(500),
});

export async function registerDeskPhoneSetupRoutes(app: FastifyInstance, deps: DeskPhoneDeps) {
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
      if (existing) {
        // ⛔ THE ADDRESS MOVING IS EXPECTED, NOT A NEW PHONE. Record where it was.
        const moved = existing.ipAddress && facts.ipAddress && existing.ipAddress !== facts.ipAddress;
        await db.deskPhoneSetupPhone.update({
          where: { id: existing.id },
          data: { ...facts, previousIp: moved ? existing.ipAddress : existing.previousIp },
        });
      } else {
        await db.deskPhoneSetupPhone.create({
          data: { tenantId: user.tenantId, runId: run.id, macAddress: mac, state: "IDENTIFIED", ...facts },
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

    const updated = await db.deskPhoneSetupPhone.update({
      where: { id: phone.id },
      data: {
        extensionId: ext.id, extNumber: ext.extNumber, displayName: ext.displayName,
        state: "ASSIGNED",
      },
    });
    return reply.send({ ok: true, phone: customerPhoneView(updated) });
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
    await deps.audit({
      tenantId: user.tenantId, action: "DESK_PHONE_SELECTION_SET",
      entityType: "DeskPhoneSetupRun", entityId: run.id, actorUserId: user.sub,
      metadata: { selected: chosen.length, skipped: skipped.length },
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

    await db.deskPhoneSetupRun.update({
      where: { id: run.id },
      data: {
        resetAuthorizedAt: new Date(),
        resetAuthorizedByUserId: user.sub,
        resetAuthorizedPhoneIds: JSON.stringify(phones.map((p: any) => p.id)),
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
      // ⛔ Derived from stored facts, not asserted by the caller: an office machine
      // must not be able to declare that a phone needs wiping.
      oldSettingsInWay: !provisioningIsOurs && !!phone.provisioningUrl && !registeredToUs,
      modelProfileMissing: false,
      firmwareTooOld: false,
      provisioningRevertedAfterReset: phone.resetCount > 0 && !provisioningIsOurs && !!phone.provisioningUrl,
      networkSuppliesOldProvisioning: observed.data.networkSuppliesOldProvisioning ?? false,
      awaitingReboot: observed.data.awaitingReboot ?? phone.state === "WAITING_FOR_REBOOT",
      onACall: observed.data.onACall ?? false,
      passwordUnavailable: observed.data.passwordUnavailable ?? false,
      resetDeclined: observed.data.resetDeclined ?? false,
    };

    let decision = nextEscalation(condition, {
      state: phone.state as PhoneState,
      resetCount: phone.resetCount,
      resetAuthorizedAt: run.resetAuthorizedAt ? run.resetAuthorizedAt.toISOString() : null,
      attempts: phone.attempts,
    });
    // ⛔ A hand-off the office machine has given up on is ended here, not retried:
    // every further "set_provisioning" would restart somebody's phone again. The
    // ladder itself stays pure; this is the one caller-observed fact it acts on.
    if (decision.action === "set_provisioning" && observed.data.provisioningHandoffFailed) {
      decision = {
        action: "halt", rung: -1, halted: true, handOff: "support",
        reason: "office machine could not hand the phone its provisioning folder over PnP (bounded restarts, then listen-only)",
        customerMessage: "We could not point this phone at Loopcom from your computer. Loopcom Support can finish this one with you.",
      };
    }
    // The folder a reset phone needs, resolved only when the instruction is to
    // point the phone at us. Null means "no URL known" — the driver waits.
    let provisioningUrl: string | null = null;
    if (decision.action === "set_provisioning") {
      try { provisioningUrl = await (deps.provisioningUrlFor ?? defaultProvisioningUrlFor)(user.tenantId); }
      catch { provisioningUrl = null; }
    }

    // ⛔ A reset instruction is issued only if the stored record still allows it.
    // The ladder already checked; this checks again against the row, because the row
    // is the thing that survives a crash.
    if (decision.action === "reset_over_lan" || decision.action === "reset_over_sip") {
      const verdict = decideReset({
        state: phone.state as PhoneState, resetCount: phone.resetCount,
        resetAuthorizedAt: run.resetAuthorizedAt ? run.resetAuthorizedAt.toISOString() : null,
        attempts: phone.attempts,
      });
      if (!verdict.allowed) {
        return reply.send({
          ok: true, action: "halt", halted: true,
          customerMessage: verdict.explain,
          phone: customerPhoneView(phone),
        });
      }
      // ⛔⛔ THE CLAIM IS ATOMIC, AND THAT IS NOT OPTIONAL. `decideReset` is correct,
      // but two advance calls landing at once would both read resetCount=0, both pass
      // the check, and both issue a wipe — a check-then-act race on the one operation
      // that must never happen twice. The updateMany is guarded on the resetCount and
      // state we just read, so exactly one concurrent caller flips the row and the
      // rest see count=0. Same pattern as every other single-use claim in this repo.
      const claim = await db.deskPhoneSetupPhone.updateMany({
        where: { id: phone.id, resetCount: phone.resetCount, state: phone.state },
        data: {
          state: "RESET_REQUESTED", resetCount: phone.resetCount + 1,
          resetRequestedAt: new Date(), attempts: phone.attempts + 1,
        },
      });
      if (!claim || claim.count !== 1) {
        // ⛔ Somebody else advanced this phone between our read and our write. We do
        // NOT issue a second reset; we report the phone's current state instead.
        const now = await db.deskPhoneSetupPhone.findFirst({ where: { id: phone.id } });
        return reply.send({
          ok: true, action: "do_nothing", rung: 0, halted: false, handOff: null,
          customerMessage: null, phone: customerPhoneView(now ?? phone),
        });
      }
      await deps.audit({
        tenantId: user.tenantId, action: "DESK_PHONE_RESET_REQUESTED",
        entityType: "DeskPhoneSetupPhone", entityId: phone.id, actorUserId: user.sub,
        metadata: { mac: phone.macAddress, via: decision.action },
      });
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
    } else if (decision.action === "do_nothing" && registeredToUs && provisioningIsOurs) {
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
      ...(decision.action === "set_provisioning" ? { provisioningUrl } : {}),
      phone: customerPhoneView(fresh),
    });
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
