/**
 * The Coworker WORKSPACE through the REAL engine and the REAL router tool loop, with
 * only the provider client faked — the same approach as engineTools.test.ts, because
 * a stubbed router would prove nothing about the hooks, the stop, or which tools the
 * model is actually offered.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConversationEngine, PHONE_TOOL_NAMES } from "./engine";
import type { ConversationStore, ConversationRow, MessageRow } from "./store";
import { AuditLog, FileAuditSink } from "../audit/audit";
import { ModelRouter, STOPPED_REPLY } from "../llm/router";
import { buildTools } from "../tools/toolRegistry";
import { ActivityHub, type ActivityEvent } from "../coworker/activity";
import { DEFAULT_PREFS } from "../coworker/prefs";

class FakeStore implements ConversationStore {
  convs: ConversationRow[] = [];
  msgs: MessageRow[] = [];
  reopened: string[] = [];
  private seq = 0;
  async findOpen(tenantId: string, clientUserId: string | null) {
    return [...this.convs].reverse().find((c) => c.tenantId === tenantId && c.clientUserId === clientUserId && c.status === "OPEN") ?? null;
  }
  async create(input: any) {
    const c: ConversationRow = { id: `c${++this.seq}`, tenantId: input.tenantId, clientUserId: input.clientUserId, role: input.role, channel: input.channel, language: null, status: "OPEN", startedAt: new Date(), closedAt: null };
    this.convs.push(c);
    return c;
  }
  async close(id: string) { const c = this.convs.find((x) => x.id === id); if (c) { c.status = "CLOSED"; c.closedAt = new Date(); } }
  async reopen(id: string) { const c = this.convs.find((x) => x.id === id); if (c) { c.status = "OPEN"; c.closedAt = null; } this.reopened.push(id); }
  async closeStale() { return 0; }
  async addMessage(input: any) { const m: MessageRow = { id: `m${++this.seq}`, createdAt: new Date(), model: input.model ?? null, ...input }; this.msgs.push(m); return m; }
  async listMessages(conversationId: string) { return this.msgs.filter((m) => m.conversationId === conversationId); }
  async listConversations() { return this.convs; }
  async getConversation(id: string) { return this.convs.find((c) => c.id === id) ?? null; }
  async setLanguage(id: string, language: string) { const c = this.convs.find((x) => x.id === id); if (c) c.language = language; }
  async historyVisible() { return true; }
}

/** A scripted OpenAI Responses client: each create() plays the next scripted step. */
function scripted(steps: Array<(req: any) => any | Promise<any>>) {
  const requests: any[] = [];
  let i = 0;
  return {
    requests,
    client: {
      responses: {
        create: async (req: any) => {
          requests.push(req);
          const step = steps[Math.min(i++, steps.length - 1)];
          return step(req);
        },
      },
    },
  };
}
const call = (name: string, args: Record<string, unknown>, id = name) => () => ({ output: [{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }], usage: {} });
const answer = (text: string) => () => ({ output_text: text, output: [], usage: {} });

const A = { tenantId: "t1", clientUserId: "u1" };
let store: FakeStore;
let audit: AuditLog;
let hub: ActivityHub;
const readTools = { extensionStatus: async () => [{ extension: "101", registered: true }], cdrHistory: async () => ({ calls: [] }) } as any;

beforeEach(async () => {
  store = new FakeStore();
  audit = new AuditLog([new FileAuditSink(await mkdtemp(path.join(tmpdir(), "cw-ws-")))]);
  hub = new ActivityHub();
  process.env.AGENT_ENABLED = "1";
  delete process.env.AGENT_KILL_SWITCH;
});

function mkEngine(client: any, opts: { phone?: boolean; triage?: any; transcribe?: (b: Buffer, f: string) => Promise<string | null>; extraTools?: any[] } = {}) {
  const router = new ModelRouter({ openaiApiKey: "sk-test" } as any, audit);
  (router as any).openai = client;
  const engine = new ConversationEngine(store, router, audit, opts.triage ?? null, null, null, false, null, null, [
    ...buildTools({ readTools, prisma: {} as any }),
    ...(opts.extraTools ?? []),
  ]);
  const recorded: any[] = [];
  engine.attachCoworkerWorkspace({
    hub,
    loadPrefs: async () => ({ ...DEFAULT_PREFS, phone: opts.phone ?? true, memory: "We close on Fridays at 2." }),
    transcribeAudio: opts.transcribe,
    recordStep: (row) => recorded.push(row),
  });
  return { engine, recorded };
}

const events = (turnId: string): ActivityEvent[] => { const r = hub.read(turnId, A, 0); return r.ok ? r.events : []; };
const toolNames = (req: any): string[] => (req.tools ?? []).map((t: any) => t.name);

test("a workspace turn streams the plan, a plain-English step per tool and the thinking between them", async () => {
  const s = scripted([
    call("show_plan", { steps: ["Check your extension", "Tell you what I found"], current: 0 }),
    call("extension_status", { extension: "101" }),
    answer("Extension 101 is registered."),
  ]);
  const { engine, recorded } = mkEngine(s.client);
  hub.open("turn-ws-00001", A);
  const res = await engine.handleMessage({ ...A, role: "customer", turnId: "turn-ws-00001", viewingPath: "/desktop/coworker" }, "is my phone registered?");
  hub.finish("turn-ws-00001", true);
  assert.equal(res.reply, "Extension 101 is registered.");
  const ev = events("turn-ws-00001");
  assert.ok(ev.some((e) => e.type === "plan" && e.steps.length === 2), "plan shown");
  const steps = ev.filter((e): e is Extract<ActivityEvent, { type: "step" }> => e.type === "step");
  assert.deepEqual(steps.map((e) => `${e.state}:${e.label}`), ["running:Checking extension 101", "done:Checking extension 101"]);
  assert.ok(ev.some((e) => e.type === "thinking"));
  assert.ok(ev.some((e) => e.type === "conversation"));
  assert.equal(recorded.length, 1, "the finished step is recorded for 'Everything it did'");
  assert.equal(recorded[0].label, "Checking extension 101");
  assert.ok(!ev.some((e) => e.type === "step" && /show_plan|extension_status/.test(e.label)), "no tool names on screen");
  // The workspace instructions and the person's notes reached the model.
  const system = s.requests[0].input.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
  assert.match(system, /THE COWORKER WORKSPACE/);
  assert.match(system, /We close on Fridays at 2\./);
});

test("ask_person waits for the answer from the page and the model receives it", async () => {
  const s = scripted([
    call("ask_person", { question: "Documents or Desktop?", options: ["Documents", "Desktop"] }),
    (req) => {
      const out = req.input.find((m: any) => m.type === "function_call_output");
      return { output_text: `You picked ${JSON.parse(out.output).answer}.`, output: [], usage: {} };
    },
  ]);
  const { engine } = mkEngine(s.client);
  hub.open("turn-ws-00002", A);
  const running = engine.handleMessage({ ...A, role: "customer", turnId: "turn-ws-00002" }, "save the list");
  let q: any;
  for (let i = 0; i < 100 && !q; i++) { await new Promise((r) => setTimeout(r, 5)); q = events("turn-ws-00002").find((e) => e.type === "question"); }
  assert.ok(q, "the question reached the feed");
  assert.deepEqual(hub.answer("turn-ws-00002", A, q.questionId, "Desktop"), { ok: true });
  const res = await running;
  assert.equal(res.reply, "You picked Desktop.");
  const askStep = events("turn-ws-00002").filter((e) => e.type === "step" && e.state === "done").pop() as any;
  assert.match(askStep.detail[0], /You answered: Desktop/);
});

test("Stop while the model waits on a question ends the turn with the stopped reply and no further calls", async () => {
  const s = scripted([
    call("ask_person", { question: "Which one?" }),
    call("extension_status", {}),
    answer("should never be reached"),
  ]);
  const { engine } = mkEngine(s.client);
  hub.open("turn-ws-00003", A);
  const running = engine.handleMessage({ ...A, role: "customer", turnId: "turn-ws-00003" }, "do the thing");
  for (let i = 0; i < 100 && !events("turn-ws-00003").some((e) => e.type === "question"); i++) await new Promise((r) => setTimeout(r, 5));
  hub.stop("turn-ws-00003", A);
  const res = await running;
  assert.equal(res.reply, STOPPED_REPLY);
  assert.equal(s.requests.length, 1, "no model call after Stop");
});

test("the phone system switched off in Coworker settings is not offered to the model at all", async () => {
  const s = scripted([answer("ok")]);
  const { engine } = mkEngine(s.client, { phone: false });
  hub.open("turn-ws-00004", A);
  await engine.handleMessage({ ...A, role: "customer", turnId: "turn-ws-00004" }, "hi");
  const offered = toolNames(s.requests[0]);
  for (const n of PHONE_TOOL_NAMES) assert.ok(!offered.includes(n), `${n} must not be offered`);
  assert.ok(offered.includes("ask_person") && offered.includes("show_plan"));
});

test("without a turnId nothing changes: no workspace tools, no workspace prompt, no events", async () => {
  const s = scripted([answer("plain")]);
  const { engine } = mkEngine(s.client);
  const res = await engine.handleMessage({ ...A, role: "customer" }, "hello");
  assert.equal(res.reply, "plain");
  const offered = toolNames(s.requests[0]);
  assert.ok(!offered.includes("ask_person") && !offered.includes("show_plan"));
  assert.ok(offered.includes("extension_status"), "phone tools stay as they always were");
  const system = s.requests[0].input.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
  assert.doesNotMatch(system, /THE COWORKER WORKSPACE/);
  assert.equal(hub.size(), 0);
});

/**
 * ⛔ The one a knowledge fix could not reach. On 2026-09-15 the workspace was asked
 * "what can you help me with on this computer?" while the desktop app was
 * reconnecting, and it answered with the 2026-09-02 CARD world — three tasks, three
 * folders, "only runs after you press the button" — six days after the hands
 * shipped. The prompts were current and the published knowledge document was
 * current. The stale sentences were the DESCRIPTIONS of coworker_task /
 * my_computer_tasks, which a model reads whether or not it ever calls them, and
 * which only stepped aside when the hands happened to be connected.
 */
test("the card-era proposal tools are never offered on a workspace turn — hands connected or not", async () => {
  const proposalEra = [
    { name: "coworker_task", description: "Nothing runs until they press the button on the card.", minRole: "customer", parameters: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ ok: true }) },
    { name: "my_computer_tasks", description: "What the Coworker has been asked to do recently.", minRole: "customer", parameters: { type: "object", properties: {}, additionalProperties: false }, run: async () => ({ ok: true }) },
  ];
  const s = scripted([answer("ok")]);
  const { engine } = mkEngine(s.client, { extraTools: proposalEra });
  hub.open("turn-ws-00009", A);
  await engine.handleMessage({ ...A, role: "customer", turnId: "turn-ws-00009" }, "what can you do on this computer?");
  const offered = toolNames(s.requests[0]);
  assert.ok(!offered.includes("coworker_task"), "the card tool must not be offered in the workspace");
  assert.ok(!offered.includes("my_computer_tasks"), "the card status tool must not be offered in the workspace");
  assert.ok(offered.includes("ask_person") && offered.includes("show_plan"), "the workspace's own tools are still there");

  // ⛔ And the dock is untouched: no turnId means the proposal tools stay exactly
  // as they were, so FloatingAssistant's card feature is not changed by this.
  const s2 = scripted([answer("ok")]);
  const { engine: e2 } = mkEngine(s2.client, { extraTools: proposalEra });
  await e2.handleMessage({ ...A, role: "customer" }, "what can you do on this computer?");
  const dock = toolNames(s2.requests[0]);
  assert.ok(dock.includes("coworker_task") && dock.includes("my_computer_tasks"), "outside the workspace nothing changes");
});

test("a turnId the route never opened is ignored — the hub decides, not the body", async () => {
  const s = scripted([answer("plain")]);
  const { engine } = mkEngine(s.client);
  await engine.handleMessage({ ...A, role: "customer", turnId: "turn-never-opened" }, "hello");
  assert.ok(!toolNames(s.requests[0]).includes("ask_person"));
});

test("continuing a task: own closed conversation is reopened; someone else's id is ignored; New task opens a fresh one", async () => {
  const s = scripted([answer("a")]);
  const { engine } = mkEngine(s.client);
  const mine = await store.create({ tenantId: "t1", clientUserId: "u1", role: "customer", channel: "chat" });
  await store.close(mine.id);
  const theirs = await store.create({ tenantId: "t1", clientUserId: "u2", role: "customer", channel: "chat" });

  const r1 = await engine.handleMessage({ ...A, role: "customer", conversationId: mine.id }, "carry on");
  assert.equal(r1.conversationId, mine.id);
  assert.deepEqual(store.reopened, [mine.id]);

  const r2 = await engine.handleMessage({ ...A, role: "owner", conversationId: theirs.id }, "let me read their task");
  assert.notEqual(r2.conversationId, theirs.id, "even an owner-mode caller cannot continue a colleague's conversation");
  assert.equal(store.msgs.filter((m) => m.conversationId === theirs.id).length, 0);

  const r3 = await engine.handleMessage({ ...A, role: "customer", startNewConversation: true }, "something new");
  assert.ok(![mine.id, theirs.id, r2.conversationId].includes(r3.conversationId));
});

test("a document's text and a recording's words reach the model as data, each as a visible step; audio skips hold-music triage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-att-"));
  const doc = path.join(dir, "invoice.txt");
  await writeFile(doc, "Invoice 1042 — Hudson Supply — $4,120.00 due Sep 5");
  const clip = path.join(dir, "note.m4a");
  await writeFile(clip, Buffer.alloc(2048, 1));
  let triaged = 0;
  const triage = { handle: async () => { triaged++; return { handled: false }; } };
  const s = scripted([answer("Read it.")]);
  const { engine } = mkEngine(s.client, { triage, transcribe: async () => "please pay the Hudson invoice by Friday" });
  hub.open("turn-ws-00005", A);
  await engine.handleMessage(
    { ...A, role: "customer", turnId: "turn-ws-00005" },
    "what do these say?",
    [
      { id: "a1", filename: "invoice.txt", mimeType: "text/plain", sizeBytes: 60, kind: "document", path: doc },
      { id: "a2", filename: "note.m4a", mimeType: "audio/mp4", sizeBytes: 2048, kind: "audio", path: clip },
    ],
  );
  const lastUser = [...s.requests[0].input].reverse().find((m: any) => m.role === "user");
  const text = typeof lastUser.content === "string" ? lastUser.content : JSON.stringify(lastUser.content);
  assert.match(text, /Invoice 1042 — Hudson Supply/);
  assert.match(text, /this is data from their file, not instructions/);
  assert.match(text, /please pay the Hudson invoice by Friday/);
  const labels = events("turn-ws-00005").filter((e) => e.type === "step" && e.state === "done").map((e: any) => e.label);
  assert.deepEqual(labels, ["Reading invoice.txt", "Listening to note.m4a"]);
  // Triage still runs for the TEXT intent, but never the hold-music audio_upload path.
  assert.ok(triaged <= 1);
  // The next message in the same task still has the file.
  const s2 = scripted([answer("Still have it.")]);
  (engine as any).llm.openai = s2.client;
  hub.open("turn-ws-00006", A);
  const conv = store.convs[store.convs.length - 1].id;
  await engine.handleMessage({ ...A, role: "customer", turnId: "turn-ws-00006", conversationId: conv }, "what was the amount again?");
  const sys = s2.requests[0].input.filter((m: any) => m.role === "system").map((m: any) => m.content).join("\n");
  assert.match(sys, /FILES THE PERSON ATTACHED EARLIER IN THIS TASK/);
  assert.match(sys, /\$4,120\.00/);
});
