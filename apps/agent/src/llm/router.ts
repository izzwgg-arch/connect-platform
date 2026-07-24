/**
 * Model Router — provider abstraction over OpenAI + Anthropic (PLAN.md §4).
 * Default routing: support conversation / task extraction → OpenAI;
 * diagnostics / security / reports → Anthropic. Config-swappable, automatic
 * failover, per-call token metering into the audit log.
 */
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { AgentConfig } from "../config";
import type { AuditLog } from "../audit/audit";

export type TaskClass = "support_chat" | "task_extraction" | "diagnostics" | "security_analysis" | "report_writing" | "policy_editing";
export type ProviderName = "openai" | "anthropic";

export interface RouteTable {
  [k: string]: { primary: ProviderName; model: string; fallbackModel: string };
}

/**
 * Centralized model IDs — change here (or via env) to swap models everywhere.
 * HYBRID by design (Izzy's choice): Sonnet 5 for high-volume conversation
 * (cheap + excellent), Opus for the few low-volume, heavy-reasoning jobs where
 * quality matters most. All overridable via env with zero code change.
 */
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5"; // Sonnet 5 — volume
export const ANTHROPIC_MODEL_HEAVY = process.env.ANTHROPIC_MODEL_HEAVY || "claude-opus-4-8"; // Opus — heavy reasoning
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";

export const DEFAULT_ROUTES: RouteTable = {
  // High volume → Sonnet 5 (as the Anthropic side / fallback). Cheap + strong.
  support_chat: { primary: "anthropic", model: ANTHROPIC_MODEL, fallbackModel: OPENAI_MODEL },
  task_extraction: { primary: "anthropic", model: ANTHROPIC_MODEL, fallbackModel: OPENAI_MODEL },
  // Low volume + hard reasoning → Opus.
  diagnostics: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
  security_analysis: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
  report_writing: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
  policy_editing: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
};

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  provider: ProviderName;
  model: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  failedOver: boolean;
}

export class ModelRouter {
  private openai: OpenAI | null;
  private anthropic: Anthropic | null;
  private routes: RouteTable;

  constructor(
    cfg: AgentConfig,
    private audit: AuditLog,
    routes: RouteTable = DEFAULT_ROUTES,
  ) {
    this.openai = cfg.openaiApiKey ? new OpenAI({ apiKey: cfg.openaiApiKey }) : null;
    this.anthropic = cfg.anthropicApiKey ? new Anthropic({ apiKey: cfg.anthropicApiKey }) : null;
    this.routes = routes;
  }

  /** Hot-reload provider clients when keys change (Assistant page save) —
   *  no process restart needed. Recreates only what's provided. */
  reload(keys: { openaiApiKey?: string | null; anthropicApiKey?: string | null }): void {
    this.openai = keys.openaiApiKey ? new OpenAI({ apiKey: keys.openaiApiKey }) : null;
    this.anthropic = keys.anthropicApiKey ? new Anthropic({ apiKey: keys.anthropicApiKey }) : null;
  }

  available(): ProviderName[] {
    const out: ProviderName[] = [];
    if (this.openai) out.push("openai");
    if (this.anthropic) out.push("anthropic");
    return out;
  }

  /**
   * Directly ping ONE provider (no routing, no failover) — used by the owner
   * self-test so "Test OpenAI" actually calls OpenAI and "Test Claude" actually
   * calls Anthropic. Throws if that provider's key isn't configured or the call
   * fails, so the UI shows the real result instead of silently failing over.
   */
  async ping(provider: ProviderName): Promise<{ provider: ProviderName; model: string; text: string }> {
    if (provider === "openai" && !this.openai) throw new Error("OpenAI key not configured");
    if (provider === "anthropic" && !this.anthropic) throw new Error("Anthropic key not configured");
    const model = provider === "openai" ? OPENAI_MODEL : ANTHROPIC_MODEL;
    // Larger max_tokens so reasoning-style models still emit visible output.
    const res = await this.callProvider(
      provider,
      model,
      [
        { role: "system", content: "Reply with exactly: SELFTEST-OK" },
        { role: "user", content: "ping" },
      ],
      200,
    );
    return { provider, model, text: res.text };
  }

  async complete(task: TaskClass, messages: ChatMessage[], opts: { maxTokens?: number; conversationId?: string } = {}): Promise<CompletionResult> {
    const route = this.routes[task];
    if (!route) throw new Error(`No route for task class ${task}`);
    const order: Array<{ provider: ProviderName; model: string }> = [
      { provider: route.primary, model: route.model },
      { provider: route.primary === "openai" ? "anthropic" : "openai", model: route.fallbackModel },
    ];
    let lastErr: unknown = new Error("no provider configured");
    for (let i = 0; i < order.length; i++) {
      const { provider, model } = order[i];
      try {
        const res = await this.callProvider(provider, model, messages, opts.maxTokens ?? 1024);
        const result: CompletionResult = { ...res, provider, model, failedOver: i > 0 };
        await this.audit.record({
          actor: "model",
          event: "llm.completion",
          conversationId: opts.conversationId,
          payload: { task, provider, model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, failedOver: i > 0 },
        });
        return result;
      } catch (err) {
        lastErr = err;
        await this.audit.record({ actor: "model", event: "llm.provider_error", payload: { task, provider, model, error: String(err) } });
      }
    }
    throw new Error(`All providers failed for ${task}: ${String(lastErr)}`);
  }

  private async callProvider(
    provider: ProviderName,
    model: string,
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    if (provider === "openai") {
      if (!this.openai) throw new Error("OpenAI key not configured");
      const res = await this.openai.chat.completions.create({
        model,
        max_completion_tokens: maxTokens,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      });
      return {
        text: res.choices[0]?.message?.content ?? "",
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      };
    }
    if (!this.anthropic) throw new Error("Anthropic key not configured");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const rest = messages.filter((m) => m.role !== "system");
    const res = await this.anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: system || undefined,
      messages: rest.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    });
    const text = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
}
