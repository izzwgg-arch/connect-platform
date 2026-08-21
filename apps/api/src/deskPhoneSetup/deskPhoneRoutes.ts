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
  buildButtonLayout, serializeButtonLayout, customerStateFor, decideReset, isTerminal,
  nextEscalation, normalizeMac, sanitizeDeviceText, summarizeRun,
  type PhoneCondition, type PhoneState,
} from "@connect/shared";

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
};

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

async function mayAuthorizeReset(req: any, reply: any): Promise<JwtUser | null> {
  const user = await mayRunSetup(req, reply);
  if (!user) return null;
  if (!(await userHasActionPermission(user, "can_authorize_phone_reset"))) {
    reply.status(403).send({
      error: "forbidden",
      message: "You are not allowed to clear a phone. Ask somebody who is.",
    });
    return null;
  }
  return user;
}

const isSuper = (user: JwtUser) => String(user?.role || "").toUpperCase() === "SUPER_ADMIN";

/** What the customer's screen gets. ⛔ Nothing technical crosses this boundary. */
function customerPhoneView(row: any) {
  return {
    id: row.id,
    model: row.model || null,
    vendor: row.vendor || null,
    displayName: row.displayName || null,
    extNumber: row.extNumber || null,
    status: customerStateFor(row.state as PhoneState),
    note: row.customerNote || null,
    needsAttention: row.state === "NEEDS_ATTENTION" || row.state === "FAILED",
  };
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
    const user = await mayRunSetup(req, reply); if (!user) return;
    const parsed = discoveredBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_request" });

    const run = await db.deskPhoneSetupRun.findFirst({
      where: { id: String(req.params.id), tenantId: user.tenantId },
    });
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
      const facts = {
        ipAddress: p.ip ? sanitizeDeviceText(p.ip, 64) : null,
        vendor: p.vendor ? sanitizeDeviceText(p.vendor, 80) : null,
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

    const phones = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    return reply.send({
      ok: true,
      // ⛔ The subnet is always returned, so a short list reads as "here is where we
      // looked" and never as "this office has three phones".
      subnet: parsed.data.subnet || run.subnet || null,
      dropped,
      stored,
      phones: phones.map(customerPhoneView),
    });
  });

  /* ── who sits where ────────────────────────────────────────────────────── */

  app.post("/desk-phones/runs/:id/phones/:phoneId/assign", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const body = z.object({ extensionId: z.string().min(1).nullable() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: String(req.params.id), tenantId: user.tenantId },
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

  /* ── permission to wipe ────────────────────────────────────────────────── */

  app.post("/desk-phones/runs/:id/authorize-reset", async (req: any, reply: any) => {
    const user = await mayAuthorizeReset(req, reply); if (!user) return;
    const body = z.object({ phoneIds: z.array(z.string().min(1)).min(1).max(500) }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_request" });

    const run = await db.deskPhoneSetupRun.findFirst({
      where: { id: String(req.params.id), tenantId: user.tenantId, status: "running" },
    });
    if (!run) return reply.status(404).send({ error: "not_found" });

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
    const user = await mayRunSetup(req, reply); if (!user) return;
    const observed = z.object({
      reachableOnLan: z.boolean().optional(),
      locked: z.boolean().optional(),
      defaultCredentialsTried: z.boolean().optional(),
      haveCustomerCredentials: z.boolean().optional(),
      onACall: z.boolean().optional(),
      awaitingReboot: z.boolean().optional(),
      networkSuppliesOldProvisioning: z.boolean().optional(),
    }).safeParse(req.body ?? {});
    if (!observed.success) return reply.status(400).send({ error: "invalid_request" });

    const run = await db.deskPhoneSetupRun.findFirst({
      where: { id: String(req.params.id), tenantId: user.tenantId },
    });
    if (!run) return reply.status(404).send({ error: "not_found" });
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: run.id, tenantId: user.tenantId },
    });
    if (!phone) return reply.status(404).send({ error: "not_found" });

    // ⛔⛔ REGISTRATION IS ASKED OF ASTERISK, NEVER INFERRED. A phone that accepted
    // our settings is not a working phone; only the PBX reporting the endpoint
    // registered turns anything green.
    let registeredToUs = false;
    if (phone.extNumber && deps.isRegistered) {
      try { registeredToUs = await deps.isRegistered(user.tenantId, phone.extNumber); }
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
    };

    const decision = nextEscalation(condition, {
      state: phone.state as PhoneState,
      resetCount: phone.resetCount,
      resetAuthorizedAt: run.resetAuthorizedAt ? run.resetAuthorizedAt.toISOString() : null,
      attempts: phone.attempts,
    });

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
      await db.deskPhoneSetupPhone.update({
        where: { id: phone.id },
        data: {
          state: "RESET_REQUESTED", resetCount: phone.resetCount + 1,
          resetRequestedAt: new Date(), attempts: phone.attempts + 1,
        },
      });
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
      phone: customerPhoneView(fresh),
    });
  });

  /* ── progress ──────────────────────────────────────────────────────────── */

  app.get("/desk-phones/runs/:id", async (req: any, reply: any) => {
    const user = await mayRunSetup(req, reply); if (!user) return;
    const run = await db.deskPhoneSetupRun.findFirst({
      where: { id: String(req.params.id), tenantId: user.tenantId },
    });
    if (!run) return reply.status(404).send({ error: "not_found" });
    const phones = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    const wantsDiagnostics = String((req.query || {}).view || "") === "diagnostics";
    const summary = summarizeRun(phones.map((p: any) => p.state as PhoneState));
    return reply.send({
      ok: true,
      run: { id: run.id, status: run.status, subnet: run.subnet, startedAt: run.startedAt, origin: run.origin },
      summary,
      phones: phones.map(wantsDiagnostics ? diagnosticPhoneView : customerPhoneView),
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
    const summary = summarizeRun(phones.map((p: any) => p.state as PhoneState));
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
    const body = z.object({ tenantId: z.string().min(1) }).safeParse(req.body ?? {});
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

  app.get("/admin/desk-phones/runs/:id", async (req: any, reply: any) => {
    const user = getUser(req);
    if (!user?.sub || !isSuper(user)) return reply.status(403).send({ error: "forbidden" });
    const run = await db.deskPhoneSetupRun.findFirst({ where: { id: String(req.params.id) } });
    if (!run) return reply.status(404).send({ error: "not_found" });
    const phones = await db.deskPhoneSetupPhone.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" } });
    return reply.send({
      ok: true,
      run: { id: run.id, tenantId: run.tenantId, status: run.status, subnet: run.subnet, origin: run.origin, startedAt: run.startedAt },
      summary: summarizeRun(phones.map((p: any) => p.state as PhoneState)),
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
    const user = await mayRunSetup(req, reply); if (!user) return;
    const phone = await db.deskPhoneSetupPhone.findFirst({
      where: { id: String(req.params.phoneId), runId: String(req.params.id), tenantId: user.tenantId },
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
}

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
