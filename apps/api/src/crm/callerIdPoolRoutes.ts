/**
 * CRM Caller ID Pool routes — Phase 4B (Local Presence)
 *
 * Manages the CrmCallerIdPool: tenant-owned DID → area code associations for
 * outbound local presence caller ID selection.
 *
 * IMPORTANT: POST /crm/calls/originate is ADVISORY ONLY.
 * It selects and returns a caller ID but does NOT place any call.
 * The actual call is placed client-side via WebRTC/SIP (useSipPhone.ts → phone.dial()).
 * Do NOT add AMI/ARI originate logic here — that would touch the PBX.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@connect/db";
import { requireCrmAccess, requireCrmAdmin } from "./guard";
import { selectCrmCallerId, normalizeToE164Us, extractAreaCode3 } from "./localPresenceHelper";

// ── Formatters ────────────────────────────────────────────────────────────────

function formatPoolEntry(entry: any) {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    phoneNumberId: entry.phoneNumberId,
    areaCode3: entry.areaCode3,
    label: entry.label ?? null,
    isActive: entry.isActive,
    phoneNumber: entry.phoneNumber
      ? {
          id: entry.phoneNumber.id,
          phoneNumber: entry.phoneNumber.phoneNumber,
          friendlyName: entry.phoneNumber.friendlyName ?? null,
          areaCode: entry.phoneNumber.areaCode ?? null,
          status: entry.phoneNumber.status,
        }
      : null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

const PHONE_NUMBER_SELECT = {
  id: true,
  phoneNumber: true,
  friendlyName: true,
  areaCode: true,
  status: true,
  tenantId: true,
};

// ── Route registrar ───────────────────────────────────────────────────────────

export async function registerCrmCallerIdPoolRoutes(app: FastifyInstance) {

  // ── GET /crm/caller-id-pool ────────────────────────────────────────────────
  // List all pool entries for this tenant. Available to any CRM-enabled user.
  app.get("/crm/caller-id-pool", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const q = req.query as Record<string, string>;
    const activeOnly = q.active !== "false"; // default: only active

    const entries = await (db as any).crmCallerIdPool.findMany({
      where: {
        tenantId,
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ areaCode3: "asc" }, { createdAt: "asc" }],
      include: { phoneNumber: { select: PHONE_NUMBER_SELECT } },
    });

    return { pool: entries.map(formatPoolEntry) };
  });

  // ── GET /crm/caller-id-pool/available-numbers ──────────────────────────────
  // List tenant-owned PhoneNumbers NOT already in the pool, for the "Add to pool" UI.
  // Admin-only.
  app.get("/crm/caller-id-pool/available-numbers", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;

    // Get phoneNumberIds already in the pool
    const pooled = await (db as any).crmCallerIdPool.findMany({
      where: { tenantId },
      select: { phoneNumberId: true },
    });
    const pooledIds = new Set<string>((pooled as any[]).map((p: any) => p.phoneNumberId));

    const numbers = await (db as any).phoneNumber.findMany({
      where: { tenantId, status: "ACTIVE" },
      orderBy: { phoneNumber: "asc" },
      select: PHONE_NUMBER_SELECT,
    });

    const available = (numbers as any[]).filter((n: any) => !pooledIds.has(n.id));

    return { numbers: available };
  });

  // ── GET /crm/caller-id-pool/suggest ───────────────────────────────────────
  // Advisory: given a destination number, returns the caller ID that would be
  // selected for this tenant. Safe to call for testing the pool configuration.
  app.get("/crm/caller-id-pool/suggest", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const q = req.query as Record<string, string>;
    const to = (q.to ?? "").trim();

    if (!to) return reply.status(400).send({ error: "missing_to" });

    const normalized = normalizeToE164Us(to);
    const areaCode3 = normalized ? extractAreaCode3(normalized) : null;
    const callerId = await selectCrmCallerId(tenantId, to);

    // Also read localPresenceEnabled for context
    const settings = await (db as any).crmTenantSettings.findUnique({
      where: { tenantId },
      select: { localPresenceEnabled: true },
    });

    return {
      to,
      normalizedTo: normalized ? `+1${normalized}` : null,
      areaCode3,
      localPresenceEnabled: settings?.localPresenceEnabled ?? false,
      selectedCallerId: callerId ?? null,
      matched: !!callerId,
    };
  });

  // ── POST /crm/caller-id-pool ───────────────────────────────────────────────
  // Add a PhoneNumber to the local presence pool. Admin-only.
  // Validates that the phoneNumberId belongs to this tenant — cross-tenant
  // numbers cannot be added.
  app.post("/crm/caller-id-pool", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;

    const schema = z.object({
      phoneNumberId: z.string().min(1),
      areaCode3: z.string().regex(/^\d{3}$/, "Must be exactly 3 digits"),
      label: z.string().max(100).optional().nullable(),
      isActive: z.boolean().default(true),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", issues: parsed.error.issues });
    }

    // Verify the phoneNumber belongs to this tenant — hard guard against cross-tenant spoofing
    const phoneNumber = await (db as any).phoneNumber.findFirst({
      where: { id: parsed.data.phoneNumberId, tenantId, status: "ACTIVE" },
      select: PHONE_NUMBER_SELECT,
    });
    if (!phoneNumber) {
      return reply.status(404).send({
        error: "phone_number_not_found",
        detail: "PhoneNumber does not exist or does not belong to this tenant",
      });
    }

    try {
      const entry = await (db as any).crmCallerIdPool.create({
        data: {
          tenantId,
          phoneNumberId: parsed.data.phoneNumberId,
          areaCode3: parsed.data.areaCode3,
          label: parsed.data.label ?? null,
          isActive: parsed.data.isActive,
        },
        include: { phoneNumber: { select: PHONE_NUMBER_SELECT } },
      });
      return reply.status(201).send({ entry: formatPoolEntry(entry) });
    } catch (err: any) {
      if (err?.code === "P2002") {
        return reply.status(409).send({ error: "already_in_pool", detail: "This number is already in the pool" });
      }
      throw err;
    }
  });

  // ── PATCH /crm/caller-id-pool/:id ─────────────────────────────────────────
  // Update a pool entry (area code, label, active state). Admin-only.
  app.patch("/crm/caller-id-pool/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const schema = z.object({
      areaCode3: z.string().regex(/^\d{3}$/, "Must be exactly 3 digits").optional(),
      label: z.string().max(100).optional().nullable(),
      isActive: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", issues: parsed.error.issues });
    }

    // Verify tenant ownership
    const existing = await (db as any).crmCallerIdPool.findFirst({
      where: { id, tenantId },
    });
    if (!existing) return reply.status(404).send({ error: "not_found" });

    const entry = await (db as any).crmCallerIdPool.update({
      where: { id },
      data: {
        ...(parsed.data.areaCode3 !== undefined ? { areaCode3: parsed.data.areaCode3 } : {}),
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.isActive !== undefined ? { isActive: parsed.data.isActive } : {}),
      },
      include: { phoneNumber: { select: PHONE_NUMBER_SELECT } },
    });

    return { entry: formatPoolEntry(entry) };
  });

  // ── DELETE /crm/caller-id-pool/:id ────────────────────────────────────────
  // Remove a number from the local presence pool. Admin-only.
  // Does NOT delete the PhoneNumber itself — only the pool association.
  app.delete("/crm/caller-id-pool/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { tenantId } = user;
    const { id } = req.params as { id: string };

    const existing = await (db as any).crmCallerIdPool.findFirst({
      where: { id, tenantId },
    });
    if (!existing) return reply.status(404).send({ error: "not_found" });

    await (db as any).crmCallerIdPool.delete({ where: { id } });
    return { ok: true };
  });

  // ── POST /crm/calls/originate ──────────────────────────────────────────────
  // CRM-aware caller ID selection + call-intent logging.
  //
  // ┌─────────────────────────────────────────────────────────────────────┐
  // │  ADVISORY ONLY — does NOT place a call.                             │
  // │  Returns the selected callerId; the client calls phone.dial(dest).  │
  // │  If callerId is null, the client proceeds with default caller ID.   │
  // └─────────────────────────────────────────────────────────────────────┘
  app.post("/crm/calls/originate", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { tenantId, sub: userId } = user;

    const schema = z.object({
      destination: z.string().min(1).max(40),
      contactId: z.string().optional(),
      memberId: z.string().optional(),
      campaignId: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_payload", issues: parsed.error.issues });
    }

    const { destination, contactId, memberId, campaignId } = parsed.data;

    // Normalize the destination
    const normalized = normalizeToE164Us(destination);
    const e164destination = normalized ? `+1${normalized}` : destination;
    const areaCode3 = normalized ? extractAreaCode3(normalized) : null;

    // Select local presence caller ID — never throws; returns undefined on any failure
    const callerId = await selectCrmCallerId(tenantId, destination);

    // Read localPresenceEnabled for response context
    const settings = await (db as any).crmTenantSettings.findUnique({
      where: { tenantId },
      select: { localPresenceEnabled: true },
    });
    const localPresenceEnabled = settings?.localPresenceEnabled ?? false;

    // Log the call intent for audit/debugging (non-blocking)
    const logEntry = {
      tenantId,
      userId,
      destination: e164destination,
      areaCode3: areaCode3 ?? null,
      localPresenceEnabled,
      selectedCallerId: callerId ?? null,
      contactId: contactId ?? null,
      memberId: memberId ?? null,
      campaignId: campaignId ?? null,
      timestamp: new Date().toISOString(),
    };
    // Fire-and-forget to CrmTimelineEvent if contactId is provided
    if (contactId) {
      (db as any).crmTimelineEvent.create({
        data: {
          tenantId,
          contactId,
          type: "NOTE_ADDED",
          title: `CRM call initiated to ${e164destination}`,
          body: callerId
            ? `Local presence caller ID selected: ${callerId} (area code ${areaCode3})`
            : "No local presence match — using default caller ID",
          metadata: {
            callIntent: true,
            destination: e164destination,
            areaCode3,
            selectedCallerId: callerId ?? null,
            memberId: memberId ?? null,
            campaignId: campaignId ?? null,
          },
          createdByUserId: userId,
        },
      }).catch(() => {});
    }

    return reply.status(200).send({
      ok: true,
      destination: e164destination,
      callerId: callerId ?? null,
      areaCode3,
      localPresenceEnabled,
      selectedFromPool: !!callerId,
      meta: logEntry,
    });
  });
}
