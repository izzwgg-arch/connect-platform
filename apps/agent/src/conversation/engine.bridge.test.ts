/**
 * Yiddish translate-bridge tests.
 * Proves the core contract Izzy required: when a Yiddish chat comes in, Yiddish
 * Labs translates BOTH legs and Claude only ever works in English — the customer
 * never receives model-generated Yiddish.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationEngine } from "./engine";
import type { ConversationStore, ConversationRow, MessageRow } from "./store";
import type { TranslatorLike } from "./engine";
import { AuditLog, FileAuditSink } from "../audit/audit";

class FakeStore implements ConversationStore {
  convs: ConversationRow[] = [];
  msgs: MessageRow[] = [];
  private seq = 0;
  async findOpen(t: string, u: string | null) { return this.convs.find((c) => c.tenantId === t && c.clientUserId === u && c.status === "OPEN") ?? null; }
  async create(input: any) { const c: ConversationRow = { id: `c${++this.seq}`, tenantId: input.tenantId, clientUserId: input.clientUserId, role: input.role, channel: input.channel, language: input.language ?? null, status: "OPEN", startedAt: new Date(), closedAt: null }; this.convs.push(c); return c; }
  async close(id: string) { const c = this.convs.find((x) => x.id === id); if (c) { c.status = "CLOSED"; c.closedAt = new Date(); } }
  async closeStale() { return 0; }
  async addMessage(input: any) { const m: MessageRow = { id: `m${++this.seq}`, createdAt: new Date(), model: input.model ?? null, contentEn: input.contentEn ?? null, ...input }; this.msgs.push(m); return m; }
  async listMessages(conversationId: string) { return this.msgs.filter((m) => m.conversationId === conversationId); }
  async listConversations(t: string, u: string | null) { return this.convs.filter((c) => c.tenantId === t && c.clientUserId === u); }
  async getConversation(id: string) { return this.convs.find((c) => c.id === id) ?? null; }
  async setLanguage(id: string, language: string) { const c = this.convs.find((x) => x.id === id); if (c) c.language = language; }
  async historyVisible() { return false; }
}

/** Deterministic "English" output with NO Hebrew script (mirrors real YL). */
const enOf = (t: string) => "EN_" + t.replace(/[֐-׿]/g, "#");

/** Fake YL translator: records calls; deterministic transforms. */
class FakeTranslator implements TranslatorLike {
  configured = true;
  toEnglishCalls: string[] = [];
  toYiddishCalls: string[] = [];
  failYiddish = false;
  async toEnglish(text: string) { this.toEnglishCalls.push(text); return { text: enOf(text), creditsConsumed: 10 }; }
  async toYiddish(text: string) { this.toYiddishCalls.push(text); if (this.failYiddish) throw new Error("yl_down"); return { text: `ייִדיש{${text}}`, creditsConsumed: 12 }; }
}

/** Fake LLM router that records the messages it received and returns fixed English. */
class FakeRouter {
  lastMessages: any[] = [];
  reply = "Please tell me your extension number.";
  available() { return ["anthropic"]; }
  async complete(_task: string, messages: any[]) {
    this.lastMessages = messages;
    return { provider: "anthropic", model: "claude-sonnet-5", text: this.reply, inputTokens: 5, outputTokens: 7, failedOver: false };
  }
}

let store: FakeStore;
let translator: FakeTranslator;
let router: FakeRouter;

async function makeEngine(bridgeEnabled: boolean) {
  const dir = await mkdtemp(path.join(tmpdir(), "agent-bridge-"));
  return new ConversationEngine(store, router as any, new AuditLog([new FileAuditSink(dir)]), null, null, translator, bridgeEnabled);
}

beforeEach(() => {
  store = new FakeStore();
  translator = new FakeTranslator();
  router = new FakeRouter();
  process.env.AGENT_ENABLED = "1"; // disengage kill switch
  delete process.env.AGENT_KILL_SWITCH;
});
afterEach(() => { delete process.env.AGENT_ENABLED; });

test("Yiddish in → YL translates both legs; customer gets YL Yiddish, never the model's", async () => {
  const engine = await makeEngine(true);
  const yiddish = "גוט מארגן, מיין עקסטענשן ארבעט נישט";
  const res = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, yiddish);

  // Input leg: YL translated the Yiddish to English.
  assert.deepEqual(translator.toEnglishCalls, [yiddish]);
  // Output leg: YL translated the LLM's ENGLISH reply (not the Yiddish) to Yiddish.
  assert.deepEqual(translator.toYiddishCalls, [router.reply]);

  // Customer sees YL's Yiddish wrapper, NOT the raw model English.
  assert.equal(res.language, "yi");
  assert.equal(res.reply, `ייִדיש{${router.reply}}`);
  assert.notEqual(res.reply, router.reply);
});

test("the LLM only ever sees English + the bridge system prompt", async () => {
  const engine = await makeEngine(true);
  await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "מיין טעלעפאן איז צעבראכן");

  const system = router.lastMessages.find((m) => m.role === "system");
  assert.match(system.content, /TRANSLATION BRIDGE ACTIVE/);
  // The user turn handed to the model is the English translation — no Hebrew script.
  const lastUser = [...router.lastMessages].reverse().find((m) => m.role === "user");
  assert.match(lastUser.content, /^EN_/);
  assert.doesNotMatch(lastUser.content, /[֐-׿]/);
});

test("bilingual transcript persisted: Yiddish content + English mirror", async () => {
  const engine = await makeEngine(true);
  const yiddish = "וויפיל קאסט עס";
  await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, yiddish);

  const user = store.msgs.find((m) => m.role === "user")!;
  const assistant = store.msgs.find((m) => m.role === "assistant")!;
  assert.equal(user.content, yiddish);              // original Yiddish preserved
  assert.equal(user.contentEn, enOf(yiddish));       // English mirror for LLM + corpus
  assert.equal(assistant.content, `ייִדיש{${router.reply}}`); // customer-facing YL Yiddish
  assert.equal(assistant.contentEn, router.reply);   // English original mirrored
});

test("English chat bypasses the bridge entirely (no YL calls)", async () => {
  const engine = await makeEngine(true);
  const res = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "my extension is down");
  assert.equal(res.language, "en");
  assert.equal(res.reply, router.reply);        // model text used directly
  assert.equal(translator.toEnglishCalls.length, 0);
  assert.equal(translator.toYiddishCalls.length, 0);
});

test("YL output failure → canned Yiddish fallback, degraded, never English leak", async () => {
  translator.failYiddish = true;
  const engine = await makeEngine(true);
  const res = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "העלף מיר");
  assert.equal(res.degraded, true);
  assert.match(res.reply, /[֐-׿]/);             // still Yiddish (canned)
  assert.notEqual(res.reply, router.reply);      // never the English
});

test("bridge disabled → Yiddish path unchanged (no YL, model text used)", async () => {
  const engine = await makeEngine(false);
  const res = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "שלום עליכם");
  assert.equal(translator.toEnglishCalls.length, 0);
  assert.equal(res.reply, router.reply);
});
