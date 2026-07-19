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
    engine = new ConversationEngine(new PrismaConversationStore(prisma), router, audit, triage);

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
