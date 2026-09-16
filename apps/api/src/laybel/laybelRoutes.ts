import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decryptJson, encryptJson, hasCredentialsMasterKey } from "@connect/security";

export const LAYBEL_CONFIG_KEY = "laybel_avatar_config";
const Config = z.object({
  apiKey: z.string().min(16).max(4096),
  avatarId: z.string().uuid(),
  voiceId: z.string().uuid(),
  enabled: z.boolean().default(false),
  maxSessionSeconds: z.number().int().min(60).max(600).default(300),
}).strict();
export type LaybelConfig = z.infer<typeof Config>;

// Never inherit a provider persona's model, prompt, tools or knowledge base.
// Loopcom supplies every reply. Verify account-level media retention before
// customer rollout; an ephemeral persona does not itself disable recording.
export function anamSessionRequest(config: LaybelConfig) {
  return {
    personaConfig: {
      name: "Laybel",
      avatarId: config.avatarId,
      avatarModel: "cara-4",
      voiceId: config.voiceId,
      llmId: "CUSTOMER_CLIENT_V1",
      systemPrompt: "",
      maxSessionLengthSeconds: config.maxSessionSeconds,
      skipGreeting: true,
    },
  };
}

type Deps = {
  db: any;
  requireOwner: (req: any, reply: any) => Promise<any>;
  fetch?: typeof fetch;
  loadConfig?: () => Promise<LaybelConfig | null>;
  saveConfig?: (config: LaybelConfig, actor: string) => Promise<void>;
};

export function registerLaybelRoutes(app: FastifyInstance, deps: Deps) {
  const request = deps.fetch ?? fetch;
  const loadConfig = deps.loadConfig ?? (async () => {
    if (!hasCredentialsMasterKey()) return null;
    const row = await deps.db.agentSecret.findUnique({ where: { key: LAYBEL_CONFIG_KEY } });
    if (!row) return null;
    const parsed = Config.safeParse(decryptJson(row.valueEnc));
    return parsed.success ? parsed.data : null;
  });
  const saveConfig = deps.saveConfig ?? (async (config, actor) => {
    if (!hasCredentialsMasterKey()) throw new Error("credentials_master_key_missing");
    const data = { valueEnc: encryptJson(config), updatedBy: actor };
    await deps.db.agentSecret.upsert({ where: { key: LAYBEL_CONFIG_KEY },
      create: { key: LAYBEL_CONFIG_KEY, ...data }, update: data });
  });
  const actor = (req: any) => req.user as { sub: string; tenantId: string; role: string } | undefined;
  const authenticated = (req: any, reply: any) => {
    const user = actor(req);
    if (!user?.sub || !user.tenantId) { reply.code(401).send({ message: "Please sign in to talk to Laybel." }); return null; }
    return user;
  };
  const safeStatus = (config: LaybelConfig | null, owner: boolean) => ({
    configured: Boolean(config), available: Boolean(config && (config.enabled || owner)),
    ...(owner ? { enabled: config?.enabled ?? false, avatarId: config?.avatarId ?? "",
      voiceId: config?.voiceId ?? "", maxSessionSeconds: config?.maxSessionSeconds ?? 300,
      apiKeySet: Boolean(config?.apiKey) } : {}),
  });

  app.get("/support/laybel/status", async (req, reply) => {
    const user = authenticated(req, reply); if (!user) return;
    reply.header("Cache-Control", "no-store");
    return safeStatus(await loadConfig(), user.role === "SUPER_ADMIN");
  });

  app.post("/support/laybel/settings", { bodyLimit: 8192 }, async (req, reply) => {
    const user = await deps.requireOwner(req, reply); if (!user) return;
    const patch = Config.partial().safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ message: "Enter a valid avatar ID, voice ID and API key." });
    const result = Config.safeParse({ ...await loadConfig(), ...patch.data });
    if (!result.success) return reply.code(400).send({ message: "The avatar ID, voice ID and API key are all required." });
    await saveConfig(result.data, user.sub);
    reply.header("Cache-Control", "no-store");
    return safeStatus(result.data, true);
  });

  app.post("/support/laybel/session", {
    bodyLimit: 1024,
    config: { rateLimit: { max: 3, timeWindow: "1 minute", keyGenerator: (req: any) => actor(req)?.sub ?? req.ip } },
  }, async (req, reply) => {
    const user = authenticated(req, reply); if (!user) return;
    reply.header("Cache-Control", "no-store");
    // No customer-controlled persona/tenant/model override can reach Anam.
    if (!z.object({}).strict().safeParse(req.body ?? {}).success) {
      return reply.code(400).send({ message: "This call does not accept configuration overrides." });
    }
    const config = await loadConfig();
    if (!config || (!config.enabled && user.role !== "SUPER_ADMIN")) {
      return reply.code(503).send({ error: "laybel_not_configured", message: "Laybel’s video connection has not been enabled yet. Your chat is still available." });
    }
    try {
      const res = await request("https://api.anam.ai/v1/auth/session-token", {
        method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(anamSessionRequest(config)), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        // Upstream bodies can contain credentials/configuration. Never forward them.
        return reply.code(res.status === 429 ? 429 : 502).send({ error: "laybel_provider_unavailable",
          message: res.status === 429 ? "Laybel is busy. Please try again shortly." : "Laybel’s video provider could not start the call. Please try again or continue in chat." });
      }
      const data = await res.json() as { sessionToken?: unknown };
      if (typeof data.sessionToken !== "string" || !data.sessionToken) throw new Error("missing_session_token");
      return { sessionToken: data.sessionToken, maxSessionSeconds: config.maxSessionSeconds };
    } catch {
      return reply.code(502).send({ error: "laybel_connection_failed", message: "Laybel’s video connection timed out. Please try again or continue in chat." });
    }
  });
}
