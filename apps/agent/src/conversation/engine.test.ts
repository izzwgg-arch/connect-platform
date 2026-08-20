import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationEngine, detectLanguage, AUTO_CLOSE_HOURS } from "./engine";
import type { ConversationStore, ConversationRow, MessageRow } from "./store";
import { AuditLog, FileAuditSink } from "../audit/audit";

class FakeStore implements ConversationStore {
  convs: ConversationRow[] = [];
  msgs: MessageRow[] = [];
  policies = new Map<string, boolean>();
  private seq = 0;

  async findOpen(tenantId: string, clientUserId: string | null) {
    return this.convs.find((c) => c.tenantId === tenantId && c.clientUserId === clientUserId && c.status === "OPEN") ?? null;
  }
  async create(input: any) {
    const c: ConversationRow = {
      id: `c${++this.seq}`,
      tenantId: input.tenantId,
      clientUserId: input.clientUserId,
      role: input.role,
      channel: input.channel,
      language: input.language ?? null,
      status: "OPEN",
      startedAt: new Date(),
      closedAt: null,
    };
    this.convs.push(c);
    return c;
  }
  async close(id: string) {
    const c = this.convs.find((x) => x.id === id);
    if (c) {
      c.status = "CLOSED";
      c.closedAt = new Date();
    }
  }
  async closeStale(olderThan: Date) {
    let n = 0;
    for (const c of this.convs) {
      if (c.status !== "OPEN") continue;
      const last = this.msgs.filter((m) => m.conversationId === c.id).map((m) => m.createdAt).sort().pop() ?? c.startedAt;
      if (last < olderThan) {
        await this.close(c.id);
        n++;
      }
    }
    return n;
  }
  async addMessage(input: any) {
    const m: MessageRow = { id: `m${++this.seq}`, createdAt: new Date(), model: input.model ?? null, ...input };
    this.msgs.push(m);
    return m;
  }
  async listMessages(conversationId: string) {
    return this.msgs.filter((m) => m.conversationId === conversationId);
  }
  async listConversations(tenantId: string, clientUserId: string | null) {
    return this.convs.filter((c) => c.tenantId === tenantId && c.clientUserId === clientUserId);
  }
  async getConversation(id: string) {
    return this.convs.find((c) => c.id === id) ?? null;
  }
  async setLanguage(id: string, language: string) {
    const c = this.convs.find((x) => x.id === id);
    if (c) c.language = language;
  }
  async historyVisible(tenantId: string) {
    return this.policies.get(tenantId) ?? false;
  }
}

let store: FakeStore;
let engine: ConversationEngine;

beforeEach(async () => {
  store = new FakeStore();
  const dir = await mkdtemp(path.join(tmpdir(), "agent-conv-"));
  engine = new ConversationEngine(store, null, new AuditLog([new FileAuditSink(dir)]));
  delete process.env.AGENT_ENABLED; // kill switch engaged in tests unless set
});

test("language detection: Yiddish vs English", () => {
  assert.equal(detectLanguage("my phone is broken"), "en");
  assert.equal(detectLanguage("מײַן טעלעפון איז צעבראכן"), "yi");
});

test("language detection: code-switching — dominant language wins, one word doesn't flip it", () => {
  // Yiddish sentence with English loanwords mixed in → still Yiddish.
  assert.equal(detectLanguage("איך דארף set up מיין voicemail"), "yi");
  assert.equal(detectLanguage("קען איר helfen מיר מיטן account"), "yi");
  // A single Yiddish word dropped into an English sentence → still English.
  assert.equal(detectLanguage("can you please set up my voicemail נאך"), "en");
  // Empty / punctuation-only → default English, never throws.
  assert.equal(detectLanguage("   "), "en");
  assert.equal(detectLanguage("123 — !!"), "en");
});

test("kill switch: message stored, read-only reply, no LLM", async () => {
  const res = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "help!");
  assert.equal(res.degraded, true);
  assert.match(res.reply, /paused/);
  assert.equal(store.msgs.length, 2); // user + assistant
});

test("Yiddish message gets Yiddish reply and language recorded", async () => {
  const res = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "העלף מיר ביטע");
  assert.equal(res.language, "yi");
  assert.match(res.reply, /[֐-׿]/);
  assert.equal(store.convs[0].language, "yi");
});

test("same open conversation is reused; closed conversation is not", async () => {
  const a = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "one");
  const b = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "two");
  assert.equal(a.conversationId, b.conversationId);
  await engine.closeConversation({ tenantId: "t1", clientUserId: "u1", role: "customer" }, a.conversationId);
  const c = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "three");
  assert.notEqual(c.conversationId, a.conversationId); // new chat per issue
});

test("tenant isolation on close and read", async () => {
  const a = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "hi");
  const closed = await engine.closeConversation({ tenantId: "t2", clientUserId: "u1", role: "customer" }, a.conversationId);
  assert.equal(closed, false);
  const msgs = await engine.getMessages({ tenantId: "t2", clientUserId: "u1", role: "customer" }, a.conversationId);
  assert.equal(msgs, null);
});

test("history hidden until owner enables the tenant flag", async () => {
  await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "hi");
  let h = await engine.listHistory({ tenantId: "t1", clientUserId: "u1", role: "customer" });
  assert.deepEqual(h, { visible: false, conversations: [] });
  store.policies.set("t1", true);
  h = await engine.listHistory({ tenantId: "t1", clientUserId: "u1", role: "customer" });
  assert.equal(h.visible, true);
  assert.equal(h.conversations.length, 1);
});

test("auto-close stale conversations after idle window", async () => {
  const a = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "hi");
  const future = new Date(Date.now() + (AUTO_CLOSE_HOURS + 1) * 3600 * 1000);
  const n = await engine.autoCloseStale(future);
  assert.equal(n, 1);
  const conv = await store.getConversation(a.conversationId);
  assert.equal(conv?.status, "CLOSED");
});

// ── Support-desk take-over (2026-08-20) ──────────────────────────────────────

test("take-over: the engine is a mailbox — message stored, NO reply, no model, flag reported", async () => {
  const first = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "hello");
  const conv = await store.getConversation(first.conversationId);
  (conv as any).humanTakeoverAt = new Date();
  (conv as any).humanTakeoverBy = "staff-user";
  const before = store.msgs.length;
  const res = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "are you there?");
  assert.equal(res.humanTakeover, true);
  assert.equal(res.reply, "");
  assert.equal(res.model, "human");
  // Exactly ONE new message (the customer's) — no assistant turn was written.
  assert.equal(store.msgs.length, before + 1);
  assert.equal(store.msgs.at(-1)?.role, "user");
  assert.equal(store.msgs.at(-1)?.content, "are you there?");
});

test("take-over cleared: the assistant answers again", async () => {
  const first = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "hello");
  const conv = await store.getConversation(first.conversationId);
  (conv as any).humanTakeoverAt = new Date();
  const during = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "ping");
  assert.equal(during.humanTakeover, true);
  (conv as any).humanTakeoverAt = null;
  const after = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "ping again");
  assert.ok(!after.humanTakeover);
  assert.ok(after.reply.length > 0); // the kill-switch/degraded reply — a reply either way
});

test("getMessagesWithState reports the flag with the same gating as getMessages", async () => {
  const first = await engine.handleMessage({ tenantId: "t1", clientUserId: "u1", role: "customer" }, "hello");
  const conv = await store.getConversation(first.conversationId);
  (conv as any).humanTakeoverAt = new Date();
  const mine = await engine.getMessagesWithState({ tenantId: "t1", clientUserId: "u1", role: "customer" }, first.conversationId);
  assert.equal(mine?.humanTakeover, true);
  assert.ok((mine?.messages.length ?? 0) > 0);
  const foreign = await engine.getMessagesWithState({ tenantId: "t2", clientUserId: "u1", role: "customer" }, first.conversationId);
  assert.equal(foreign, null); // tenant isolation — absolute
});
