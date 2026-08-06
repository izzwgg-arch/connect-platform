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
import type { ToolSpec, ToolContext } from "../tools/toolRegistry";
import { toolsForRole, executeTool } from "../tools/toolRegistry";

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
export const ANTHROPIC_MODEL_HEAVY = process.env.ANTHROPIC_MODEL_HEAVY || "claude-opus-5"; // Opus 5 — heavy reasoning
export const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5";

/**
 * ⛔ THINKING IS ON BY DEFAULT on Opus 5 and Sonnet 5 — and thinking tokens come
 * out of the SAME max_tokens budget as the visible answer. That is why
 * DEFAULT_MAX_TOKENS below is large. Lowering it back toward the old 1024 does
 * not save money on a hard question; it truncates the answer mid-sentence after
 * the model has already paid to think. If cost needs cutting, change the MODEL
 * (or set output_config.effort once the SDK supports it) — never the ceiling.
 *
 * Installed @anthropic-ai/sdk is 0.60.0, which predates `output_config.effort`,
 * so effort stays at the API default (`high`). Upgrading the SDK is the
 * prerequisite for tuning it — see PLAN_SELF_IMPROVING_CONNECT_2026-08-06.md.
 */
export const DEFAULT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 16000);
/** Self-test ping: small, but must still clear an adaptive-thinking preamble. */
export const PING_MAX_TOKENS = 4000;
/**
 * Customer-facing chat ceiling. Was a bare `800` at the call site in
 * conversation/engine.ts — under 800 a thinking-by-default model (Sonnet 5, and
 * gpt-5, whose reasoning tokens also count against max_completion_tokens) can
 * spend the entire budget reasoning and return EMPTY text. The engine then
 * silently substitutes the "passed it to our team" canned line, so the failure
 * is invisible to us and reads as a dumb agent to the customer.
 */
export const CHAT_MAX_TOKENS = Number(process.env.AGENT_CHAT_MAX_TOKENS || 4000);
/**
 * How many look-then-think rounds one question gets. Each round is a model call
 * plus its tool results, so this bounds both cost and latency. Hitting the cap
 * is reported (`hitIterationCap`) rather than hidden — a question that keeps
 * hitting it is a missing tool, not a reason to raise the number.
 */
export const MAX_TOOL_ITERATIONS = Number(process.env.AGENT_MAX_TOOL_ITERATIONS || 8);

export const DEFAULT_ROUTES: RouteTable = {
  // Customer-facing conversation → OpenAI (Izzy's call, 2026-08-06). Anthropic
  // Sonnet 5 stays the failover so a provider outage never mutes the chat.
  support_chat: { primary: "openai", model: OPENAI_MODEL, fallbackModel: ANTHROPIC_MODEL },
  task_extraction: { primary: "openai", model: OPENAI_MODEL, fallbackModel: ANTHROPIC_MODEL },
  // Internal reasoning — diagnose and fix — → Opus 5, full smartness.
  diagnostics: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
  security_analysis: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
  report_writing: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
  policy_editing: { primary: "anthropic", model: ANTHROPIC_MODEL_HEAVY, fallbackModel: OPENAI_MODEL },
};

/**
 * Owner model-picker support (Assistant page, 2026-07-27): which provider
 * model IDs are offered as CHAT models. Both providers list far more than
 * chat completions (embeddings, TTS, whisper, image, realtime, moderation,
 * dated snapshots…) — this keeps the dropdown to models that actually work
 * with our chat call shape. Pure and unit-tested.
 */
export function filterChatModels(provider: ProviderName, ids: string[]): string[] {
  // gpt-5-chat-latest / gpt-5.1-chat-latest: still returned by OpenAI's models
  // API but 404 "deprecated" on real calls (proven live 2026-07-27) — a dropdown
  // entry that can't answer is worse than none.
  const deny = /(embed|whisper|tts|audio|realtime|image|dall-e|moderation|search|transcribe|instruct|davinci|babbage|computer-use|codex|-pro\b|deep-research|^gpt-5(\.1)?-chat-latest$)/i;
  const dated = /-\d{4}-\d{2}-\d{2}$|-\d{8}$|-\d{4}$/; // snapshots — bare aliases stay
  const allow = provider === "openai" ? /^(gpt-|o\d|chatgpt-)/i : /^claude-/i;
  return [...new Set(ids)]
    .filter((id) => allow.test(id) && !deny.test(id) && !dated.test(id))
    .sort();
}

/** Parse a stored "provider:modelId" pick; null when malformed. */
export function parseChatModelPick(v: string | null | undefined): { provider: ProviderName; model: string } | null {
  const m = String(v ?? "").trim().match(/^(openai|anthropic):(.+)$/);
  return m ? { provider: m[1] as ProviderName, model: m[2].trim() } : null;
}

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
   * Owner model-picker: point the CONVERSATION task classes (support_chat +
   * task_extraction) at an explicit provider/model. The other provider's
   * default stays as the failover; heavy-reasoning routes are untouched.
   * Passing null restores the code defaults. Takes effect immediately.
   */
  setChatModel(pick: { provider: ProviderName; model: string } | null): void {
    const next = pick
      ? { primary: pick.provider, model: pick.model, fallbackModel: pick.provider === "openai" ? ANTHROPIC_MODEL : OPENAI_MODEL }
      : { ...DEFAULT_ROUTES.support_chat };
    this.routes = { ...this.routes, support_chat: { ...next }, task_extraction: { ...next } };
  }

  /** The chat model currently in effect (for status/UI). */
  activeChatModel(): { provider: ProviderName; model: string } {
    const r = this.routes.support_chat;
    return { provider: r.primary, model: r.model };
  }

  /**
   * Live model catalogs from both providers (owner model-picker dropdown).
   * Filtered to chat-capable IDs; a provider without a key returns [].
   */
  async listModels(): Promise<Record<ProviderName, string[]>> {
    const out: Record<ProviderName, string[]> = { openai: [], anthropic: [] };
    if (this.openai) {
      try {
        const ids: string[] = [];
        for await (const m of this.openai.models.list()) ids.push(m.id);
        out.openai = filterChatModels("openai", ids);
      } catch { /* key invalid / network — dropdown just omits the provider */ }
    }
    if (this.anthropic) {
      try {
        const res = await this.anthropic.models.list({ limit: 100 });
        out.anthropic = filterChatModels("anthropic", res.data.map((m: any) => m.id));
      } catch { /* ditto */ }
    }
    return out;
  }

  /**
   * Directly ping ONE provider (no routing, no failover) — used by the owner
   * self-test so "Test OpenAI" actually calls OpenAI and "Test Claude" actually
   * calls Anthropic. Throws if that provider's key isn't configured or the call
   * fails, so the UI shows the real result instead of silently failing over.
   */
  async ping(provider: ProviderName, explicitModel?: string): Promise<{ provider: ProviderName; model: string; text: string }> {
    if (provider === "openai" && !this.openai) throw new Error("OpenAI key not configured");
    if (provider === "anthropic" && !this.anthropic) throw new Error("Anthropic key not configured");
    const model = explicitModel?.trim() || (provider === "openai" ? OPENAI_MODEL : ANTHROPIC_MODEL);
    // Larger max_tokens so reasoning-style models still emit visible output.
    // ⛔ Not 200: thinking-by-default models can spend the whole budget reasoning
    // and return an EMPTY text block, which reads as "provider down" in the UI.
    const res = await this.callProvider(
      provider,
      model,
      [
        { role: "system", content: "Reply with exactly: SELFTEST-OK" },
        { role: "user", content: "ping" },
      ],
      PING_MAX_TOKENS,
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
        const res = await this.callProvider(provider, model, messages, opts.maxTokens ?? DEFAULT_MAX_TOKENS);
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

  /**
   * Agentic completion — the model may CALL TOOLS and see the results, then
   * decide what to look at next, until it has an answer. This is the difference
   * between a model that writes and an agent that investigates.
   *
   * ⛔ Deliberately NO cross-provider failover mid-conversation. Anthropic and
   * OpenAI encode tool calls differently; replaying a half-finished tool
   * exchange onto the other provider is a correctness trap, not a safety net.
   * If the primary fails we degrade to a plain no-tools `complete()`, which
   * still answers (worse) rather than resuming a conversation it can't read.
   *
   * Every tool call is audit-logged with the SERVER-VERIFIED tenant, so a
   * cross-tenant attempt is visible after the fact as well as blocked before.
   */
  async completeWithTools(
    task: TaskClass,
    messages: ChatMessage[],
    tools: ToolSpec[],
    ctx: ToolContext,
    opts: { maxTokens?: number; conversationId?: string; maxIterations?: number } = {},
  ): Promise<CompletionResult & { toolCalls: number; hitIterationCap: boolean }> {
    const route = this.routes[task];
    if (!route) throw new Error(`No route for task class ${task}`);
    const visible = toolsForRole(tools, ctx.role);
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;

    // No tools visible to this role ⇒ nothing agentic to do; take the cheap path.
    if (visible.length === 0) {
      const res = await this.complete(task, messages, opts);
      return { ...res, toolCalls: 0, hitIterationCap: false };
    }

    const runTool = async (name: string, args: Record<string, unknown>) => {
      const r = await executeTool(tools, name, args, ctx);
      await this.audit.record({
        actor: "model",
        event: r.ok ? "tool.call" : "tool.refused",
        tenantId: ctx.tenantId,
        conversationId: opts.conversationId,
        payload: { tool: name, role: ctx.role, ok: r.ok, droppedArgs: r.droppedArgs },
      });
      return r;
    };

    try {
      const out =
        route.primary === "anthropic"
          ? await this.anthropicToolLoop(route.model, messages, visible, maxTokens, maxIterations, runTool)
          : await this.openaiToolLoop(route.model, messages, visible, maxTokens, maxIterations, runTool);
      await this.audit.record({
        actor: "model",
        event: "llm.completion",
        tenantId: ctx.tenantId,
        conversationId: opts.conversationId,
        payload: {
          task, provider: route.primary, model: route.model, agentic: true,
          toolCalls: out.toolCalls, hitIterationCap: out.hitIterationCap,
          inputTokens: out.inputTokens, outputTokens: out.outputTokens,
        },
      });
      return { ...out, provider: route.primary, model: route.model, failedOver: false };
    } catch (err) {
      await this.audit.record({
        actor: "model",
        event: "llm.tool_loop_failed",
        tenantId: ctx.tenantId,
        conversationId: opts.conversationId,
        payload: { task, provider: route.primary, model: route.model, error: String(err) },
      });
      // Degrade to a plain completion rather than resume across providers.
      const res = await this.complete(task, messages, opts);
      return { ...res, toolCalls: 0, hitIterationCap: false };
    }
  }

  private toolLoopResult(text: string, inputTokens: number, outputTokens: number, toolCalls: number, hitIterationCap: boolean) {
    return { text, inputTokens, outputTokens, toolCalls, hitIterationCap };
  }

  private async anthropicToolLoop(
    model: string,
    messages: ChatMessage[],
    tools: ToolSpec[],
    maxTokens: number,
    maxIterations: number,
    runTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; content: unknown }>,
  ) {
    if (!this.anthropic) throw new Error("Anthropic key not configured");
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    // Working conversation carries tool_use / tool_result blocks, so it is wider
    // than ChatMessage. Typed loosely on purpose — the SDK owns the real shape.
    const convo: any[] = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;

    for (let i = 0; i < maxIterations; i++) {
      const res: any = await this.anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system: system || undefined,
        messages: convo,
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as any })),
      } as any);
      inputTokens += res.usage?.input_tokens ?? 0;
      outputTokens += res.usage?.output_tokens ?? 0;

      const toolUses = (res.content ?? []).filter((b: any) => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = (res.content ?? [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("");
        return this.toolLoopResult(text, inputTokens, outputTokens, toolCalls, false);
      }

      convo.push({ role: "assistant", content: res.content });
      const results: any[] = [];
      for (const tu of toolUses) {
        toolCalls++;
        const r = await runTool(tu.name, (tu.input ?? {}) as Record<string, unknown>);
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(r.content ?? null),
          ...(r.ok ? {} : { is_error: true }),
        });
      }
      // All results for one assistant turn go back in ONE user message —
      // splitting them trains the model out of parallel tool calls.
      convo.push({ role: "user", content: results });
    }
    return this.toolLoopResult(
      "I gathered a lot of information but ran out of investigation steps before reaching a conclusion.",
      inputTokens, outputTokens, toolCalls, true,
    );
  }

  private async openaiToolLoop(
    model: string,
    messages: ChatMessage[],
    tools: ToolSpec[],
    maxTokens: number,
    maxIterations: number,
    runTool: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; content: unknown }>,
  ) {
    if (!this.openai) throw new Error("OpenAI key not configured");
    // ⛔ Tools go through /v1/responses, NOT /v1/chat/completions. Proven in
    // production 2026-08-06 on gpt-5.6-luna, which rejects the combination:
    //   "400 Function tools with reasoning_effort are not supported for
    //    gpt-5.6-luna in /v1/chat/completions. To use function tools, use
    //    /v1/responses or set reasoning_effort to 'none'."
    // Setting reasoning_effort:'none' would "fix" it by making the model stop
    // thinking — the opposite of the point. The plain (no-tools) path in
    // callProvider stays on chat.completions, which works fine there.
    //
    // Shape differences from chat.completions, all load-bearing:
    //   messages -> input, tools are FLAT ({type,name,description,parameters}),
    //   replies arrive as items in `output`, and a tool result goes back as a
    //   `function_call_output` item keyed by call_id.
    const input: any[] = messages.map((m) => ({ role: m.role, content: m.content }));
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;

    for (let i = 0; i < maxIterations; i++) {
      const res: any = await (this.openai as any).responses.create({
        model,
        max_output_tokens: maxTokens,
        input,
        tools: tools.map((t) => ({
          type: "function" as const,
          name: t.name,
          description: t.description,
          parameters: t.parameters as any,
        })),
      });
      inputTokens += res.usage?.input_tokens ?? 0;
      outputTokens += res.usage?.output_tokens ?? 0;

      const items: any[] = res.output ?? [];
      const calls = items.filter((o) => o.type === "function_call");
      if (calls.length === 0) {
        const text =
          res.output_text ??
          items
            .filter((o) => o.type === "message")
            .flatMap((o: any) => (o.content ?? []).filter((c: any) => c.type === "output_text").map((c: any) => c.text))
            .join("");
        return this.toolLoopResult(text ?? "", inputTokens, outputTokens, toolCalls, false);
      }

      // Echo the model's own output back before answering it, then append one
      // function_call_output per call — same "all results together" rule as
      // Anthropic, just a different envelope.
      input.push(...items);
      for (const call of calls) {
        toolCalls++;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch {
          // Malformed arguments are the model's error to recover from, not ours.
        }
        const r = await runTool(call.name ?? "", args);
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(r.content ?? null) });
      }
    }
    return this.toolLoopResult(
      "I gathered a lot of information but ran out of investigation steps before reaching a conclusion.",
      inputTokens, outputTokens, toolCalls, true,
    );
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
