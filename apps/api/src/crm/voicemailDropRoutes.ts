import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@connect/db";
import { resolvePbxRouteHelperConfig } from "../pbxInboundRouteHelperClient";
import { pushPromptToHelper } from "../pbxPromptPushClient";
import {
  buildSignedCrmVoicemailDropUrl,
  contentTypeForCrmVoicemailDrop,
  readCrmVoicemailDropAudio,
  verifySignedCrmVoicemailDropUrl,
  writeCrmVoicemailDropAudio,
} from "../crmVoicemailDropStorage";
import { requireCrmAccess, requireCrmAdmin } from "./guard";
import { writeTimelineEvent } from "./timelineHelper";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  campaignId: z.string().min(1).nullable().optional(),
  isDefault: z.boolean().optional(),
  status: z.enum(["READY", "PROCESSING", "FAILED", "ARCHIVED"]).optional(),
});

const dropSchema = z.object({
  activeCallId: z.string().min(1),
  contactId: z.string().min(1),
  voicemailDropId: z.string().min(1),
});

function model() {
  return (db as any).crmVoicemailDrop;
}

function publicBaseUrl(req: any): string {
  const fromEnv = String(process.env.PUBLIC_API_BASE_URL || process.env.API_PUBLIC_BASE_URL || "").trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0]?.trim() || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost:3001").split(",")[0]?.trim();
  return `${proto}://${host}`;
}

function boolField(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}

function fieldString(fields: Record<string, any>, name: string): string | null {
  const value = fields[name]?.value ?? fields[name];
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}

function formatDrop(row: any, req: any) {
  const streamUrl = row?.pbxStorageKey
    ? buildSignedCrmVoicemailDropUrl(publicBaseUrl(req), row.id, row.pbxStorageKey, 900)
    : null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    name: row.name,
    description: row.description ?? null,
    status: row.status,
    durationSeconds: row.durationSeconds ?? null,
    originalFileName: row.originalFileName ?? null,
    originalMimeType: row.originalMimeType ?? null,
    campaignId: row.campaignId ?? null,
    campaign: row.campaign ? { id: row.campaign.id, name: row.campaign.name } : null,
    isDefault: !!row.isDefault,
    usageCount: row.usageCount ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
    conversionStatus: row.conversionStatus,
    conversionError: row.conversionError ?? null,
    pbxFormat: row.pbxFormat ?? null,
    streamUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function setDefaultExclusive(tenantId: string, dropId: string) {
  await model().updateMany({
    where: { tenantId, id: { not: dropId }, status: { not: "ARCHIVED" } },
    data: { isDefault: false },
  });
}

async function verifyCampaign(tenantId: string, campaignId: string | null | undefined) {
  if (!campaignId) return null;
  const campaign = await (db as any).crmCampaign.findFirst({
    where: { id: campaignId, tenantId, status: { not: "ARCHIVED" } },
    select: { id: true },
  });
  return campaign ? campaignId : null;
}

async function pushDropToPbx(input: {
  tenantId: string;
  pbxStorageKey: string;
  pbxFileBaseName: string;
  contentHash: string;
  sizeBytes: number;
  dropId: string;
  requestedBy: string;
}) {
  const link = await (db as any).tenantPbxLink.findUnique({
    where: { tenantId: input.tenantId },
    select: { pbxInstanceId: true, pbxTenantId: true, pbxTenantCode: true },
  });
  const cfg = resolvePbxRouteHelperConfig(link?.pbxInstanceId);
  if (!cfg) return { pushed: false, reason: "pbx_helper_unavailable" };
  const bytes = await readCrmVoicemailDropAudio(input.pbxStorageKey);
  const resp = await pushPromptToHelper(
    cfg,
    {
      fileBaseName: input.pbxFileBaseName,
      sha256: input.contentHash,
      sizeBytes: input.sizeBytes,
      tenantSlug: link?.pbxTenantCode || link?.pbxTenantId || input.tenantId,
      promptRef: `crm_voicemail_drop:${input.dropId}`,
      requestedBy: input.requestedBy,
    },
    bytes,
  );
  return { pushed: true, response: resp };
}

async function requestTelephonyPlayback(input: {
  linkedId: string;
  tenantId: string;
  fileBaseName: string;
  targetLeg?: "external" | "agent";
}) {
  const base = (process.env.TELEPHONY_INTERNAL_URL ?? "http://telephony:3003").replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = String(process.env.CDR_INGEST_SECRET || "").trim();
  if (secret) headers["x-cdr-secret"] = secret;
  const res = await fetch(`${base}/telephony/internal/calls/play-prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => "");
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = String(json?.error || "pbx_playback_failed");
    const err: any = new Error(error);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function registerCrmVoicemailDropRoutes(app: FastifyInstance) {
  app.get("/crm/voicemail-drops", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const q = req.query as Record<string, string | undefined>;
    const includeArchived = q.includeArchived === "true";
    const search = String(q.search || "").trim();
    const campaignId = String(q.campaignId || "").trim();
    const where: any = {
      tenantId: user.tenantId,
      ...(includeArchived ? {} : { status: { not: "ARCHIVED" } }),
      ...(campaignId ? { campaignId } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    };
    const drops = await model().findMany({
      where,
      include: { campaign: { select: { id: true, name: true } } },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    });
    const ready = drops.filter((d: any) => d.status === "READY");
    const duration = ready.reduce((sum: number, d: any) => sum + (d.durationSeconds || 0), 0);
    const usage = drops.reduce((sum: number, d: any) => sum + (d.usageCount || 0), 0);
    return {
      voicemailDrops: drops.map((d: any) => formatDrop(d, req)),
      stats: {
        totalRecordings: drops.length,
        totalDurationSeconds: duration,
        dropSuccessRate: usage > 0 ? 100 : 0,
      },
    };
  });

  app.post("/crm/voicemail-drops", async (req: any, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    if (!req.isMultipart?.()) return reply.code(400).send({ error: "multipart_required" });

    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) return reply.code(400).send({ error: "file_required" });
    const fields = file.fields ?? {};
    const name = fieldString(fields, "name");
    if (!name) return reply.code(400).send({ error: "invalid_payload", message: "Name is required." });
    const description = fieldString(fields, "description");
    const campaignId = await verifyCampaign(user.tenantId, fieldString(fields, "campaignId"));
    const isDefault = boolField(fields.isDefault?.value ?? fields.isDefault);
    const buffer = await file.toBuffer();
    const id = randomUUID();

    let row: any = await model().create({
      data: {
        id,
        tenantId: user.tenantId,
        createdByUserId: user.sub,
        name: name.slice(0, 200),
        description,
        campaignId,
        isDefault,
        originalFileName: file.filename ?? "voicemail.wav",
        originalMimeType: file.mimetype ?? null,
        status: "PROCESSING",
        conversionStatus: "processing",
      },
    });

    try {
      const audio = await writeCrmVoicemailDropAudio({
        tenantId: user.tenantId,
        dropId: id,
        originalFilename: file.filename ?? "voicemail.wav",
        originalMimeType: file.mimetype ?? null,
        buffer,
      });
      row = await model().update({
        where: { id },
        data: {
          ...audio,
          status: "READY",
          conversionStatus: "ready",
          conversionError: null,
        },
        include: { campaign: { select: { id: true, name: true } } },
      });
      if (isDefault) await setDefaultExclusive(user.tenantId, id);
      void pushDropToPbx({
        tenantId: user.tenantId,
        pbxStorageKey: audio.pbxStorageKey,
        pbxFileBaseName: audio.pbxFileBaseName,
        contentHash: audio.contentHash,
        sizeBytes: audio.sizeBytes,
        dropId: id,
        requestedBy: user.sub,
      }).catch((err) => app.log.warn({ err, dropId: id }, "crm voicemail drop PBX push failed"));
      return reply.code(201).send({ voicemailDrop: formatDrop(row, req) });
    } catch (err: any) {
      row = await model().update({
        where: { id },
        data: {
          status: "FAILED",
          conversionStatus: "failed",
          conversionError: String(err?.message || err).slice(0, 1000),
        },
        include: { campaign: { select: { id: true, name: true } } },
      });
      return reply.code(422).send({ error: "audio_conversion_failed", voicemailDrop: formatDrop(row, req) });
    }
  });

  app.post("/crm/voicemail-drops/drop", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const parsed = dropSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });
    const { activeCallId, contactId, voicemailDropId } = parsed.data;

    const [contact, drop] = await Promise.all([
      (db as any).contact.findFirst({
        where: { id: contactId, tenantId: user.tenantId, active: true },
        select: { id: true, displayName: true },
      }),
      model().findFirst({ where: { id: voicemailDropId, tenantId: user.tenantId } }),
    ]);
    if (!contact) return reply.code(404).send({ error: "contact_not_found" });
    if (!drop) return reply.code(404).send({ error: "voicemail_drop_not_found" });
    if (drop.status !== "READY" || !drop.pbxStorageKey || !drop.pbxFileBaseName) {
      return reply.code(409).send({ error: "voicemail_drop_not_ready", status: drop.status });
    }

    try {
      const pushResult = await pushDropToPbx({
        tenantId: user.tenantId,
        pbxStorageKey: drop.pbxStorageKey,
        pbxFileBaseName: drop.pbxFileBaseName,
        contentHash: drop.contentHash || "",
        sizeBytes: drop.sizeBytes || 0,
        dropId: drop.id,
        requestedBy: user.sub,
      });
      if (!pushResult.pushed) {
        return reply.code(503).send({ error: pushResult.reason || "pbx_helper_unavailable" });
      }
      const playback = await requestTelephonyPlayback({
        linkedId: activeCallId,
        tenantId: user.tenantId,
        fileBaseName: drop.pbxFileBaseName,
        targetLeg: "external",
      });
      await model().update({
        where: { id: drop.id },
        data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
      });
      await writeTimelineEvent({
        tenantId: user.tenantId,
        contactId,
        type: "VOICEMAIL_DROP",
        title: `Voicemail Drop — ${drop.name}`,
        body: drop.durationSeconds ? `Duration ${drop.durationSeconds}s` : null,
        linkedId: drop.id,
        createdByUserId: user.sub,
        metadata: {
          voicemailDropId: drop.id,
          recordingName: drop.name,
          durationSeconds: drop.durationSeconds ?? null,
          callId: activeCallId,
          status: "Voicemail Dropped",
          playbackId: playback?.playbackId ?? null,
        },
      });
      await (db as any).crmContactMeta.updateMany({
        where: { tenantId: user.tenantId, contactId },
        data: { lastActivityAt: new Date() },
      });
      return { ok: true, playbackStarted: true, voicemailDropId: drop.id, contactId, callId: activeCallId };
    } catch (err: any) {
      const status = Number(err?.status || 503);
      const body = err?.body && typeof err.body === "object" ? err.body : {};
      return reply.code(status >= 400 && status < 600 ? status : 503).send({
        error: body.error || err?.message || "pbx_playback_failed",
        detail: body.detail || undefined,
      });
    }
  });

  app.post("/crm/voicemail-drops/:id/play-test", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const drop = await model().findFirst({ where: { id, tenantId: user.tenantId } });
    if (!drop) return reply.code(404).send({ error: "not_found" });
    if (drop.status !== "READY" || !drop.pbxStorageKey) return reply.code(409).send({ error: "voicemail_drop_not_ready" });
    return { ok: true, streamUrl: buildSignedCrmVoicemailDropUrl(publicBaseUrl(req), drop.id, drop.pbxStorageKey, 300) };
  });

  app.get("/crm/voicemail-drops/:id/stream", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as Record<string, string | undefined>;
    const drop = await model().findFirst({ where: { id }, select: { id: true, tenantId: true, pbxStorageKey: true } });
    if (!drop?.pbxStorageKey) return reply.code(404).send({ error: "not_found" });
    const verified = verifySignedCrmVoicemailDropUrl(drop.id, drop.pbxStorageKey, q.exp, q.sig);
    if (!verified.ok) return reply.code(403).send({ error: verified.reason === "expired" ? "signed_url_expired" : "invalid_signature" });
    const bytes = await readCrmVoicemailDropAudio(drop.pbxStorageKey);
    reply.header("content-type", contentTypeForCrmVoicemailDrop(drop.pbxStorageKey));
    reply.header("cache-control", "private, max-age=300");
    return reply.send(bytes);
  });

  app.get("/crm/voicemail-drops/:id", async (req, reply) => {
    const user = await requireCrmAccess(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const drop = await model().findFirst({
      where: { id, tenantId: user.tenantId },
      include: { campaign: { select: { id: true, name: true } } },
    });
    if (!drop) return reply.code(404).send({ error: "not_found" });
    return { voicemailDrop: formatDrop(drop, req) };
  });

  app.patch("/crm/voicemail-drops/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await model().findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_payload", issues: parsed.error.issues });
    const campaignId = parsed.data.campaignId !== undefined
      ? await verifyCampaign(user.tenantId, parsed.data.campaignId)
      : undefined;
    const drop = await model().update({
      where: { id },
      data: {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(campaignId !== undefined ? { campaignId } : {}),
        ...(parsed.data.isDefault !== undefined ? { isDefault: parsed.data.isDefault } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      },
      include: { campaign: { select: { id: true, name: true } } },
    });
    if (parsed.data.isDefault === true) await setDefaultExclusive(user.tenantId, id);
    return { voicemailDrop: formatDrop(drop, req) };
  });

  app.delete("/crm/voicemail-drops/:id", async (req, reply) => {
    const user = await requireCrmAdmin(req, reply);
    if (!user) return;
    const { id } = req.params as { id: string };
    const existing = await model().findFirst({ where: { id, tenantId: user.tenantId }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await model().update({ where: { id }, data: { status: "ARCHIVED", isDefault: false } });
    return { ok: true };
  });
}
