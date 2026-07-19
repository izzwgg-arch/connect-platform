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
  const engine = prisma ? new ConversationEngine(new PrismaConversationStore(prisma), router, audit) : null;

  const app = Fastify({ logger: true });

  if (engine) {
    registerChatRoutes(app, engine);
    // DB-backed scheduler tick: auto-close stale chats every 15 minutes.
    setInterval(() => {
      engine.autoCloseStale().catch((err) => app.log.error({ err }, "autoCloseStale failed"));
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
