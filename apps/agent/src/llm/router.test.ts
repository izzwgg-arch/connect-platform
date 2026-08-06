import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterChatModels, parseChatModelPick, ModelRouter, DEFAULT_ROUTES,
  ANTHROPIC_MODEL, ANTHROPIC_MODEL_HEAVY, OPENAI_MODEL,
  DEFAULT_MAX_TOKENS, PING_MAX_TOKENS,
} from "./router";

test("filterChatModels: keeps chat-capable OpenAI models, drops non-chat + dated snapshots", () => {
  const ids = [
    "gpt-5", "gpt-5-mini", "gpt-4o", "gpt-4.1", "o3", "o4-mini", "chatgpt-4o-latest",
    "gpt-4o-2024-08-06", "gpt-4o-mini-tts", "gpt-4o-audio-preview", "whisper-1",
    "text-embedding-3-large", "dall-e-3", "gpt-image-1", "omni-moderation-latest",
    "gpt-4o-realtime-preview", "gpt-4o-search-preview", "gpt-4o-transcribe",
    "o1-pro", "o3-deep-research", "davinci-002", "babbage-002", "codex-mini-latest",
    "gpt-3.5-turbo-instruct", "tts-1-hd", "gpt-5", // dupe on purpose
    // listed by OpenAI's models API but 404 "deprecated" on real calls (live 2026-07-27)
    "gpt-5-chat-latest", "gpt-5.1-chat-latest",
    "gpt-5.2-chat-latest", // NOT deprecated — must stay
  ];
  assert.deepEqual(filterChatModels("openai", ids), ["chatgpt-4o-latest", "gpt-4.1", "gpt-4o", "gpt-5", "gpt-5-mini", "gpt-5.2-chat-latest", "o3", "o4-mini"]);
});

test("filterChatModels: keeps Claude aliases, drops dated snapshots + foreign ids", () => {
  const ids = ["claude-sonnet-5", "claude-opus-4-8", "claude-3-5-sonnet-20241022", "claude-3-haiku-20240307", "gpt-5"];
  assert.deepEqual(filterChatModels("anthropic", ids), ["claude-opus-4-8", "claude-sonnet-5"]);
});

test("parseChatModelPick: parses provider:model, rejects malformed", () => {
  assert.deepEqual(parseChatModelPick("openai:gpt-5"), { provider: "openai", model: "gpt-5" });
  assert.deepEqual(parseChatModelPick("anthropic:claude-opus-4-8"), { provider: "anthropic", model: "claude-opus-4-8" });
  assert.equal(parseChatModelPick(""), null);
  assert.equal(parseChatModelPick(null), null);
  assert.equal(parseChatModelPick("gpt-5"), null);
  assert.equal(parseChatModelPick("google:gemini"), null);
});

const mkRouter = () =>
  new ModelRouter(
    { openaiApiKey: "sk-test", anthropicApiKey: "sk-ant-test" } as any,
    { record: async () => true } as any,
  );

test("setChatModel repoints support_chat + task_extraction only; heavy routes untouched", () => {
  const r = mkRouter();
  r.setChatModel({ provider: "openai", model: "gpt-5-mini" });
  assert.deepEqual(r.activeChatModel(), { provider: "openai", model: "gpt-5-mini" });
  const routes = (r as any).routes;
  assert.deepEqual(routes.support_chat, { primary: "openai", model: "gpt-5-mini", fallbackModel: ANTHROPIC_MODEL });
  assert.deepEqual(routes.task_extraction, { primary: "openai", model: "gpt-5-mini", fallbackModel: ANTHROPIC_MODEL });
  assert.deepEqual(routes.diagnostics, DEFAULT_ROUTES.diagnostics);
});

test("anthropic pick keeps OpenAI as failover; null resets to code defaults", () => {
  const r = mkRouter();
  r.setChatModel({ provider: "anthropic", model: "claude-opus-4-8" });
  assert.deepEqual((r as any).routes.support_chat, { primary: "anthropic", model: "claude-opus-4-8", fallbackModel: OPENAI_MODEL });
  r.setChatModel(null);
  assert.deepEqual(r.activeChatModel(), { provider: DEFAULT_ROUTES.support_chat.primary, model: DEFAULT_ROUTES.support_chat.model });
});

test("customer chat defaults to OpenAI; internal reasoning stays on Opus", () => {
  // Izzy's split (2026-08-06): customer-facing = OpenAI, backend brain = Opus.
  assert.equal(DEFAULT_ROUTES.support_chat.primary, "openai");
  assert.equal(DEFAULT_ROUTES.support_chat.fallbackModel, ANTHROPIC_MODEL);
  for (const task of ["diagnostics", "security_analysis", "report_writing", "policy_editing"]) {
    assert.equal(DEFAULT_ROUTES[task].primary, "anthropic");
    assert.equal(DEFAULT_ROUTES[task].model, ANTHROPIC_MODEL_HEAVY);
  }
});

test("token ceilings leave room for thinking-by-default models", () => {
  // ⛔ Opus 5 / Sonnet 5 think by default and thinking shares the max_tokens
  // budget. A small ceiling truncates the answer AFTER paying to think.
  assert.ok(DEFAULT_MAX_TOKENS >= 8000, `DEFAULT_MAX_TOKENS too low: ${DEFAULT_MAX_TOKENS}`);
  assert.ok(PING_MAX_TOKENS >= 1000, `PING_MAX_TOKENS too low: ${PING_MAX_TOKENS}`);
});

test("setChatModel never mutates the shared DEFAULT_ROUTES object", () => {
  const before = JSON.stringify(DEFAULT_ROUTES);
  const r = mkRouter();
  r.setChatModel({ provider: "openai", model: "gpt-5" });
  assert.equal(JSON.stringify(DEFAULT_ROUTES), before);
});

test("reload (key save) does not clobber the model pick", () => {
  const r = mkRouter();
  r.setChatModel({ provider: "openai", model: "o3" });
  r.reload({ openaiApiKey: "sk-new", anthropicApiKey: "sk-ant-new" });
  assert.deepEqual(r.activeChatModel(), { provider: "openai", model: "o3" });
});
