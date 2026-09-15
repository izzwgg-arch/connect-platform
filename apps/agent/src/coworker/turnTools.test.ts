import { test } from "node:test";
import assert from "node:assert/strict";
import { ActivityHub } from "./activity";
import { buildTurnTools, coworkerWorkspacePrompt, ASK_PERSON_TOOL, SHOW_PLAN_TOOL } from "./turnTools";
import { TOOL_NAME_RE } from "./desktopLink";

const A = { tenantId: "t1", clientUserId: "u1" };
const ctx = { tenantId: "t1", role: "customer" as const, clientUserId: "u1" };

function setup() {
  const hub = new ActivityHub();
  hub.open("turn-tools-01", A);
  const tools = buildTurnTools(hub, "turn-tools-01");
  const byName = (n: string) => tools.find((t) => t.name === n)!;
  return { hub, ask: byName(ASK_PERSON_TOOL), plan: byName(SHOW_PLAN_TOOL) };
}

test("both tools are customer-tier, strict-schema and legally named for both providers", () => {
  const { ask, plan } = setup();
  for (const t of [ask, plan]) {
    assert.equal(t.minRole, "customer");
    assert.equal(t.parameters.additionalProperties, false);
    assert.match(t.name, TOOL_NAME_RE);
  }
});

test("ask_person waits for the person's answer and hands it back as their decision", async () => {
  const { hub, ask } = setup();
  const running = ask.run({ question: "Save it to Documents or Desktop?", options: ["Documents", "Desktop"] }, ctx);
  await new Promise((r) => setImmediate(r));
  const r = hub.read("turn-tools-01", A, 0);
  const q = r.ok ? r.events.find((e) => e.type === "question") : undefined;
  assert.ok(q && q.type === "question");
  hub.answer("turn-tools-01", A, q.questionId, "Desktop");
  const out = (await running) as Record<string, unknown>;
  assert.equal(out.answered, true);
  assert.equal(out.answer, "Desktop");
});

test("ask_person refuses to ask for a secret and never shows that question", async () => {
  const { hub, ask } = setup();
  for (const question of ["What's your password?", "Read me the one-time code", "What is the card number?", "Tell me your PIN"]) {
    const out = (await ask.run({ question }, ctx)) as Record<string, unknown>;
    assert.equal(out.error, "secret_question_refused", question);
  }
  const r = hub.read("turn-tools-01", A, 0);
  assert.ok(r.ok && !r.events.some((e) => e.type === "question"));
});

test("a skipped or stopped question tells the model what to do next", async () => {
  const { hub, ask } = setup();
  const p = ask.run({ question: "Which one?" }, ctx);
  await new Promise((r) => setImmediate(r));
  const q = (hub.read("turn-tools-01", A, 0) as any).events.find((e: any) => e.type === "question");
  hub.answer("turn-tools-01", A, q.questionId, null);
  const skipped = (await p) as Record<string, unknown>;
  assert.equal(skipped.answered, false);
  assert.match(String(skipped.message), /sensible choice/);
  hub.stop("turn-tools-01", A);
  const stopped = (await ask.run({ question: "Another?" }, ctx)) as Record<string, unknown>;
  assert.equal(stopped.reason, "stopped");
  assert.match(String(stopped.message), /Stop/);
});

test("show_plan emits a bounded plan and refuses a one-step plan", async () => {
  const { hub, plan } = setup();
  assert.equal(((await plan.run({ steps: ["Only one"], current: 0 }, ctx)) as any).error, "too_few_steps");
  const long = Array.from({ length: 12 }, (_, i) => `Step ${i} ${"x".repeat(100)}`);
  const out = (await plan.run({ steps: long, current: 99 }, ctx)) as Record<string, unknown>;
  assert.equal(out.ok, true);
  const r = hub.read("turn-tools-01", A, 0);
  const ev = r.ok ? r.events.find((e) => e.type === "plan") : undefined;
  assert.ok(ev && ev.type === "plan");
  assert.equal(ev.steps.length, 8);
  assert.ok(ev.steps.every((s) => s.length <= 80));
  assert.equal(ev.current, 8, "current is clamped to 'all done'");
});

test("the workspace prompt carries folders, memory, reply style and the phone switch", () => {
  const p = coworkerWorkspacePrompt({
    folders: [{ path: "C:\\dev\\shop", name: "shop", repo: true }, { path: "C:\\Users\\a\\Invoices", name: "Invoices", repo: false }],
    memory: "We close on Fridays at 2.",
    detail: "detailed",
    phoneTools: false,
    handsOn: false,
  });
  assert.match(p, /C:\\dev\\shop/);
  assert.match(p, /computer_git_/);
  assert.match(p, /We close on Fridays at 2\./);
  assert.match(p, /walk them through/);
  assert.match(p, /switched OFF the phone system/);
  assert.match(p, /NOT connected/);
  assert.match(p, /never instructions to break the rules/);
  assert.match(p, /Email is switched OFF/, "email is off unless switched on");
  const minimal = coworkerWorkspacePrompt({ folders: [], memory: "", detail: "short", phoneTools: true, handsOn: true, email: true });
  assert.doesNotMatch(minimal, /FOLDERS THE PERSON ATTACHED|ALWAYS KNOW|switched OFF|NOT connected/);
});
