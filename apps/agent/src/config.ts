/**
 * Connect AI Agent — configuration & kill switch.
 *
 * OWNER GUARDRAILS (see docs/ai-support-agent/PLAN.md §3):
 *  - The agent boots DISABLED. AGENT_ENABLED=1 must be set explicitly.
 *  - AGENT_KILL_SWITCH=1 halts ALL tool/action execution instantly, even when enabled.
 *  - The agent must boot cleanly with NO API keys present (degraded, read-only chat off).
 *  - PBX_ALLOW_CONFIG_MUTATIONS is NEVER read, set, or forwarded by this service.
 */

export interface AgentConfig {
  enabled: boolean;
  killSwitch: boolean;
  port: number;
  host: string;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  smtp: {
    host: string | null;
    port: number;
    user: string | null;
    pass: string | null;
    from: string;
  };
  ownerEmail: string;
  teamEmails: string[];
  auditDir: string;
  /** Everett (ivrit.ai) — RunPod API key for our serverless STT endpoint. */
  everettApiKey: string | null;
  /** Everett (ivrit.ai) — RunPod serverless endpoint ID. */
  everettEndpointId: string | null;
  /** Yiddish Labs — advanced Yiddish↔English transcription + text processing. */
  yiddishLabsApiKey: string | null;
  /** Shared secret to verify inbound Yiddish Labs webhooks. */
  yiddishLabsWebhookSecret: string | null;
  /** ElevenLabs key for Voice Studio (Phase 5). */
  elevenLabsApiKey: string | null;
  /**
   * Yiddish translate-bridge: when true (default), Yiddish chats are translated
   * Yiddish↔English by Yiddish Labs on BOTH legs and the LLM works only in
   * English — the customer never sees model-generated Yiddish. Requires a YL
   * key; degrades gracefully if absent. Disable with AGENT_YIDDISH_BRIDGE=0.
   */
  yiddishBridge: boolean;
}

function envStr(name: string): string | null {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : null;
}

function envBool(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true";
}

export function loadConfig(): AgentConfig {
  return {
    enabled: envBool("AGENT_ENABLED"),
    killSwitch: envBool("AGENT_KILL_SWITCH"),
    port: Number(process.env.AGENT_PORT ?? 3920),
    host: process.env.AGENT_HOST ?? "0.0.0.0",
    openaiApiKey: envStr("OPENAI_API_KEY"),
    anthropicApiKey: envStr("ANTHROPIC_API_KEY"),
    smtp: {
      host: envStr("AGENT_SMTP_HOST"),
      port: Number(process.env.AGENT_SMTP_PORT ?? 587),
      user: envStr("AGENT_SMTP_USER"),
      pass: envStr("AGENT_SMTP_PASS"),
      from: process.env.AGENT_SMTP_FROM ?? "Connect Agent <agent@connectcomunications.com>",
    },
    ownerEmail: process.env.AGENT_OWNER_EMAIL ?? "izzywkg@gmail.com",
    teamEmails: (process.env.AGENT_TEAM_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    auditDir: process.env.AGENT_AUDIT_DIR ?? "/var/log/connect-agent",
    everettApiKey: envStr("EVERETT_API_KEY"),
    everettEndpointId: envStr("EVERETT_ENDPOINT_ID"),
    yiddishLabsApiKey: envStr("YIDDISHLABS_API_KEY"),
    yiddishLabsWebhookSecret: envStr("YIDDISHLABS_WEBHOOK_SECRET"),
    elevenLabsApiKey: envStr("ELEVENLABS_API_KEY"),
    yiddishBridge: process.env.AGENT_YIDDISH_BRIDGE !== "0", // default ON
  };
}

/**
 * Runtime kill-switch check. Re-reads env on every call so the flag can be
 * flipped (docker env + restart, or the DB flag once wired) without a deploy.
 * A DB-backed flag is OR'ed in by the tool layer when available.
 */
export function killSwitchEngaged(): boolean {
  return envBool("AGENT_KILL_SWITCH") || !envBool("AGENT_ENABLED");
}
