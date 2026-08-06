/**
 * Connect AI Agent — service entrypoint (Phase 0 scaffold).
 * Boots disabled by default; /health always answers; /agent/status reports the
 * exact runtime state (enabled, kill switch, providers, manifest gate counts).
 * NO PBX writes exist anywhere in this service. See docs/ai-support-agent/PLAN.md.
 */
import Fastify from "fastify";
import { loadConfig, killSwitchEngaged } from "./config";
import { AuditLog, FileAuditSink, type AuditSink } from "./audit/audit";
import { Notifier } from "./notify/notifier";
import { ModelRouter, PING_MAX_TOKENS } from "./llm/router";
import { loadManifest, executableCapabilities } from "./manifest/manifest";
import { getPrisma } from "./db";
import { ConversationEngine } from "./conversation/engine";
import { PrismaConversationStore } from "./conversation/store";
import { registerChatRoutes } from "./conversation/routes";
import { ReadTools } from "./tools/readTools";
import { buildTools } from "./tools/toolRegistry";
import { buildPermissionTools } from "./tools/permissionGrant";
import { DiagnosticsEngine } from "./diag/engine";
import { registerDiagRoutes } from "./diag/routes";
import { ActionService } from "./actions/service";
import { registerActionRoutes } from "./actions/routes";
import { makePbxBackend } from "./actions/pbxBackend";
import { ScopedPbxExecutor } from "./pbx/executor";
import { ModifyPbxExecutor } from "./pbx/modifyExecutor";
import { makeModifyBackend } from "./pbx/modifyBackend";
import { SnapshotStore } from "./pbx/snapshotStore";
import { makeScopeCheck } from "./pbx/scopeCheck";
import { buildModifyCatalog } from "./pbx/modifyCatalog";
import { makeMohApiClient } from "./pbx/mohApiClient";
import { makeRouteApiClient } from "./pbx/routeApiClient";
import { makeIvrApiClient } from "./pbx/ivrApiClient";
import { makeQueueApiClient } from "./pbx/queueApiClient";
import { makeExtFeatureApiClient } from "./pbx/extFeatureApiClient";
import { makePbxClientFactory } from "./pbx/client";
import { buildIdentityContext, renderIdentityBlock } from "./channels/identityContext";
import { DossierService } from "./conversation/dossier";
import { TriageOrchestrator } from "./triage/orchestrator";
import { WatchmanRunner } from "./watchman/runner";
import { registerAdminRoutes } from "./actions/adminRoutes";
import { registerPolicyAdminRoutes } from "./policy/adminRoutes";
import { IdentityResolver } from "./channels/identity";
import { EmailChannel } from "./channels/email";
import { MessagingChannelHandler, NullMessagingTransport } from "./channels/messaging";
import { VoiceStudio } from "./voice/studio";
import { KnowledgeBase } from "./knowledge/kb";
import { TrainerLessonService } from "./training/lessons";
import { verifyPortalJwt } from "./auth";
import { buildProvisioningPlan } from "./pbx/provisioningPlan";
import { DigestJobs } from "./jobs/digest";
import { RateLimiter } from "./guards/limits";
import { SecretStore, type SecretKey } from "./secrets/store";
import { YiddishLabsClient } from "./transcription/yiddishlabs";
import { CorpusService } from "./corpus/corpus";
import { SEED_GLOSSARY, type DialectTerm } from "./corpus/glossary";
import { ArchiveIngestor, MemoryArchiveProgress } from "./corpus/archive";
import { Transcriber } from "./transcription/transcriber";

class PrismaAuditSink implements AuditSink {
  constructor(private prisma: any) {}
  async write(row: any): Promise<void> {
    await this.prisma.agentAuditLog.create({
      data: {
        ts: new Date(row.ts),
        actor: row.actor,
        event: row.event,
        tenantId: row.tenantId ?? null,
        conversationId: row.conversationId ?? null,
        actionId: row.actionId ?? null,
        capabilityId: row.capabilityId ?? null,
        payload: row.payload ?? undefined,
        hash: row.hash,
      },
    });
  }
}

async function main() {
  const cfg = loadConfig();
  const prisma = await getPrisma();
  const sinks: AuditSink[] = [new FileAuditSink(cfg.auditDir)];
  if (prisma) sinks.push(new PrismaAuditSink(prisma));
  const audit = new AuditLog(sinks);
  const notifier = new Notifier(cfg, audit);
  const router = new ModelRouter(cfg, audit);
  const manifest = loadManifest();

  const app = Fastify({ logger: true, bodyLimit: 20 * 1024 * 1024 }); // 20MB: mic audio clips

  let engine: ConversationEngine | null = null;
  let actionService: ActionService | null = null;
  if (prisma) {
    // Action + approval lifecycle. PBX backend runs the Scoped Executor.
    // liveWrites is FALSE unless the operator explicitly enables it AND the
    // capability is liveEnabled — provisioning stays simulation-only until PW-2.
    const pbxExecutor = new ScopedPbxExecutor(
      prisma,
      audit,
      makePbxClientFactory({ baseUrl: process.env.PBX_BASE_URL, apiToken: process.env.PBX_API_TOKEN }),
    );
    // X1 Modify pipeline — MODIFY_CATALOG is EMPTY and the client factory below
    // HARDCODES simulate:true (the live client is deliberately not wired; that
    // happens per-capability from M1 on, each under its own certification).
    // X2 wired the real G3 scope resolver (Connect-mirror ownership proof;
    // unmapped objectTypes still refuse fail-closed).
    const pbxReadFactory = makePbxClientFactory({ baseUrl: process.env.PBX_BASE_URL, apiToken: process.env.PBX_API_TOKEN });
    const modifyExecutor = new ModifyPbxExecutor(
      prisma,
      audit,
      new SnapshotStore(prisma),
      () => pbxReadFactory({ simulate: true, allowConfigMutations: false }),
      {
        scopeCheck: makeScopeCheck(prisma),
        // M1/M2: tenant + extension MOH via the api's internal door.
        // M3: route retarget via the api's route door (isolated helper endpoint
        // installed 2026-07-23). Live dispatch STILL requires the full gate chain
        // (master switch off by default, T21-only allow-list, Izzy-bound single-
        // use approval, snapshot, verify) — wiring the client does NOT enable it.
        catalog: buildModifyCatalog({ prisma, mohApi: makeMohApiClient(), routeApi: makeRouteApiClient(), ivrApi: makeIvrApiClient(), queueApi: makeQueueApiClient(), extFeatureApi: makeExtFeatureApiClient() }),
      },
    );
    const modifyBackend = makeModifyBackend(modifyExecutor);
    actionService = new ActionService(
      prisma,
      audit,
      notifier,
      {
        "pbx.": makePbxBackend(pbxExecutor),
        "action.": makePbxBackend(pbxExecutor),
        // Longest-prefix routing sends pbx.M*/pbx.E* here, not to "pbx.".
        "pbx.M": modifyBackend,
        "pbx.E": modifyBackend,
        "repair.": modifyBackend,
      },
      { approvalBaseUrl: process.env.AGENT_PUBLIC_BASE_URL, liveWrites: process.env.AGENT_PBX_LIVE_WRITES === "1" },
    );

    const diagEngine = new DiagnosticsEngine(new ReadTools(prisma), prisma, audit, notifier, router);
    const loadPolicy = async (tenantId: string) => {
      try {
        const p = await prisma.agentPolicy.findUnique({ where: { tenantId } });
        return p ? { tenantId, version: p.version, updatedBy: p.updatedBy, historyVisible: p.historyVisible, channels: (p.channels ?? []) as any, grants: (p.grants ?? {}) as any } : null;
      } catch {
        return null;
      }
    };
    const { makeMohUploadApiClient } = await import("./pbx/mohUploadApiClient");
    // M3/M4/M10 doors (owner directive 2026-07-28): the orchestrator reads the
    // live tenant catalog through these to ground LLM extraction and answer
    // status questions; all WRITES still go through ActionService → executor.
    const triage = new TriageOrchestrator(
      prisma,
      diagEngine,
      actionService,
      loadPolicy,
      router,
      makeMohUploadApiClient(),
      makeRouteApiClient(),
      makeIvrApiClient(),
      makeQueueApiClient(),
    );
    const rateLimiter = new RateLimiter();

    // Secret store — owner-managed API keys (Assistant page), encrypted at rest.
    // Keys resolve: store (DB, decrypted) → env fallback. Mutable providerKeys
    // are shared by reference with the transcriber + Yiddish bridge + reloaded
    // into the router, so saving a key from the UI takes effect WITHOUT a restart.
    let secCrypto: any;
    try {
      const sec = await import("@connect/security");
      secCrypto = { encryptJson: sec.encryptJson, decryptJson: sec.decryptJson, hasMasterKey: sec.hasCredentialsMasterKey };
    } catch {
      secCrypto = { encryptJson: () => { throw new Error("no_security"); }, decryptJson: () => null, hasMasterKey: () => false };
    }
    const secrets = new SecretStore(prisma, secCrypto, audit);
    const providerKeys = {
      openaiApiKey: (await secrets.get("openai_api_key")) ?? cfg.openaiApiKey,
      // Everett == ivrit.ai on RunPod. Owner pastes the RunPod key from the
      // Assistant page (secret "ivrit_api_key"); endpoint id is config with a
      // sensible default so it works out of the box.
      everettApiKey: (await secrets.get("ivrit_api_key")) ?? cfg.everettApiKey,
      everettEndpointId: process.env.IVRIT_ENDPOINT_ID || cfg.everettEndpointId || "536xyqv8oyqygx",
      yiddishLabsApiKey: (await secrets.get("yiddishlabs_api_key")) ?? cfg.yiddishLabsApiKey,
      elevenLabsApiKey: (await secrets.get("elevenlabs_api_key")) ?? cfg.elevenLabsApiKey,
    };
    const anthropicResolved = (await secrets.get("anthropic_api_key")) ?? cfg.anthropicApiKey;
    router.reload({ openaiApiKey: providerKeys.openaiApiKey, anthropicApiKey: anthropicResolved });
    // Owner's chat-model pick (Assistant page) survives restarts via the store.
    {
      const { parseChatModelPick } = await import("./llm/router");
      const pick = parseChatModelPick(await secrets.get("chat_model"));
      if (pick) router.setChatModel(pick);
    }

    // Yiddish translate-bridge: reads the LIVE YL key from providerKeys each call,
    // so saving a key from the Assistant page hot-reloads with no restart. When a
    // Yiddish chat comes in, YL translates it to English for the LLM and the
    // English reply back to authentic Yiddish — the model never emits Yiddish.
    //
    // SPEED: every translation goes through a persistent cache first. YL's
    // English→Yiddish leg is a fixed ~7–10s; a cache hit returns in 0ms with 0
    // credits, so fixed templates + repeated phrases are instant.
    const { YiddishLabsClient: YLClient } = await import("./transcription/yiddishlabs");
    const { TranslationCache } = await import("./transcription/translationCache");
    const { PREWARM_EN, PREWARM_YI } = await import("./transcription/prewarm");
    const translationCache = new TranslationCache(prisma);
    const translateCached = async (action: "translate-english" | "translate-yiddish", text: string) => {
      const cached = await translationCache.get(action, text);
      if (cached != null) return { text: cached, creditsConsumed: 0, cached: true };
      const cli = new YLClient(providerKeys.yiddishLabsApiKey);
      const r = action === "translate-english" ? await cli.toEnglish(text) : await cli.toYiddish(text);
      if (r.text) await translationCache.set(action, text, r.text);
      return { ...r, cached: false };
    };
    const yiddishBridge = {
      get configured() { return !!providerKeys.yiddishLabsApiKey; },
      toEnglish: (t: string) => translateCached("translate-english", t),
      toYiddish: (t: string) => translateCached("translate-yiddish", t),
    };
    // X2: verified identity + per-user dossier at session open. Recording is
    // UNCONDITIONAL — the history visibility toggle never suppresses it.
    const dossiers = new DossierService(prisma, audit, router);
    const contextProvider = async (ctx: { tenantId: string; clientUserId: string | null }) => {
      const built = await buildIdentityContext(prisma, ctx);
      if (!built.ok) return { ok: false as const, reason: built.reason };
      const dossierMd = ctx.clientUserId ? await dossiers.load(ctx.tenantId, ctx.clientUserId) : null;
      return { ok: true as const, block: renderIdentityBlock(built.context, dossierMd) };
    };
    // Trainer mode: designated testers (AGENT_TRAINER_USER_IDS) teach the agent
    // live via "add that to your memory"; lessons apply immediately, everything
    // is audited, and the owner revokes from the AI Trainer page.
    const trainerLessons = new TrainerLessonService(prisma, audit, router);
    // Read tools for the conversation: the model can look THIS account's own
    // data up mid-chat. Role gating inside the registry decides what a customer
    // vs an owner may reach; the tenant is always bound from the verified ctx.
    // Read tools everyone gets (role-gated inside), plus the owner-only
    // permission-grant PREPARE tool. Preparing writes a DRAFT only — the grant
    // is applied by the API after the portal re-checks the password.
    const chatTools = [
      ...buildTools({ readTools: new ReadTools(prisma), prisma }),
      ...buildPermissionTools({ prisma }),
    ];
    engine = new ConversationEngine(new PrismaConversationStore(prisma), router, audit, triage, rateLimiter, yiddishBridge, cfg.yiddishBridge, contextProvider, trainerLessons, chatTools);

    // Warm the in-memory cache from the DB, then pre-translate fixed templates
    // (once) so common replies are instant. Runs in the background — never
    // blocks boot, and no-ops without a YL key.
    const prewarmTemplates = async () => {
      await translationCache.warmFromDb();
      if (!providerKeys.yiddishLabsApiKey) return;
      const cli = new YLClient(providerKeys.yiddishLabsApiKey);
      let warmed = 0;
      for (const en of PREWARM_EN) {
        if ((await translationCache.get("translate-yiddish", en)) != null) continue;
        try { const r = await cli.toYiddish(en); if (r.text) { await translationCache.set("translate-yiddish", en, r.text, true); warmed++; } } catch { /* skip */ }
      }
      for (const yi of PREWARM_YI) {
        if ((await translationCache.get("translate-english", yi)) != null) continue;
        try { const r = await cli.toEnglish(yi); if (r.text) { await translationCache.set("translate-english", yi, r.text, true); warmed++; } } catch { /* skip */ }
      }
      await audit.record({ actor: "system", event: "translation.prewarmed", payload: { warmed, ...translationCache.stats() } });
      return warmed;
    };
    void prewarmTemplates();

    // ivrit.ai (RunPod) keep-warm: ping the endpoint on an interval so a worker
    // stays hot and transcription avoids cold starts. Off by default; enable with
    // AGENT_IVRIT_KEEPWARM=1 (also raise the endpoint Idle Timeout in RunPod).
    if (process.env.AGENT_IVRIT_KEEPWARM === "1") {
      const { startIvritKeepWarm } = await import("./transcription/keepwarm");
      const hoursParts = (process.env.AGENT_IVRIT_KEEPWARM_HOURS || "").split("-").map((s) => Number(s.trim()));
      startIvritKeepWarm({
        apiKey: () => providerKeys.everettApiKey,
        endpointId: () => providerKeys.everettEndpointId,
        model: process.env.EVERETT_MODEL || "ivrit-ai/yi-whisper-large-v3-turbo-ct2",
        intervalSec: Number(process.env.AGENT_IVRIT_KEEPWARM_INTERVAL_SEC || 240),
        hours: hoursParts.length === 2 && hoursParts.every((n) => Number.isFinite(n)) ? [hoursParts[0], hoursParts[1]] : undefined,
        audit,
      });
      await audit.record({ actor: "system", event: "ivrit.keepwarm_started", payload: { intervalSec: Number(process.env.AGENT_IVRIT_KEEPWARM_INTERVAL_SEC || 240), hours: process.env.AGENT_IVRIT_KEEPWARM_HOURS || "always" } });
    }

    // Owner console — translation cache visibility + manual pre-warm.
    app.get("/agent/admin/translations/stats", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      let dbCount = 0, pinned = 0;
      try { dbCount = await prisma.agentTranslation.count(); pinned = await prisma.agentTranslation.count({ where: { pinned: true } }); } catch { /* ignore */ }
      return { cache: translationCache.stats(), dbEntries: dbCount, pinnedTemplates: pinned };
    });
    app.post("/agent/admin/translations/prewarm", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const warmed = await prewarmTemplates();
      return { ok: true, warmed, stats: translationCache.stats() };
    });

    // Chat-widget file uploads (chunked; audio → hold-music flow, docs → team).
    // NB: the folder is "attachments", NOT "uploads" — the root .dockerignore
    // excludes **/uploads (runtime storage) and would drop the module from the
    // image (live crash-loop 2026-07-27).
    const { ChatUploadStore } = await import("./attachments/uploadStore");
    const uploadStore = new ChatUploadStore(process.env.AGENT_UPLOAD_DIR || "./data/chat-uploads");
    registerChatRoutes(app, engine, uploadStore, prisma);
    registerDiagRoutes(app, diagEngine);
    registerActionRoutes(app, actionService);
    registerAdminRoutes(app, prisma);
    registerPolicyAdminRoutes(app, prisma, audit);

    // ── AI Trainer (owner) + widget UI-event logging ──
    app.get("/agent/admin/trainer/lessons", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      return { lessons: await trainerLessons.listAll() };
    });
    app.post("/agent/admin/trainer/lessons/revoke", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const auth = (req.headers as any).authorization as string | undefined;
      const who = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7))?.clientUserId ?? "owner" : "owner";
      const body = (req.body ?? {}) as any;
      if (typeof body.id !== "string" || !body.id) return reply.code(400).send({ error: "bad_request" });
      const lesson = await trainerLessons.revoke(body.id, `owner:${who}`);
      return lesson ? { ok: true, lesson } : reply.code(404).send({ error: "not_found_or_already_revoked" });
    });
    // Every widget button press, timestamped — part of the "log every little
    // detail" trainer requirement. Identity-verified; body is a short label.
    app.post("/agent/chat/ui-event", async (req, reply) => {
      const { resolveIdentity } = await import("./conversation/routes");
      const identity = resolveIdentity(req as any);
      if (!identity) return reply.code(403).send({ error: "forbidden" });
      const body = (req.body ?? {}) as any;
      const name = typeof body.name === "string" ? body.name.slice(0, 60) : "";
      if (!name) return reply.code(400).send({ error: "bad_request" });
      await audit.record({
        actor: identity.role === "owner" ? "owner" : "customer",
        event: "chat.ui_event",
        tenantId: identity.tenantId,
        payload: { name, userId: identity.clientUserId },
      });
      return { ok: true };
    });

    // Email channel: inbound support mail → identity → engine → reply.
    // Exposed for the IMAP poller / webhook to POST parsed messages into.
    const emailChannel = new EmailChannel(engine, new IdentityResolver(prisma), notifier, audit);
    app.post("/agent/channels/email/inbound", async (req, reply) => {
      const secret = process.env.AGENT_INTERNAL_SECRET;
      if (!secret || req.headers["x-agent-internal-secret"] !== secret) return reply.code(403).send({ error: "forbidden" });
      const body = (req.body ?? {}) as any;
      if (typeof body.from !== "string" || typeof body.text !== "string") return reply.code(400).send({ error: "bad_request" });
      return emailChannel.handleInbound({ from: body.from, subject: body.subject, text: body.text, messageId: body.messageId });
    });

    // SMS / WhatsApp channel. Transport is Null until Twilio creds exist; the
    // inbound webhook (from the Twilio adapter) posts normalized messages here.
    const messaging = new MessagingChannelHandler(engine, new IdentityResolver(prisma), new NullMessagingTransport(), audit);
    app.post("/agent/channels/messaging/inbound", async (req, reply) => {
      const secret = process.env.AGENT_INTERNAL_SECRET;
      if (!secret || req.headers["x-agent-internal-secret"] !== secret) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      if (typeof b.from !== "string" || typeof b.text !== "string" || (b.channel !== "sms" && b.channel !== "whatsapp")) return reply.code(400).send({ error: "bad_request" });
      return messaging.handleInbound({ from: b.from, text: b.text, channel: b.channel, messageSid: b.messageSid });
    });

    // Voice Studio (owner-only). Manage voices + render prompt audio (guarded
    // until ElevenLabs key). Deploy-to-IVR is action A12/P14 — not here.
    const voiceStudio = new VoiceStudio(prisma, providerKeys as any, audit);

    // ── ElevenLabs: connection check + voice list ─────────────────────────
    // Proves the saved key actually works and shows what it can reach, so the
    // settings page never just says "saved" and leaves someone guessing.
    app.get("/agent/voice/elevenlabs/status", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const key = providerKeys.elevenLabsApiKey;
      const { describeElevenLabsKey, classifyElevenLabsFailure, isElevenLabsKeyFailure } = await import("@connect/shared");
      // The saved key's shape, never the key. This is the only way for the
      // owner to tell that what they pasted is what actually got stored — a
      // password field silently refilled by a browser looks identical to a
      // successful paste, and reads as "I saved a good key and it's broken".
      const shape = describeElevenLabsKey(key);
      const keyInfo = shape ? { keyHint: `…${shape.last4}`, keyLooksCurrent: shape.looksCurrent, keyLooksLegacy: shape.looksLegacy } : {};
      if (!key) return { configured: false, reachable: false, reason: "no_key" };
      try {
        // Bounded: a hung provider must never hang the settings page with it.
        const [subRes, voicesRes] = await Promise.all([
          fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) }),
          fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(15_000) }),
        ]);
        if (!subRes.ok) {
          // Read the body and say what THEY said. Mapping only 401 to
          // "invalid_key" was the bug: a retired-format key answers 400, so
          // this page told the owner the provider was unreachable — pointing
          // the blame at Connect for a problem only they can fix, on their
          // account. Anything 4xx is about the key; 5xx is genuinely them.
          const body = await subRes.text().catch(() => "");
          const message = classifyElevenLabsFailure(body.slice(0, 400));
          return {
            ...keyInfo,
            configured: true,
            reachable: false,
            reason: isElevenLabsKeyFailure(subRes.status, body) ? "invalid_key" : `http_${subRes.status}`,
            /** Written for the owner; the page shows it verbatim. */
            message,
          };
        }
        const sub: any = await subRes.json();
        const voicesJson: any = voicesRes.ok ? await voicesRes.json() : { voices: [] };
        // "Reachable" is not the same as "will actually make a recording".
        // An account with an unpaid invoice answers this endpoint with 200 and
        // then returns 401 on synthesis, so a badge based on reachability alone
        // reads "connected" on a system that fails the moment anyone presses
        // Generate — and sends the owner off checking a key that was never the
        // problem. `status` says so here, for free.
        const subStatus = String(sub?.status ?? "").toLowerCase();
        const used = Number(sub?.character_count ?? 0);
        const limit = Number(sub?.character_limit ?? 0);
        // ⛔ Only `past_due` blocks. `has_open_invoices` is true on a healthy
        // account for most of every month — it counts the NEXT invoice too.
        // Blocking on it told an owner with a paid-up account and $100 of
        // credit that they had an unpaid bill, and refused to generate audio
        // the provider was perfectly willing to make (proven 2026-08-06:
        // status active + has_open_invoices true + synthesis 200).
        const blocked =
          subStatus === "past_due"
            ? "ElevenLabs has an unpaid invoice on this account, so it won't make new recordings. The key is fine — settle the bill at elevenlabs.io and this starts working again."
            : limit > 0 && used >= limit
              ? "This account has used all its characters for the month. It resets on the next billing date, or you can upgrade the plan."
              : null;
        return {
          ...keyInfo,
          configured: true,
          reachable: true,
          /** Reachable AND able to synthesise right now. */
          usable: !blocked,
          blockedReason: blocked,
          subscriptionStatus: sub?.status ?? null,
          tier: sub?.tier ?? null,
          characterCount: sub?.character_count ?? null,
          characterLimit: sub?.character_limit ?? null,
          // Cloning is a plan feature; the UI needs to know before offering it.
          canClone: !!sub?.can_use_instant_voice_cloning,
          voices: (voicesJson.voices ?? []).map((v: any) => ({
            voiceId: v.voice_id,
            name: v.name,
            category: v.category ?? null,
            labels: v.labels ?? {},
            previewUrl: v.preview_url ?? null,
          })),
        };
      } catch (err: any) {
        return { ...keyInfo, configured: true, reachable: false, reason: "unreachable", detail: String(err?.message ?? "").slice(0, 200) };
      }
    });
    const requireOwner = (req: any) => {
      const auth = req.headers.authorization;
      const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
      return id?.role === "owner";
    };
    app.get("/agent/voice/voices", async (req, reply) => (requireOwner(req) ? { voices: await voiceStudio.listVoices() } : reply.code(403).send({ error: "forbidden" })));
    app.post("/agent/voice/render", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      if (!b.voiceId || !b.text) return reply.code(400).send({ error: "bad_request" });
      return voiceStudio.render({ voiceId: b.voiceId, text: b.text, language: b.language === "yi" ? "yi" : "en" });
    });

    // Knowledge base — retrieval (owner) + approve (owner).
    const kb = new KnowledgeBase(prisma, audit);
    app.post("/agent/kb/retrieve", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      return { results: await kb.retrieve(String(b.query ?? ""), b.tenantId ?? null) };
    });

    // Owner bulk onboarding: build a tenant + extensions plan. Returns the
    // ordered, feasibility-graded steps for review. Execution is gated: each
    // step runs through the ActionService (approval + Scoped Executor), and
    // extension steps (feasibility=helper) stay simulation-only until PW-2 +
    // the create-extension helper is enabled in an owner window.
    app.post("/agent/provisioning/plan", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const built = buildProvisioningPlan(req.body);
      if (!built.ok) return reply.code(400).send({ error: "bad_request", detail: built.error });
      await audit.record({ actor: "owner", event: "provisioning.plan_built", payload: { steps: built.steps.length, warnings: built.warnings } });
      return { plan: built, note: "Preview only. Executing requires per-step approval; extension creation is live-gated until PW-2 (see docs/PBX_AUDIT.md)." };
    });

    // DB-backed scheduler ticks (survive restarts): close stale chats + expire/
    // auto-revert actions. Every 60s so minute-level revert timers ("switch my
    // extension's hold music back in 15 minutes") fire close to on-time; the
    // tick is two cheap indexed queries when nothing is due.
    setInterval(() => {
      actionService?.tick().catch((err) => app.log.error({ err }, "action tick failed"));
    }, 60 * 1000).unref();
    setInterval(() => {
      engine?.autoCloseStale().catch((err) => app.log.error({ err }, "autoCloseStale failed"));
      dossiers.sweep().catch((err) => app.log.error({ err }, "dossier sweep failed"));
    }, 5 * 60 * 1000).unref();

    // Watchman: read-only security + health monitoring loop (hourly). Detect +
    // alert only — never remediates. Exposed for on-demand run via owner route.
    const watchman = new WatchmanRunner(prisma, audit, notifier);
    app.post("/agent/watchman/run", async (req, reply) => {
      const secret = process.env.AGENT_INTERNAL_SECRET;
      if (!secret || req.headers["x-agent-internal-secret"] !== secret) return reply.code(403).send({ error: "forbidden" });
      return watchman.runOnce();
    });
    setInterval(() => {
      watchman.runOnce().catch((err) => app.log.error({ err }, "watchman run failed"));
    }, 60 * 60 * 1000).unref();

    // Learning loop: daily digest (7am local) + weekly self-review. Both are
    // gated to fire once per period using a simple last-run marker so restarts
    // don't double-send.
    const digest = new DigestJobs(prisma, audit, notifier);
    let lastDigestDay = "";
    let lastReviewWeek = "";
    app.post("/agent/jobs/digest", async (req, reply) => {
      const secret = process.env.AGENT_INTERNAL_SECRET;
      if (!secret || req.headers["x-agent-internal-secret"] !== secret) return reply.code(403).send({ error: "forbidden" });
      return digest.dailyDigest();
    });
    app.post("/agent/jobs/self-review", async (req, reply) => {
      const secret = process.env.AGENT_INTERNAL_SECRET;
      if (!secret || req.headers["x-agent-internal-secret"] !== secret) return reply.code(403).send({ error: "forbidden" });
      return digest.weeklySelfReview();
    });
    // Yiddish tuning corpus (YIDDISH_TUNING.md). Multi-source capture (live
    // calls 24/7, news hotline bulk, corrections) + dialect glossary + export.
    const loadGlossary = async (): Promise<DialectTerm[]> => {
      try {
        const db = await prisma.agentDialectTerm.findMany({ take: 5000 });
        const fromDb: DialectTerm[] = db.map((t: any) => ({ term: t.term, variants: t.variants, category: t.category, gloss: t.gloss, englishForm: t.englishForm, weight: t.weight }));
        return fromDb.length ? [...SEED_GLOSSARY, ...fromDb] : SEED_GLOSSARY;
      } catch {
        return SEED_GLOSSARY;
      }
    };
    const corpus = new CorpusService(prisma, audit, loadGlossary);
    const corpusAuth = (req: any) => {
      const secret = process.env.AGENT_INTERNAL_SECRET;
      return (secret && req.headers["x-agent-internal-secret"] === secret) || requireOwner(req);
    };
    app.post("/agent/corpus/capture", async (req, reply) => {
      if (!corpusAuth(req)) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      if (!b.recordingId || typeof b.text !== "string") return reply.code(400).send({ error: "bad_request" });
      return corpus.capture(b);
    });
    app.post("/agent/corpus/correct", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      if (!b.recordingId || !b.correctedText) return reply.code(400).send({ error: "bad_request" });
      await corpus.correct(b.recordingId, b.correctedText, b.correctedBy ?? "owner");
      return { ok: true };
    });
    app.post("/agent/corpus/approve", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      const result = await corpus.approve(b.recordingId);
      return { ok: true, ...result };
    });
    app.get("/agent/corpus/stats", async (req, reply) => (corpusAuth(req) ? corpus.stats() : reply.code(403).send({ error: "forbidden" })));
    app.get("/agent/corpus/review-queue", async (req, reply) => (requireOwner(req) ? { queue: await corpus.reviewQueue() } : reply.code(403).send({ error: "forbidden" })));
    // Compliance evidence: proves Yiddish Labs was used for transcription only,
    // never model training (yiddishLabsTrainingEligible must be 0).
    app.get("/agent/compliance/no-training", async (req, reply) => (requireOwner(req) ? corpus.complianceReport() : reply.code(403).send({ error: "forbidden" })));

    // Archive ingestor: point at a mounted drive of audio (thousands of hours)
    // and it works through it 24/7. Registered path lives in AGENT_ARCHIVE_ROOT
    // (or set via the owner route into AgentMemory). Transcription is guarded by
    // the STT key; until then it still catalogs (walks) the archive.
    const glossaryContext = async () => {
      const terms = await loadGlossary();
      // Compact bias string for STT: "Terms: a, b, c" (canonical + a few variants).
      const flat = terms.flatMap((t) => [t.term, ...(t.variants ?? [])]).slice(0, 200);
      return flat.length ? `Heimishe Yiddish terms: ${flat.join(", ")}` : "";
    };
    // (secret store + providerKeys are initialized earlier, above the engine,
    //  so the Yiddish translate-bridge can read the live YL key.)
    const transcriber = new Transcriber(prisma, providerKeys, audit, glossaryContext) as any;
    const archiveTx = { transcribe: (i: any) => transcriber.transcribe({ recordingId: i.recordingId, audioRef: i.audioRef, languageHint: i.languageHint }) };
    const archive = new ArchiveIngestor(corpus, new MemoryArchiveProgress(prisma), archiveTx, audit);
    const archiveRoot = () => process.env.AGENT_ARCHIVE_ROOT || "";
    app.post("/agent/archive/drain", async (req, reply) => {
      if (!corpusAuth(req)) return reply.code(403).send({ error: "forbidden" });
      const root = ((req.body as any)?.root as string) || archiveRoot();
      if (!root) return reply.code(400).send({ error: "no_archive_root", hint: "set AGENT_ARCHIVE_ROOT or pass {root}" });
      return archive.drain(root, Number((req.body as any)?.batch ?? 20));
    });
    app.get("/agent/archive/status", async (req, reply) => {
      if (!corpusAuth(req)) return reply.code(403).send({ error: "forbidden" });
      return { root: archiveRoot(), progress: await new MemoryArchiveProgress(prisma).stats() };
    });

    // Yiddish Labs webhook — completed async transcriptions post here. Verified
    // by a shared secret in the URL/header (set YIDDISHLABS_WEBHOOK_SECRET). On
    // completion we capture into the corpus with the DETECTED language.
    app.post("/agent/webhooks/yiddishlabs", async (req, reply) => {
      const secret = cfg.yiddishLabsWebhookSecret;
      const provided = (req.headers["x-webhook-secret"] as string) || (req.query as any)?.secret;
      if (!secret || provided !== secret) return reply.code(403).send({ error: "forbidden" });
      const body = (req.body ?? {}) as any;
      const d = body.data ?? body;
      if (body.event && body.event !== "transcription.completed") return { ignored: body.event };
      if (!d?.id || !d?.text) return reply.code(400).send({ error: "bad_payload" });
      const { YiddishLabsClient } = await import("./transcription/yiddishlabs");
      const language = YiddishLabsClient.normalizeLanguage({ id: d.id, status: "completed", text: d.text, language: d.language });
      await corpus.capture({ recordingId: `yl_${d.id}`, text: d.text, model: "yiddishlabs", source: "live_call", confidence: 0.9 });
      await audit.record({ actor: "agent", event: "yiddishlabs.webhook_completed", payload: { id: d.id, language, words: d.word_count } });
      return { ok: true, language };
    });

    // ── UI translation ────────────────────────────────────────────────────
    // Translate interface text into Yiddish with Yiddish Labs. Screens are
    // translated by YL and NOTHING else — the model never writes Yiddish, the
    // same rule the chat bridge already follows. YL's own wording is markedly
    // better than a literal rendering ("Opening hours" comes back as "our
    // hours when we are open"), which is the whole reason for routing through
    // it rather than having something else translate.
    //
    // Batched and cache-first because a screen has dozens of labels and an
    // uncached YL call takes ~7-10s. Results are PINNED: interface text is a
    // fixed vocabulary, so once a page is translated it should never be paid
    // for again. Concurrency is capped so warming a whole screen doesn't open
    // sixty sockets at once.
    app.post("/agent/ui/translate", async (req, reply) => {
      if (!corpusAuth(req)) return reply.code(403).send({ error: "forbidden" });
      const body = (req.body ?? {}) as { strings?: unknown; warm?: unknown };
      const raw = Array.isArray(body.strings) ? body.strings : [];
      const strings = Array.from(new Set(
        raw.map((s) => String(s ?? "").trim()).filter((s) => s.length > 0 && s.length <= 400),
      )).slice(0, 400);
      if (strings.length === 0) return { translations: {}, cached: 0, fresh: 0, configured: !!providerKeys.yiddishLabsApiKey };

      const translations: Record<string, string> = {};
      const missing: string[] = [];
      for (const s of strings) {
        const hit = await translationCache.get("translate-yiddish", s);
        if (hit != null) translations[s] = hit; else missing.push(s);
      }

      // Without a key we return what is cached and say so. We never invent
      // Yiddish and never fall back to the English string dressed up as a
      // translation — the caller decides what to do with the gap.
      if (!providerKeys.yiddishLabsApiKey) {
        return { translations, cached: Object.keys(translations).length, fresh: 0, missing: missing.length, configured: false };
      }
      // `warm: false` (the default for a live page load) answers from cache
      // only, so a customer flipping the toggle never waits on YL. Warming is
      // an explicit, admin-triggered pass.
      if (body.warm !== true) {
        return { translations, cached: Object.keys(translations).length, fresh: 0, missing: missing.length, configured: true };
      }

      const cli = new YLClient(providerKeys.yiddishLabsApiKey);
      let fresh = 0;
      const failed: string[] = [];
      const queue = missing.slice();
      const worker = async () => {
        for (;;) {
          const s = queue.shift();
          if (s === undefined) return;
          try {
            const r = await cli.toYiddish(s);
            if (r.text) {
              await translationCache.set("translate-yiddish", s, r.text, true); // pinned
              translations[s] = r.text;
              fresh++;
            } else failed.push(s);
          } catch { failed.push(s); }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      await audit.record({ actor: "system", event: "ui.translated", payload: { requested: strings.length, fresh, failed: failed.length } });
      return { translations, cached: strings.length - missing.length, fresh, failed: failed.length, configured: true };
    });

    // Yiddish Labs admin — status + recent transcripts by detected language.
    app.get("/agent/yiddishlabs/status", async (req, reply) => {
      if (!corpusAuth(req)) return reply.code(403).send({ error: "forbidden" });
      const byLang = async (l: string) => { try { return await prisma.agentTranscript.count({ where: { language: l } }); } catch { return 0; } };
      return {
        configured: !!providerKeys.yiddishLabsApiKey,
        webhookConfigured: !!cfg.yiddishLabsWebhookSecret,
        counts: { yi: await byLang("yi"), en: await byLang("en"), "yi-en": await byLang("yi-en"), he: await byLang("he") },
      };
    });
    app.get("/agent/yiddishlabs/recent", async (req, reply) => {
      if (!corpusAuth(req)) return reply.code(403).send({ error: "forbidden" });
      try {
        const rows = await prisma.agentTranscript.findMany({ where: { model: "yiddishlabs" }, orderBy: { createdAt: "desc" }, take: 50, select: { recordingId: true, language: true, text: true, source: true, reviewStatus: true, createdAt: true } });
        return { transcripts: rows };
      } catch {
        return { transcripts: [] };
      }
    });

    // Everett (ivrit.ai on RunPod) admin — configuration + transcript counts.
    app.get("/agent/everett/status", async (req, reply) => {
      if (!corpusAuth(req)) return reply.code(403).send({ error: "forbidden" });
      let count = 0;
      try { count = await prisma.agentTranscript.count({ where: { model: "everett" } }); } catch { /* table may be empty */ }
      return {
        configured: !!providerKeys.everettApiKey && !!(providerKeys as any).everettEndpointId,
        endpointConfigured: !!(providerKeys as any).everettEndpointId,
        activeOverride: (process.env.AGENT_STT_PROVIDER ?? "").trim() || null,
        transcripts: count,
      };
    });

    // Owner console — provider self-test (owner JWT, no shared secret needed).
    // Pings the chosen provider so the Assistant page can prove Sonnet/Opus/GPT
    // actually respond. Blocked while the agent is disabled (kill switch).
    // With an explicit `model`, pings EXACTLY that provider+model (no routing,
    // no failover) — the model-picker's "Test" button depends on this honesty.
    app.post("/agent/admin/selftest", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      if (killSwitchEngaged()) return reply.code(423).send({ error: "kill_switch_engaged_or_agent_disabled" });
      const b = (req.body ?? {}) as any;
      if (typeof b.model === "string" && b.model.trim() && (b.provider === "openai" || b.provider === "anthropic")) {
        try {
          const r = await router.ping(b.provider, b.model);
          return { ok: true, provider: r.provider, model: r.model, text: r.text.trim(), failedOver: false };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }
      const provider = b?.provider === "anthropic" ? "diagnostics" : "support_chat";
      try {
        const r = await router.complete(provider as any, [
          { role: "system", content: "Reply with exactly: SELFTEST-OK" },
          { role: "user", content: "ping" },
        ], { maxTokens: PING_MAX_TOKENS });
        return { ok: true, provider: r.provider, model: r.model, text: r.text.trim(), failedOver: r.failedOver };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    // Owner console — model picker (Assistant page). Lists every chat-capable
    // model both provider keys can reach, plus which one is active right now.
    app.get("/agent/admin/models", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const providers = await router.listModels();
      return { active: router.activeChatModel(), providers };
    });

    // Owner console — consolidated capabilities view (certified/executable gate).
    app.get("/agent/admin/capabilities", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      return { capabilities: manifest.map((c) => ({ id: c.id, title: c.title, kind: c.kind, status: c.status, roles: c.roles, pbxWrite: (c as any).pbxWrite ?? false, liveEnabled: (c as any).liveEnabled ?? false })) };
    });

    // ── API-key settings (Assistant page). Write-only + encrypted at rest. ──
    app.get("/agent/admin/secrets/status", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      return { masterKey: secCrypto.hasMasterKey(), secrets: await secrets.status() };
    });
    app.post("/agent/admin/secrets", async (req, reply) => {
      const auth = req.headers.authorization;
      const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
      if (id?.role !== "owner") return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      const valid: SecretKey[] = ["anthropic_api_key", "openai_api_key", "yiddishlabs_api_key", "ivrit_api_key", "elevenlabs_api_key", "chat_model"];
      if (!valid.includes(b.key) || typeof b.value !== "string") return reply.code(400).send({ error: "bad_request" });
      const { parseChatModelPick } = await import("./llm/router");
      if (b.key === "chat_model" && b.value.trim() && !parseChatModelPick(b.value)) {
        return reply.code(400).send({ error: "bad_model_pick", hint: 'expected "openai:<model>" or "anthropic:<model>" (empty to reset)' });
      }
      try {
        await secrets.set(b.key, b.value, `owner:${id.clientUserId}`);
      } catch (err) {
        return reply.code(400).send({ error: String(err) });
      }
      // Hot-reload the affected client so it takes effect immediately.
      providerKeys.openaiApiKey = (await secrets.get("openai_api_key")) ?? cfg.openaiApiKey;
      providerKeys.yiddishLabsApiKey = (await secrets.get("yiddishlabs_api_key")) ?? cfg.yiddishLabsApiKey;
      providerKeys.everettApiKey = (await secrets.get("ivrit_api_key")) ?? cfg.everettApiKey;
      // ElevenLabs was missing from this list, so a just-saved key wasn't seen
      // until the next restart and the settings page kept judging the OLD key.
      providerKeys.elevenLabsApiKey = (await secrets.get("elevenlabs_api_key")) ?? cfg.elevenLabsApiKey;
      router.reload({ openaiApiKey: providerKeys.openaiApiKey, anthropicApiKey: (await secrets.get("anthropic_api_key")) ?? cfg.anthropicApiKey });
      // Apply the chat-model pick (or reset to defaults when cleared).
      router.setChatModel(parseChatModelPick(await secrets.get("chat_model")));
      return { ok: true, status: await secrets.status(), activeChatModel: router.activeChatModel() };
    });

    // ── Live mic transcription (Assistant page). Accepts a base64 audio clip,
    //    auto-detects Yiddish/English via Yiddish Labs, returns the text. ──
    app.post("/agent/transcribe/mic", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      if (typeof b.audioBase64 !== "string" || b.audioBase64.length < 32) return reply.code(400).send({ error: "no_audio" });
      let buf: Buffer;
      try { buf = Buffer.from(b.audioBase64.replace(/^data:[^,]+,/, ""), "base64"); } catch { return reply.code(400).send({ error: "bad_audio" }); }
      const filename = b.filename || "mic.webm";
      const engine = (typeof b.engine === "string" ? b.engine : "openai").toLowerCase();

      // ENGINE SELECTOR (owner can A/B from the Assistant page):
      //   ivrit.ai (Everett/RunPod) — Hebrew/Yiddish-tuned Whisper
      if (engine === "ivrit" || engine === "everett") {
        if (!providerKeys.everettApiKey || !providerKeys.everettEndpointId) return { ok: false, error: "ivrit_not_configured", engine: "ivrit.ai" };
        try {
          const { EverettClient } = await import("./transcription/everett");
          const cli = new EverettClient(providerKeys.everettApiKey, providerKeys.everettEndpointId);
          const t0 = Date.now();
          const r = await cli.transcribe({ file: buf, filename });
          if (r.status === "completed" && r.text) {
            const language = /[֐-׿]/.test(r.text) ? "yi" : "en";
            await audit.record({ actor: "owner", event: "mic.transcribed", payload: { engine: "ivrit.ai", ms: Date.now() - t0, chars: r.text.length, language } });
            return { ok: true, text: r.text, language, engine: "ivrit.ai", ms: Date.now() - t0 };
          }
          return { ok: false, error: "empty_transcript", engine: "ivrit.ai", ms: Date.now() - t0 };
        } catch (err) { return { ok: false, error: String(err), engine: "ivrit.ai" }; }
      }
      //   Yiddish Labs (explicitly requested)
      if (engine === "yiddishlabs" || engine === "yl") {
        const key0 = providerKeys.yiddishLabsApiKey;
        if (!key0) return { ok: false, error: "yiddishlabs_not_configured", engine: "yiddishlabs" };
        try {
          const cli = new YiddishLabsClient(key0);
          const ctx0 = await glossaryContext();
          const t0 = Date.now();
          const res0 = await cli.submitSync({ file: buf, filename, language: "auto", context: ctx0, rapid: true });
          if (res0.status === "completed" && res0.text) return { ok: true, text: res0.text, language: YiddishLabsClient.normalizeLanguage(res0), engine: "yiddishlabs", ms: Date.now() - t0 };
          return { ok: false, error: `pending:${res0.id}`, engine: "yiddishlabs" };
        } catch (err) { return { ok: false, error: String(err), engine: "yiddishlabs" }; }
      }

      // DEFAULT: OpenAI transcription (~2s) for live mic input capture. The text
      // is editable + still flows through the YL bridge on send, so answer
      // quality is unaffected. Falls back to Yiddish Labs if OpenAI isn't set.
      const oaKey = providerKeys.openaiApiKey;
      if (oaKey) {
        try {
          const { openaiTranscribe } = await import("./transcription/openaiStt");
          const t0 = Date.now();
          const r = await openaiTranscribe(oaKey, buf, filename);
          if (r.text) {
            const language = /[֐-׿]/.test(r.text) ? "yi" : "en";
            await audit.record({ actor: "owner", event: "mic.transcribed", payload: { engine: r.model, ms: Date.now() - t0, chars: r.text.length, language } });
            return { ok: true, text: r.text, language, engine: r.model, ms: Date.now() - t0 };
          }
        } catch (err) {
          await audit.record({ actor: "system", event: "mic.openai_failed", payload: { error: String(err) } });
          // fall through to Yiddish Labs
        }
      }

      // FALLBACK: Yiddish Labs (slower, but keeps the mic working without OpenAI).
      const key = providerKeys.yiddishLabsApiKey;
      if (!key) return { ok: false, error: "no_transcription_provider" };
      const client = new YiddishLabsClient(key);
      try {
        const ctx = await glossaryContext();
        const res = await client.submitSync({ file: buf, filename, language: "auto", context: ctx, rapid: true });
        if (res.status === "completed" && res.text) {
          return { ok: true, text: res.text, language: YiddishLabsClient.normalizeLanguage(res), summary: res.summary, engine: "yiddishlabs" };
        }
        return { ok: false, error: `pending:${res.id}` };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });
    // ── Voice input for the floating assistant widget. ANY authenticated portal
    //    user (not owner-only): records a short clip in the browser and gets it
    //    transcribed. Yiddish Labs first (king for American Yiddish; auto-detects
    //    English too), OpenAI as a fast fallback. Text lands in the chat box for
    //    the user to review before sending. ──
    app.post("/agent/chat/transcribe", async (req, reply) => {
      const auth = req.headers.authorization;
      const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
      if (!id) return reply.code(403).send({ ok: false, error: "forbidden" });
      const b = (req.body ?? {}) as any;
      if (typeof b.audioBase64 !== "string" || b.audioBase64.length < 32) return reply.code(400).send({ ok: false, error: "no_audio" });
      let buf: Buffer;
      try { buf = Buffer.from(b.audioBase64.replace(/^data:[^,]+,/, ""), "base64"); } catch { return reply.code(400).send({ ok: false, error: "bad_audio" }); }
      const filename = b.filename || "mic.webm";
      const clean = (s: string) => s.replace(/⟦[^⟧]*⟧/g, " ").replace(/[⟦⟧]/g, " ").replace(/[ \t]+/g, " ").trim();
      // Primary: Yiddish Labs (auto-detect yi/en, dialect glossary, rapid mode).
      if (providerKeys.yiddishLabsApiKey) {
        try {
          const cli = new YiddishLabsClient(providerKeys.yiddishLabsApiKey);
          const ctx = await glossaryContext();
          let r = await cli.submitSync({ file: buf, filename, language: "auto", context: ctx, rapid: true });
          // Short mic clips complete immediately; longer ones may still be
          // processing — poll briefly (~90s) before falling back.
          for (let i = 0; i < 45 && r.status !== "completed" && r.status !== "failed"; i++) {
            await new Promise((x) => setTimeout(x, 2000));
            r = await cli.get(r.id);
          }
          if (r.status === "completed" && r.text && r.text.trim()) {
            return { ok: true, text: clean(r.text), language: YiddishLabsClient.normalizeLanguage(r) };
          }
        } catch { /* fall through to OpenAI */ }
      }
      // Fallback: OpenAI (fast) so the mic still works if YL pends/fails.
      if (providerKeys.openaiApiKey) {
        try {
          const { openaiTranscribe } = await import("./transcription/openaiStt");
          const r = await openaiTranscribe(providerKeys.openaiApiKey, buf, filename);
          if (r.text && r.text.trim()) return { ok: true, text: r.text.trim(), language: /[֐-׿]/.test(r.text) ? "yi" : "en" };
        } catch { /* fall through */ }
      }
      return reply.code(502).send({ ok: false, error: "transcription_unavailable" });
    });

    // ── STT shoot-out: run Yiddish Labs AND Everett (ivrit.ai) on the SAME
    //    audio, side by side, so the owner can compare quality + speed. ──
    app.post("/agent/transcribe/compare", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      const b = (req.body ?? {}) as any;
      if (typeof b.audioBase64 !== "string" || b.audioBase64.length < 32) return reply.code(400).send({ error: "no_audio" });
      let buf: Buffer;
      try { buf = Buffer.from(b.audioBase64.replace(/^data:[^,]+,/, ""), "base64"); } catch { return reply.code(400).send({ error: "bad_audio" }); }
      const filename = b.filename || "compare.wav";
      const language = typeof b.language === "string" ? b.language : "auto";

      const runYl = async () => {
        if (!providerKeys.yiddishLabsApiKey) return { ok: false, error: "not_configured" };
        const t0 = Date.now();
        try {
          const ctx = await glossaryContext();
          const cli = new YiddishLabsClient(providerKeys.yiddishLabsApiKey);
          const r = await cli.submitSync({ file: buf, filename, language: language as any, context: ctx, rapid: true });
          if (r.status === "completed" && r.text) return { ok: true, text: r.text, language: YiddishLabsClient.normalizeLanguage(r), ms: Date.now() - t0 };
          return { ok: false, error: `pending:${r.id}`, ms: Date.now() - t0 };
        } catch (err) {
          return { ok: false, error: String(err), ms: Date.now() - t0 };
        }
      };
      const runEverett = async () => {
        if (!providerKeys.everettApiKey || !(providerKeys as any).everettEndpointId) return { ok: false, error: "not_configured" };
        const t0 = Date.now();
        try {
          const { EverettClient } = await import("./transcription/everett");
          const cli = new EverettClient(providerKeys.everettApiKey, (providerKeys as any).everettEndpointId);
          const r = await cli.transcribe({ file: buf, language: language === "auto" ? undefined : language });
          if (r.status === "completed" && r.text) return { ok: true, text: r.text, language: EverettClient.normalizeLanguage(r.text, language), ms: Date.now() - t0, workerMs: r.executionMs };
          return { ok: false, error: r.status === "completed" ? "empty_transcript" : "failed", ms: Date.now() - t0 };
        } catch (err) {
          return { ok: false, error: String(err), ms: Date.now() - t0 };
        }
      };

      const [yiddishlabs, everett] = await Promise.all([runYl(), runEverett()]);
      await audit.record({ actor: "owner", event: "stt.compare", payload: { filename, bytes: buf.length, yl: { ok: yiddishlabs.ok, ms: (yiddishlabs as any).ms }, everett: { ok: everett.ok, ms: (everett as any).ms } } });
      return { ok: true, yiddishlabs, everett };
    });

    // Voicemail auto-transcription: Yiddish → ivrit engine, English → GPT.
    // Polls for new voicemails every 90s. Enable with AGENT_VOICEMAIL_TRANSCRIBE=1
    // + VOICEMAIL_AUDIO_BASE_URL (PBX host serving pbxRecfile paths).
    if (process.env.AGENT_VOICEMAIL_TRANSCRIBE === "1") {
      const { VoicemailTranscriptionJob } = await import("./transcription/voicemailJob");
      const vmJob = new VoicemailTranscriptionJob({
        prisma,
        audit,
        openaiApiKey: () => providerKeys.openaiApiKey,
        // PRIMARY Yiddish engine: Yiddish Labs (king for American Yiddish).
        yiddishLabsApiKey: () => providerKeys.yiddishLabsApiKey,
        // ivrit.ai kept as an automatic fallback if Yiddish Labs is unavailable.
        ivritApiKey: () => providerKeys.everettApiKey,
        ivritEndpointId: () => providerKeys.everettEndpointId,
        ivritModel: process.env.EVERETT_MODEL || "ivrit-ai/yi-whisper-large-v3-turbo-ct2",
        // Fetch audio via the portal API's stream endpoint (handles recfile
        // refresh + spool fallback). Same docker network → service name "api".
        apiBaseUrl: () => process.env.AGENT_API_BASE_URL || "http://api:3001",
        jwtSecret: () => process.env.JWT_SECRET || null,
      });
      setInterval(() => { vmJob.runOnce().catch((err) => app.log.error({ err }, "voicemail transcription pass failed")); }, 90 * 1000).unref();
      await audit.record({ actor: "system", event: "voicemail.transcription_enabled", payload: { intervalSec: 90 } });

      // On-demand transcribe (portal Transcribe button). Any authenticated portal
      // user (they can already see the voicemail) may trigger it.
      app.post("/agent/voicemail/transcribe", async (req, reply) => {
        const auth = req.headers.authorization;
        const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
        if (!id) return reply.code(403).send({ error: "forbidden" });
        const vmId = (req.body as any)?.voicemailId;
        if (typeof vmId !== "string" || !vmId) return reply.code(400).send({ error: "bad_request" });
        const r = await vmJob.transcribeById(vmId);
        await audit.record({ actor: id.role === "owner" ? "owner" : "customer", event: "voicemail.transcribe_ondemand", payload: { voicemailId: vmId, ok: r.ok, language: r.language } });
        return r;
      });

      // On-demand translate (portal Translate button). Flips the transcript
      // between Yiddish and English via Yiddish Labs — Yiddish (incl. American
      // Yiddish, yi-en) → English, English → Yiddish. Goes through the same
      // persistent translation cache as the assistant bridge, so repeat presses
      // and common phrases are instant and free. Direction is auto from the
      // stored transcript language; an explicit `target` ("en"|"yi") can override.
      app.post("/agent/voicemail/translate", async (req, reply) => {
        const auth = req.headers.authorization;
        const id = auth?.startsWith("Bearer ") ? verifyPortalJwt(auth.slice(7)) : null;
        if (!id) return reply.code(403).send({ error: "forbidden" });
        const body = (req.body as any) ?? {};
        const vmId = body.voicemailId;
        if (typeof vmId !== "string" || !vmId) return reply.code(400).send({ error: "bad_request" });
        if (!providerKeys.yiddishLabsApiKey) return reply.code(503).send({ ok: false, error: "translation_unavailable" });
        const vm = await prisma.voicemail.findUnique({ where: { id: vmId }, select: { transcript: true, transcriptLanguage: true, deletedAt: true } });
        if (!vm || vm.deletedAt || !vm.transcript || !vm.transcript.trim()) return reply.code(404).send({ ok: false, error: "no_transcript" });
        // Direction: explicit target wins; else Yiddish/Hebrew-script → English, English → Yiddish.
        const lang = (vm.transcriptLanguage || "").toLowerCase();
        const isYiddish = lang.startsWith("yi") || /[֐-׿]/.test(vm.transcript);
        const explicit = body.target === "en" || body.target === "yi" ? body.target : null;
        const toEnglish = explicit ? explicit === "en" : isYiddish;
        const action = toEnglish ? "translate-english" : "translate-yiddish";
        try {
          const r = await translateCached(action, vm.transcript);
          await audit.record({ actor: id.role === "owner" ? "owner" : "customer", event: "voicemail.translate_ondemand", payload: { voicemailId: vmId, target: toEnglish ? "en" : "yi", cached: (r as any).cached === true } });
          return { ok: true, translated: r.text ?? "", target: toEnglish ? "en" : "yi" };
        } catch (err) {
          return reply.code(502).send({ ok: false, error: String(err).slice(0, 120) });
        }
      });
    }

    // Voicemail-to-email: emails each NEW voicemail (recording attached) to the
    // address on the mailbox extension, when that extension has the switch on.
    // Master switch: AGENT_VOICEMAIL_EMAIL=1. A hard fresh-window guard means the
    // ~19k historical voicemails can never be back-emailed. Polls every 60s.
    if (process.env.AGENT_VOICEMAIL_EMAIL === "1") {
      const { VoicemailEmailJob } = await import("./notify/voicemailEmailJob");
      const vmEmailJob = new VoicemailEmailJob({
        prisma,
        audit,
        notifier,
        apiBaseUrl: () => process.env.AGENT_API_BASE_URL || "http://api:3001",
        jwtSecret: () => process.env.JWT_SECRET || null,
        portalUrl: () => process.env.AGENT_PORTAL_URL || "https://app.connectcomunications.com",
        brandName: "Connect",
      });
      setInterval(() => {
        vmEmailJob.runOnce().catch((err) => app.log.error({ err }, "voicemail email pass failed"));
      }, 60 * 1000).unref();
      await audit.record({ actor: "system", event: "voicemail.email_enabled", payload: { intervalSec: 60 } });
    }

    // SMS-to-email: emails a copy of every INBOUND text to the users on that
    // conversation who have "SMS to Email" on, threaded one-per-number.
    // Master switch: AGENT_SMS_EMAIL=1. A hard fresh-window guard means the
    // existing inbound-SMS backlog can never be back-emailed. Polls every 30s.
    if (process.env.AGENT_SMS_EMAIL === "1") {
      const { SmsEmailForwardJob } = await import("./notify/smsEmailForwardJob");
      const smsEmailJob = new SmsEmailForwardJob({
        prisma,
        audit,
        notifier,
        messageIdDomain: () => process.env.AGENT_SMS_EMAIL_DOMAIN || "sms.connectcomunications.com",
        replyDomain: () => process.env.AGENT_SMS_EMAIL_REPLY_DOMAIN || null,
        replySecret: () => process.env.JWT_SECRET || null,
        brandName: "Connect",
      });
      setInterval(() => {
        smsEmailJob.runOnce().catch((err) => app.log.error({ err }, "sms email pass failed"));
      }, 30 * 1000).unref();
      await audit.record({ actor: "system", event: "sms.email_enabled", payload: { intervalSec: 30 } });
    }

    // 24/7 continuous drain — small batches every 2 min so it never floods the
    // box or the STT provider. No-op until AGENT_ARCHIVE_ROOT is set.
    setInterval(() => {
      const root = archiveRoot();
      if (root) archive.drain(root, 10).catch((err) => app.log.error({ err }, "archive drain failed"));
    }, 2 * 60 * 1000).unref();

    setInterval(() => {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      if (now.getHours() === 7 && day !== lastDigestDay) {
        lastDigestDay = day;
        digest.dailyDigest(now).catch((err) => app.log.error({ err }, "daily digest failed"));
      }
      const week = `${now.getUTCFullYear()}-W${Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 86400_000))}`;
      if (now.getDay() === 1 && now.getHours() === 8 && week !== lastReviewWeek) {
        lastReviewWeek = week;
        digest.weeklySelfReview(now).catch((err) => app.log.error({ err }, "weekly self-review failed"));
      }
    }, 15 * 60 * 1000).unref();
  }

  app.get("/health", async () => ({ ok: true, service: "@connect/agent", ts: new Date().toISOString() }));

  app.get("/agent/status", async () => ({
    enabled: cfg.enabled,
    killSwitchEngaged: killSwitchEngaged(),
    providersConfigured: router.available(),
    activeChatModel: router.activeChatModel(),
    smtpConfigured: notifier.configured,
    dbConnected: prisma !== null,
    chatEnabled: engine !== null,
    manifest: {
      total: manifest.length,
      executable: executableCapabilities(manifest).length,
      // The gap between total and executable is the certification gate working.
    },
  }));

  // Owner-only test endpoints (Phase 0 acceptance): prove audit, email, and both
  // LLM providers work. Guarded by a shared secret until portal auth is wired.
  app.post<{ Body: { secret?: string; provider?: "openai" | "anthropic" } }>("/agent/selftest", async (req, reply) => {
    const secret = process.env.AGENT_SELFTEST_SECRET;
    if (!secret || req.body?.secret !== secret) {
      return reply.code(403).send({ error: "forbidden" });
    }
    if (killSwitchEngaged()) {
      return reply.code(423).send({ error: "kill_switch_engaged_or_agent_disabled" });
    }
    const auditOk = await audit.record({ actor: "system", event: "selftest.run" });
    let llm: unknown = null;
    try {
      const task = req.body?.provider === "anthropic" ? "diagnostics" : "support_chat";
      const res = await router.complete(task, [
        { role: "system", content: "Reply with exactly: SELFTEST-OK" },
        { role: "user", content: "ping" },
      ], { maxTokens: PING_MAX_TOKENS });
      llm = { provider: res.provider, model: res.model, text: res.text.trim(), failedOver: res.failedOver };
    } catch (err) {
      llm = { error: String(err) };
    }
    const mail = await notifier.send({
      kind: "test",
      to: notifier.ownerRecipients(),
      subject: "[Connect Agent] Self-test",
      text: `Self-test at ${new Date().toISOString()}\naudit=${auditOk}\nllm=${JSON.stringify(llm)}`,
    });
    return { auditOk, llm, mail };
  });

  await app.listen({ port: cfg.port, host: cfg.host });
  await audit.record({ actor: "system", event: "agent.boot", payload: { enabled: cfg.enabled, killSwitch: cfg.killSwitch, providers: router.available() } });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("agent failed to start:", err);
  process.exit(1);
});
