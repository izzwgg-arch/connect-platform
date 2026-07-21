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

  const app = Fastify({ logger: true });

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
    engine = new ConversationEngine(new PrismaConversationStore(prisma), router, audit, triage, rateLimiter);

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
      await corpus.approve(b.recordingId);
      return { ok: true };
    });
    app.get("/agent/corpus/stats", async (req, reply) => (corpusAuth(req) ? corpus.stats() : reply.code(403).send({ error: "forbidden" })));
    app.get("/agent/corpus/review-queue", async (req, reply) => (requireOwner(req) ? { queue: await corpus.reviewQueue() } : reply.code(403).send({ error: "forbidden" })));

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
    const transcriber = new Transcriber(
      prisma,
      { openaiApiKey: cfg.openaiApiKey, everettApiKey: cfg.everettApiKey, yiddishLabsApiKey: cfg.yiddishLabsApiKey },
      audit,
      glossaryContext,
    ) as any;
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
        configured: !!cfg.yiddishLabsApiKey,
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
