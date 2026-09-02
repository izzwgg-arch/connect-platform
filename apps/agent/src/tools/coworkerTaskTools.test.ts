import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCoworkerTaskTools, isInsideCoworkerWindow, COWORKER_CHAT_PATH } from "./coworkerTaskTools";
import type { ToolContext } from "./toolRegistry";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function fakePrisma(rows: any[] = []) {
  const created: any[] = [];
  const updated: any[] = [];
  let seq = 0;
  return {
    rows, created, updated,
    agentAction: {
      findFirst: async ({ where }: any) => rows.find((r) => r.status === where.status && r.requestedBy === where.requestedBy && r.tenantId === where.tenantId) ?? null,
      findMany: async ({ where }: any) => rows.filter((r) => r.requestedBy === where.requestedBy && r.tenantId === where.tenantId),
      create: async ({ data }: any) => { const row = { id: `a${++seq}`, ...data, createdAt: new Date() }; created.push(row); rows.push(row); return { id: row.id }; },
      update: async ({ where, data }: any) => { updated.push({ where, data }); const row = rows.find((r) => r.id === where.id); Object.assign(row, data); return row; },
    },
  };
}

const inBubble: ToolContext = { tenantId: "t1", role: "customer", clientUserId: "u1", viewingPath: COWORKER_CHAT_PATH, conversationId: "c1" };
const tool = (p: any, now = () => 1_000_000) => {
  const spec = buildCoworkerTaskTools({ prisma: p, now }).find((t) => t.name === "coworker_task")!;
  return { run: async (args: any, ctx: ToolContext): Promise<any> => spec.run(args, ctx) };
};
const listTool = (p: any) => {
  const spec = buildCoworkerTaskTools({ prisma: p }).find((t) => t.name === "my_computer_tasks")!;
  return { run: async (args: any, ctx: ToolContext): Promise<any> => spec.run(args, ctx) };
};

test("the tool refuses outside the Coworker window and writes nothing", async () => {
  const p = fakePrisma();
  const r = await tool(p).run({ kind: "folder_summary", folder: "downloads", reason: "x" }, { ...inBubble, viewingPath: "/dashboard" });
  assert.equal(r.ok, false);
  assert.equal(r.error, "not_in_coworker_window");
  assert.equal(p.created.length, 0);
  assert.equal(isInsideCoworkerWindow({ ...inBubble, viewingPath: undefined }), false);
  assert.equal(isInsideCoworkerWindow(inBubble), true);
});

test("an off-list task or a smuggled path never becomes a draft", async () => {
  const p = fakePrisma();
  const r1 = await tool(p).run({ kind: "delete_everything", reason: "x" }, inBubble);
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "unknown_task_kind");
  const r2 = await tool(p).run({ kind: "organize_folder", folder: "C:\\Windows", reason: "x" }, inBubble);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "unknown_folder");
  assert.equal(p.created.length, 0);
});

test("a valid write task writes ONE DRAFT AgentAction whose params carry the task and the policy verdict, and the reply never claims it ran", async () => {
  const p = fakePrisma();
  const r = await tool(p).run({ kind: "organize_folder", folder: "downloads", reason: "You asked me to tidy up" }, inBubble);
  assert.equal(r.ok, true);
  assert.equal(r.needsApproval, true);
  assert.equal(p.created.length, 1);
  const row = p.created[0];
  assert.equal(row.status, "DRAFT");
  assert.equal(row.capabilityId, "coworker.task.v1");
  assert.equal(row.requestedBy, "u1");
  assert.equal(row.tenantId, "t1");
  assert.equal(row.conversationId, "c1");
  assert.deepEqual(row.params.task, { kind: "organize_folder", folder: "downloads", reason: "You asked me to tidy up" });
  assert.equal(row.params.decision.verdict, "ask");
  assert.match(row.paramsHash, /^[a-f0-9]{64}$/);
  assert.match(r.message, /Do not say it is done/);
  assert.ok(!/done|finished|complete/i.test(r.summary), "the summary must not read as completed");
});

test("a read task is allowed by policy but still becomes a card (needsApproval false, still nothing ran)", async () => {
  const p = fakePrisma();
  const r = await tool(p).run({ kind: "system_snapshot", reason: "x" }, inBubble);
  assert.equal(r.ok, true);
  assert.equal(r.needsApproval, false);
  assert.equal(p.created[0].params.decision.verdict, "allow");
  assert.match(r.message, /Do not say it is done/);
});

test("one live proposal per person: a second ask while one is pending is refused and creates nothing", async () => {
  const p = fakePrisma();
  await tool(p).run({ kind: "system_snapshot", reason: "x" }, inBubble);
  const r = await tool(p).run({ kind: "folder_summary", folder: "desktop", reason: "x" }, inBubble);
  assert.equal(r.ok, false);
  assert.equal(r.error, "already_pending");
  assert.equal(p.created.length, 1);
  // …but an EXPIRED draft does not block.
  p.rows[0].createdAt = new Date(0);
  const r2 = await tool(p, () => 10 * 60 * 60 * 1000).run({ kind: "folder_summary", folder: "desktop", reason: "x" }, inBubble);
  assert.equal(r2.ok, true);
});

test("a colleague in the same tenant does not see or block another person's task", async () => {
  const p = fakePrisma();
  await tool(p).run({ kind: "system_snapshot", reason: "x" }, inBubble);
  const other = { ...inBubble, clientUserId: "u2" };
  const list = await listTool(p).run({}, other);
  assert.deepEqual(list.tasks, []);
  const r = await tool(p).run({ kind: "system_snapshot", reason: "x" }, other);
  assert.equal(r.ok, true);
});

test("my_computer_tasks maps states into words and never leaks the params hash", async () => {
  const p = fakePrisma();
  await tool(p).run({ kind: "organize_folder", folder: "downloads", reason: "x" }, inBubble);
  p.rows[0].status = "EXECUTED";
  p.rows[0].resultSnapshot = { ok: true, summary: "Moved 3 files", details: ["a", "b"] };
  const list = await listTool(p).run({}, inBubble);
  assert.equal(list.tasks[0].state, "done");
  assert.equal(list.tasks[0].result, "Moved 3 files");
  assert.ok(!JSON.stringify(list).includes(p.rows[0].paramsHash));
});

/* ───────────── wiring guards ───────────── */

test("ToolContext carries viewingPath + conversationId and the engine passes both (the tool is useless without them)", () => {
  const registry = read(path.resolve(__dirname, "toolRegistry.ts"));
  assert.ok(/viewingPath\?: string/.test(registry));
  assert.ok(/conversationId\?: string/.test(registry));
  const engine = read(path.resolve(__dirname, "../conversation/engine.ts")).split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
  assert.ok(/clientUserId: ctx\.clientUserId,\s*viewingPath: ctx\.viewingPath,\s*conversationId: conv\.id/.test(engine), "engine.ts must pass viewingPath + conversationId into the tool context");
  const server = read(path.resolve(__dirname, "../server.ts"));
  assert.ok(/buildCoworkerTaskTools\(\{ prisma \}\)/.test(server), "server.ts must assemble the coworker task tools into chatTools");
});

test("the prompts tell the model to use coworker_task from the bubble and never to claim the task ran", () => {
  const engine = read(path.resolve(__dirname, "../conversation/engine.ts"));
  assert.ok(engine.includes("coworker_task"), "the system prompt must name the tool");
  assert.ok(/my_computer_tasks/.test(engine));
  assert.ok(!/cannot do anything on the computer/i.test(engine), "the old 'cannot act on the computer' wording must be gone");
});
