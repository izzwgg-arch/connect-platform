/**
 * Voice-agent routes.
 *
 * THREE internal doors (telephony only — shared internal secret, fail-closed,
 * and each MUST be on the JWT bypass list or the auth hook 401s it before the
 * secret check ever runs — the documented twice-shipped trap):
 *   POST /internal/voice-agent/session-start
 *   POST /internal/voice-agent/tool
 *   POST /internal/voice-agent/session-end
 *
 * Admin doors are SUPER_ADMIN only (injected requireSuper) AND covered by a
 * PORTAL_API_PERMISSION_RULES prefix entry in server.ts — the wake-health
 * lesson: an /admin route with no rule entry silently skips the global gate.
 *
 * ⛔ The tenant's OpenAI key rides ProviderCredential/OPENAI via the
 * supermarket integration vault: write-only in, decrypted ONLY inside
 * session-start's response to telephony. NO platform-key fallback exists —
 * `process.env.OPENAI` appears nowhere in this module, and a guard test keeps
 * it that way.
 */

import { z } from "zod";
import { checkInternalSecret } from "../internalSecret";
import { resolveIntegrationKey, storeIntegrationKey } from "../supermarket/integrationCredentials";
import {
  buildInstructions,
  clampInt,
  decideSessionStart,
  sanitizeToolLog,
  sanitizeTranscript,
  type VoiceAgentSettingsLike,
} from "./voiceAgentPolicy";
import { executeVoiceAgentTool } from "./voiceAgentTools";

export interface VoiceAgentRouteDeps {
  db: any;
  /** Returns true when the caller may use the admin doors; sends the refusal itself. */
  requireSuper: (req: any, reply: any) => boolean | Promise<boolean>;
  log?: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void };
}

const REALTIME_MODELS = ["gpt-realtime", "gpt-realtime-mini"] as const;
const REALTIME_VOICES = ["cedar", "marin", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;

const sessionStartSchema = z.object({
  sessionUuid: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  pbxTenant: z.string().regex(/^[0-9]{1,6}$/),
  did: z.string().max(20).nullish(),
  callerNumber: z.string().max(20).nullish(),
});

const toolSchema = z.object({
  callId: z.string().min(1).max(64),
  tenantId: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  argumentsJson: z.string().max(20_000),
});

const sessionEndSchema = z.object({
  callId: z.string().min(1).max(64),
  seconds: z.number().min(0).max(24 * 3600),
  endReason: z.string().max(40),
  transcript: z.unknown().optional(),
  toolCalls: z.unknown().optional(),
  draftId: z.string().max(64).nullish(),
});

const settingsPutSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.enum(REALTIME_MODELS).optional(),
  voice: z.enum(REALTIME_VOICES).optional(),
  greeting: z.string().max(500).optional(),
  instructionsExtra: z.string().max(4000).optional(),
  maxCallSeconds: z.number().int().min(60).max(3600).optional(),
  maxConcurrentCalls: z.number().int().min(1).max(32).optional(),
  monthlyMinuteCap: z.number().int().min(0).max(1_000_000).optional(),
  openAiKey: z.string().min(8).max(512).optional(),
});

const catalogImportSchema = z.object({
  items: z
    .array(
      z.object({
        code: z.string().min(1).max(40),
        name: z.string().min(1).max(200),
        unitPriceCents: z.number().int().min(0).max(10_000_000),
      }),
    )
    .min(1)
    .max(2000),
  replace: z.boolean().optional(),
});

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function registerVoiceAgentRoutes(app: any, deps: VoiceAgentRouteDeps): void {
  const { db } = deps;
  const log = deps.log ?? { warn: () => undefined, info: () => undefined };

  const guard = (req: any, reply: any): boolean => {
    const verdict = checkInternalSecret(
      process.env.CDR_INGEST_SECRET,
      (req?.headers as Record<string, string | undefined> | undefined)?.["x-cdr-secret"],
    );
    if (verdict.ok) return true;
    reply.code(verdict.status).send({ error: verdict.error });
    return false;
  };

  // ── internal: session-start ───────────────────────────────────────────────
  app.post("/internal/voice-agent/session-start", async (req: any, reply: any) => {
    if (!guard(req, reply)) return reply;
    const parsed = sessionStartSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, reason: "bad_request" });
    const { sessionUuid, pbxTenant, did, callerNumber } = parsed.data;

    const link = await db.tenantPbxLink
      .findFirst({ where: { pbxTenantId: pbxTenant }, select: { tenantId: true } })
      .catch(() => null);
    if (!link) return reply.send({ ok: false, reason: "tenant_not_linked" });
    const tenantId: string = link.tenantId;

    const settingsRow = await db.voiceAgentSettings
      .findUnique({ where: { tenantId } })
      .catch(() => null);
    const settings: VoiceAgentSettingsLike | null = settingsRow
      ? {
          enabled: Boolean(settingsRow.enabled),
          model: String(settingsRow.model || "gpt-realtime"),
          voice: String(settingsRow.voice || "cedar"),
          greeting: String(settingsRow.greeting || ""),
          instructionsExtra: String(settingsRow.instructionsExtra || ""),
          maxCallSeconds: clampInt(settingsRow.maxCallSeconds, 60, 3600, 600),
          maxConcurrentCalls: clampInt(settingsRow.maxConcurrentCalls, 1, 32, 4),
          monthlyMinuteCap: clampInt(settingsRow.monthlyMinuteCap, 0, 1_000_000, 3000),
        }
      : null;

    // ⛔ The TENANT'S key only — resolveIntegrationKey never falls back.
    const key = await resolveIntegrationKey(db, tenantId, "OPENAI");

    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    const activeCalls = await db.voiceAgentCall
      .count({ where: { tenantId, endedAt: null, startedAt: { gte: twoHoursAgo } } })
      .catch(() => 0);
    const agg = await db.voiceAgentCall
      .aggregate({ where: { tenantId, startedAt: { gte: monthStart() } }, _sum: { seconds: true } })
      .catch(() => null);
    const minutesThisMonth = Math.round(Number(agg?._sum?.seconds ?? 0) / 60);

    const decision = decideSessionStart({
      settings,
      hasOpenAiKey: Boolean(key),
      activeCalls,
      minutesThisMonth,
    });
    if (!decision.allow) {
      log.info({ tenantId, reason: decision.reason }, "voice-agent session refused");
      return reply.send({ ok: false, reason: decision.reason });
    }

    let call;
    try {
      call = await db.voiceAgentCall.create({
        data: { tenantId, sessionUuid, callerNumber: callerNumber ?? null, did: did ?? null },
        select: { id: true },
      });
    } catch {
      // Unique sessionUuid: a replayed start must not mint a second call row.
      return reply.send({ ok: false, reason: "duplicate_session" });
    }

    const tenant = await db.tenant
      .findUnique({ where: { id: tenantId }, select: { name: true } })
      .catch(() => null);
    // The store's own name for the AI to use. VoiceAgentSettings has no
    // storeName column (kept off the shared schema); the tenant name is the
    // source, and the greeting/instructionsExtra carry any nicer wording.
    const storeName = String(tenant?.name || "the store");

    return reply.send({
      ok: true,
      callId: call.id,
      tenantId,
      apiKey: key!.apiKey,
      model: settings!.model,
      voice: settings!.voice,
      greeting: settings!.greeting,
      maxCallSeconds: decision.maxCallSeconds,
      instructions: buildInstructions({
        storeName,
        instructionsExtra: settings!.instructionsExtra,
        callerNumber,
      }),
    });
  });

  // ── internal: tool execution ──────────────────────────────────────────────
  app.post("/internal/voice-agent/tool", async (req: any, reply: any) => {
    if (!guard(req, reply)) return reply;
    const parsed = toolSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, output: JSON.stringify({ error: "bad_request" }) });
    const result = await executeVoiceAgentTool({ db, ...parsed.data });
    return reply.send(result);
  });

  // ── internal: session-end ─────────────────────────────────────────────────
  app.post("/internal/voice-agent/session-end", async (req: any, reply: any) => {
    if (!guard(req, reply)) return reply;
    const parsed = sessionEndSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false });
    const { callId, seconds, endReason, draftId } = parsed.data;
    await db.voiceAgentCall
      .updateMany({
        where: { id: callId, endedAt: null },
        data: {
          endedAt: new Date(),
          seconds: Math.round(seconds),
          endReason: endReason.slice(0, 40),
          transcript: sanitizeTranscript(parsed.data.transcript),
          toolCalls: sanitizeToolLog(parsed.data.toolCalls),
          ...(draftId ? { draftId } : {}),
        },
      })
      .catch(() => undefined);
    return reply.send({ ok: true });
  });

  // ── admin: settings ───────────────────────────────────────────────────────
  app.get("/admin/voice-agent/:tenantId", async (req: any, reply: any) => {
    if (!(await deps.requireSuper(req, reply))) return reply;
    const tenantId = String(req.params?.tenantId ?? "");
    const settings = await db.voiceAgentSettings.findUnique({ where: { tenantId } }).catch(() => null);
    const key = await resolveIntegrationKey(db, tenantId, "OPENAI");
    const catalogCount = await db.posCatalogItem.count({ where: { tenantId, isActive: true } }).catch(() => 0);
    const calls = await db.voiceAgentCall
      .findMany({
        where: { tenantId },
        orderBy: { startedAt: "desc" },
        take: 20,
        select: { id: true, sessionUuid: true, callerNumber: true, startedAt: true, endedAt: true, seconds: true, endReason: true, draftId: true },
      })
      .catch(() => []);
    return reply.send({
      settings,
      openAiKeyConfigured: Boolean(key),
      catalogCount,
      calls,
    });
  });

  app.put("/admin/voice-agent/:tenantId", async (req: any, reply: any) => {
    if (!(await deps.requireSuper(req, reply))) return reply;
    const tenantId = String(req.params?.tenantId ?? "");
    const parsed = settingsPutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", detail: parsed.error.issues[0]?.message });
    }
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }).catch(() => null);
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });

    const { openAiKey, ...fields } = parsed.data;
    if (openAiKey) {
      await storeIntegrationKey(db, {
        tenantId,
        provider: "OPENAI",
        apiKey: openAiKey,
        actorUserId: String(req.user?.sub ?? "unknown"),
      });
    }
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) data[k] = v;
    const row = await db.voiceAgentSettings.upsert({
      where: { tenantId },
      update: data,
      create: { tenantId, ...data },
    });
    return reply.send({ ok: true, settings: row, openAiKeyStored: Boolean(openAiKey) });
  });

  // ── admin: manual catalog import (tenants without a live POS sync) ────────
  app.post("/admin/voice-agent/:tenantId/catalog-import", async (req: any, reply: any) => {
    if (!(await deps.requireSuper(req, reply))) return reply;
    const tenantId = String(req.params?.tenantId ?? "");
    const parsed = catalogImportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation_error", detail: parsed.error.issues[0]?.message });
    }
    const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }).catch(() => null);
    if (!tenant) return reply.code(404).send({ error: "tenant_not_found" });

    if (parsed.data.replace) {
      // Only manual rows are replaceable — POS-synced rows belong to the sync.
      await db.posCatalogItem.deleteMany({ where: { tenantId, posProductId: { startsWith: "manual:" } } });
    }
    let upserted = 0;
    for (const item of parsed.data.items) {
      await db.posCatalogItem.upsert({
        where: { tenantId_posProductId: { tenantId, posProductId: `manual:${item.code}` } },
        update: { code: item.code, name: item.name, unitPriceCents: item.unitPriceCents, priceCents: item.unitPriceCents, isActive: true },
        create: {
          tenantId,
          posProductId: `manual:${item.code}`,
          code: item.code,
          name: item.name,
          priceCents: item.unitPriceCents,
          unitPriceCents: item.unitPriceCents,
          isActive: true,
        },
      });
      upserted++;
    }
    return reply.send({ ok: true, upserted });
  });
}
