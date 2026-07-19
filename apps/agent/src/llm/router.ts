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

export const DEFAULT_ROUTES: RouteTable = {
  support_chat: { primary: "openai", model: "gpt-5", fallbackModel: "claude-sonnet-5" },
  task_extraction: { primary: "openai", model: "gpt-5", fallbackModel: "claude-sonnet-5" },
  diagnostics: { primary: "anthropic", model: "claude-sonnet-5", fallbackModel: "gpt-5" },
  security_analysis: { primary: "anthropic", model: "claude-sonnet-5", fallbackModel: "gpt-5" },
  report_writing: { primary: "anthropic", model: "claude-sonnet-5", fallbackModel: "gpt-5" },
  policy_editing: { primary: "anthropic", model: "claude-sonnet-5", fallbackModel: "gpt-5" },
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

  available(): ProviderName[] {
    const out: ProviderName[] = [];
    if (this.openai) out.push("openai");
    if (this.anthropic) out.push("anthropic");
    return out;
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
