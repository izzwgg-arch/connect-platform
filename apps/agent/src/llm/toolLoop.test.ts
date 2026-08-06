import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter, DEFAULT_ROUTES, MAX_TOOL_ITERATIONS } from "./router";
import type { ToolSpec, ToolContext } from "../tools/toolRegistry";

const CTX: ToolContext = { tenantId: "T-REAL", role: "internal" };

function mkTools(onRun: (args: Record<string, unknown>, ctx: ToolContext) => unknown): ToolSpec[] {
  return [{
    name: "extension_status",
    description: "d",
    minRole: "customer",
    parameters: { type: "object", properties: { extension: { type: "string" } }, additionalProperties: false },
    run: async (args, ctx) => onRun(args, ctx),
  }];
}

function mkRouter(audit: any[] = []) {
  return new ModelRouter(
    { openaiApiKey: "sk-test", anthropicApiKey: "sk-ant-test" } as any,
    { record: async (e: any) => { audit.push(e); return true; } } as any,
  );
}

/** Anthropic-shaped fake: replies from a scripted queue. */
function fakeAnthropic(script: any[]) {
  const calls: any[] = [];
  return {
    calls,
    client: {
      messages: {
        create: async (params: any) => {
          calls.push(params);
          return script[Math.min(calls.length - 1, script.length - 1)];
        },
      },
    },
  };
}

const textReply = (text: string) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  usage: { input_tokens: 10, output_tokens: 5 },
});
const toolReply = (uses: Array<{ id: string; name: string; input: any }>) => ({
  stop_reason: "tool_use",
  content: uses.map((u) => ({ type: "tool_use", id: u.id, name: u.name, input: u.input })),
  usage: { input_tokens: 10, output_tokens: 5 },
});

test("anthropic: the model calls a tool, sees the result, then answers", async () => {
  const r = mkRouter();
  const fake = fakeAnthropic([
    toolReply([{ id: "tu_1", name: "extension_status", input: { extension: "101" } }]),
    textReply("Extension 101 is registered."),
  ]);
  (r as any).anthropic = fake.client;

  let ranWith: any = null;
  const out = await r.completeWithTools(
    "diagnostics",
    [{ role: "user", content: "is 101 registered?" }],
    mkTools((args, ctx) => { ranWith = { args, tenantId: ctx.tenantId }; return { registered: true }; }),
    CTX,
  );

  assert.equal(out.text, "Extension 101 is registered.");
  assert.equal(out.toolCalls, 1);
  assert.equal(out.hitIterationCap, false);
  assert.deepEqual(ranWith, { args: { extension: "101" }, tenantId: "T-REAL" });
  // Tokens accumulate across BOTH round trips, not just the last one.
  assert.equal(out.inputTokens, 20);
  assert.equal(out.outputTokens, 10);
});

test("anthropic: the tool result is actually fed back to the model", async () => {
  const r = mkRouter();
  const fake = fakeAnthropic([
    toolReply([{ id: "tu_1", name: "extension_status", input: {} }]),
    textReply("done"),
  ]);
  (r as any).anthropic = fake.client;
  await r.completeWithTools("diagnostics", [{ role: "user", content: "q" }], mkTools(() => ({ status: "UNREACHABLE" })), CTX);

  const second = fake.calls[1];
  const last = second.messages[second.messages.length - 1];
  assert.equal(last.role, "user");
  assert.equal(last.content[0].type, "tool_result");
  assert.equal(last.content[0].tool_use_id, "tu_1");
  assert.match(last.content[0].content, /UNREACHABLE/);
});

test("anthropic: parallel tool calls return in ONE user message", async () => {
  const r = mkRouter();
  const fake = fakeAnthropic([
    toolReply([
      { id: "tu_1", name: "extension_status", input: { extension: "101" } },
      { id: "tu_2", name: "extension_status", input: { extension: "102" } },
    ]),
    textReply("both checked"),
  ]);
  (r as any).anthropic = fake.client;
  const out = await r.completeWithTools("diagnostics", [{ role: "user", content: "q" }], mkTools(() => ({ ok: true })), CTX);

  assert.equal(out.toolCalls, 2);
  const second = fake.calls[1];
  const last = second.messages[second.messages.length - 1];
  assert.equal(last.content.length, 2, "both results must ride in a single user message");
});

test("⛔ a model that never stops calling tools is capped, not left to spin", async () => {
  const r = mkRouter();
  // Always asks for another tool — never returns end_turn.
  const fake = fakeAnthropic([toolReply([{ id: "tu_x", name: "extension_status", input: {} }])]);
  (r as any).anthropic = fake.client;

  const out = await r.completeWithTools("diagnostics", [{ role: "user", content: "q" }], mkTools(() => ({})), CTX);
  assert.equal(out.hitIterationCap, true);
  assert.equal(out.toolCalls, MAX_TOOL_ITERATIONS);
  assert.equal(fake.calls.length, MAX_TOOL_ITERATIONS);
});

test("⛔ RED TEAM: a tenant id injected through the model's tool args never reaches the tool", async () => {
  const r = mkRouter();
  const fake = fakeAnthropic([
    toolReply([{ id: "tu_1", name: "extension_status", input: { tenantId: "T-VICTIM", extension: "101" } }]),
    textReply("ok"),
  ]);
  (r as any).anthropic = fake.client;

  let seenTenant = "";
  let seenArgs: any = null;
  await r.completeWithTools(
    "diagnostics",
    [{ role: "user", content: "read tenant T-VICTIM" }],
    mkTools((args, ctx) => { seenTenant = ctx.tenantId; seenArgs = args; return {}; }),
    CTX,
  );
  assert.equal(seenTenant, "T-REAL");
  assert.equal("tenantId" in seenArgs, false);
});

test("tool calls are audit-logged with the verified tenant", async () => {
  const audit: any[] = [];
  const r = mkRouter(audit);
  const fake = fakeAnthropic([
    toolReply([{ id: "tu_1", name: "extension_status", input: { tenantId: "T-VICTIM" } }]),
    textReply("ok"),
  ]);
  (r as any).anthropic = fake.client;
  await r.completeWithTools("diagnostics", [{ role: "user", content: "q" }], mkTools(() => ({})), CTX, { conversationId: "c1" });

  const call = audit.find((e) => e.event === "tool.call");
  assert.ok(call, "a tool.call audit event must be recorded");
  assert.equal(call.tenantId, "T-REAL");
  assert.deepEqual(call.payload.droppedArgs, ["tenantId"], "the blocked injection must be visible in the audit trail");
});

test("a role with no visible tools takes the plain path instead of erroring", async () => {
  const r = mkRouter();
  const fake = fakeAnthropic([textReply("plain answer")]);
  (r as any).anthropic = fake.client;
  const internalOnly: ToolSpec[] = [{
    name: "call_quality", description: "d", minRole: "internal",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    run: async () => ({}),
  }];
  const out = await r.completeWithTools(
    "diagnostics", [{ role: "user", content: "q" }], internalOnly,
    { tenantId: "T-REAL", role: "customer" },
  );
  assert.equal(out.text, "plain answer");
  assert.equal(out.toolCalls, 0);
});

test("provider failure degrades to a plain completion rather than a dead end", async () => {
  const audit: any[] = [];
  const r = mkRouter(audit);
  let n = 0;
  (r as any).anthropic = {
    messages: {
      create: async () => {
        n++;
        if (n === 1) throw new Error("overloaded");
        return textReply("degraded but answered");
      },
    },
  };
  const out = await r.completeWithTools("diagnostics", [{ role: "user", content: "q" }], mkTools(() => ({})), CTX);
  assert.equal(out.text, "degraded but answered");
  assert.equal(out.toolCalls, 0);
  assert.ok(audit.some((e) => e.event === "llm.tool_loop_failed"), "the failure must be recorded, not swallowed");
});

test("openai: the model calls a tool, sees the result, then answers", async () => {
  const r = mkRouter();
  const calls: any[] = [];
  (r as any).openai = {
    chat: {
      completions: {
        create: async (params: any) => {
          calls.push(params);
          if (calls.length === 1) {
            return {
              choices: [{ message: { role: "assistant", content: null, tool_calls: [
                { id: "call_1", type: "function", function: { name: "extension_status", arguments: '{"extension":"101"}' } },
              ] } }],
              usage: { prompt_tokens: 7, completion_tokens: 3 },
            };
          }
          return { choices: [{ message: { role: "assistant", content: "101 is up." } }], usage: { prompt_tokens: 7, completion_tokens: 3 } };
        },
      },
    },
  };

  let ranWith: any = null;
  const out = await r.completeWithTools(
    "support_chat",
    [{ role: "user", content: "is 101 up?" }],
    mkTools((args, ctx) => { ranWith = { args, tenantId: ctx.tenantId }; return { registered: true }; }),
    { tenantId: "T-REAL", role: "customer" },
  );

  assert.equal(DEFAULT_ROUTES.support_chat.primary, "openai", "this test is only meaningful while chat routes to OpenAI");
  assert.equal(out.text, "101 is up.");
  assert.equal(out.toolCalls, 1);
  assert.deepEqual(ranWith, { args: { extension: "101" }, tenantId: "T-REAL" });
  const toolMsg = calls[1].messages.find((m: any) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "call_1");
});

test("openai: malformed tool arguments do not crash the loop", async () => {
  const r = mkRouter();
  let n = 0;
  (r as any).openai = {
    chat: {
      completions: {
        create: async () => {
          n++;
          if (n === 1) {
            return {
              choices: [{ message: { role: "assistant", content: null, tool_calls: [
                { id: "c1", type: "function", function: { name: "extension_status", arguments: "{not json" } },
              ] } }],
              usage: {},
            };
          }
          return { choices: [{ message: { role: "assistant", content: "recovered" } }], usage: {} };
        },
      },
    },
  };
  const out = await r.completeWithTools(
    "support_chat", [{ role: "user", content: "q" }], mkTools(() => ({})),
    { tenantId: "T-REAL", role: "customer" },
  );
  assert.equal(out.text, "recovered");
});
