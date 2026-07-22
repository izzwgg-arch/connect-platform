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
import { ModelRouter } from "./llm/router";
import { loadManifest, executableCapabilities } from "./manifest/manifest";
import { getPrisma } from "./db";
import { ConversationEngine } from "./conversation/engine";
import { PrismaConversationStore } from "./conversation/store";
import { registerChatRoutes } from "./conversation/routes";
import { ReadTools } from "./tools/readTools";
import { DiagnosticsEngine } from "./diag/engine";
import { registerDiagRoutes } from "./diag/routes";
import { ActionService } from "./actions/service";
import { registerActionRoutes } from "./actions/routes";
import { makePbxBackend } from "./actions/pbxBackend";
import { ScopedPbxExecutor } from "./pbx/executor";
import { makePbxClientFactory } from "./pbx/client";
import { TriageOrchestrator } from "./triage/orchestrator";
import { WatchmanRunner } from "./watchman/runner";
import { registerAdminRoutes } from "./actions/adminRoutes";
import { registerPolicyAdminRoutes } from "./policy/adminRoutes";
import { IdentityResolver } from "./channels/identity";
import { EmailChannel } from "./channels/email";
import { MessagingChannelHandler, NullMessagingTransport } from "./channels/messaging";
import { VoiceStudio } from "./voice/studio";
import { KnowledgeBase } from "./knowledge/kb";
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
    actionService = new ActionService(
      prisma,
      audit,
      notifier,
      { "pbx.": makePbxBackend(pbxExecutor), "action.": makePbxBackend(pbxExecutor) },
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
    const triage = new TriageOrchestrator(prisma, diagEngine, actionService, loadPolicy);
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
    };
    const anthropicResolved = (await secrets.get("anthropic_api_key")) ?? cfg.anthropicApiKey;
    router.reload({ openaiApiKey: providerKeys.openaiApiKey, anthropicApiKey: anthropicResolved });

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
    engine = new ConversationEngine(new PrismaConversationStore(prisma), router, audit, triage, rateLimiter, yiddishBridge, cfg.yiddishBridge);

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

    registerChatRoutes(app, engine);
    registerDiagRoutes(app, diagEngine);
    registerActionRoutes(app, actionService);
    registerAdminRoutes(app, prisma);
    registerPolicyAdminRoutes(app, prisma, audit);

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
    const voiceStudio = new VoiceStudio(prisma, { elevenLabsApiKey: cfg.elevenLabsApiKey, openaiApiKey: cfg.openaiApiKey }, audit);
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
    // auto-revert actions every 5 minutes.
    setInterval(() => {
      engine?.autoCloseStale().catch((err) => app.log.error({ err }, "autoCloseStale failed"));
      actionService?.tick().catch((err) => app.log.error({ err }, "action tick failed"));
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
    app.post("/agent/admin/selftest", async (req, reply) => {
      if (!requireOwner(req)) return reply.code(403).send({ error: "forbidden" });
      if (killSwitchEngaged()) return reply.code(423).send({ error: "kill_switch_engaged_or_agent_disabled" });
      const provider = (req.body as any)?.provider === "anthropic" ? "diagnostics" : "support_chat";
      try {
        const r = await router.complete(provider as any, [
          { role: "system", content: "Reply with exactly: SELFTEST-OK" },
          { role: "user", content: "ping" },
        ], { maxTokens: 16 });
        return { ok: true, provider: r.provider, model: r.model, text: r.text.trim(), failedOver: r.failedOver };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
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
      const valid: SecretKey[] = ["anthropic_api_key", "openai_api_key", "yiddishlabs_api_key", "ivrit_api_key"];
      if (!valid.includes(b.key) || typeof b.value !== "string") return reply.code(400).send({ error: "bad_request" });
      try {
        await secrets.set(b.key, b.value, `owner:${id.clientUserId}`);
      } catch (err) {
        return reply.code(400).send({ error: String(err) });
      }
      // Hot-reload the affected client so it takes effect immediately.
      providerKeys.openaiApiKey = (await secrets.get("openai_api_key")) ?? cfg.openaiApiKey;
      providerKeys.yiddishLabsApiKey = (await secrets.get("yiddishlabs_api_key")) ?? cfg.yiddishLabsApiKey;
      providerKeys.everettApiKey = (await secrets.get("ivrit_api_key")) ?? cfg.everettApiKey;
      router.reload({ openaiApiKey: providerKeys.openaiApiKey, anthropicApiKey: (await secrets.get("anthropic_api_key")) ?? cfg.anthropicApiKey });
      return { ok: true, status: await secrets.status() };
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
      ], { maxTokens: 16 });
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
