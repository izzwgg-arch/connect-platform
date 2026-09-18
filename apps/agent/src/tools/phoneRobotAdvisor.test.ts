/**
 * The phone-web-robot's brain — round 23 (2026-09-17). Driven against a FAKE
 * `ModelRouter.complete`, because the whole point of this file is what this
 * module does with whatever the model said (parse strictly, never throw, carry
 * the playbook and the allowed URL into the prompt) — never whether a real
 * OpenAI/Anthropic call answers well, which is not this module's job to prove.
 *
 * Run with: node --experimental-test-module-mocks --import tsx --test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advisePhoneRobot, __clearPhoneRobotPlaybookCacheForTests, type PhoneRobotAdviseInput,
} from "./phoneRobotAdvisor";

function fakeRouter(reply: (messages: Array<{ role: string; content: string }>) => string | Error) {
  const calls: any[] = [];
  return {
    calls,
    complete: async (task: string, messages: any[], opts: any) => {
      calls.push({ task, messages, opts });
      const r = reply(messages);
      if (r instanceof Error) throw r;
      return { provider: "openai", model: "gpt-5", text: r, inputTokens: 10, outputTokens: 10, failedOver: false };
    },
  };
}

const INPUT: PhoneRobotAdviseInput = {
  goal: "provision",
  snapshot: { text: "Auto Provision", elements: [{ ref: "ref_1", label: "Server URL" }] },
  history: [],
  allowedUrl: "https://m.connectcomunications.com/phoneprov/0123456789abcdef/",
};

test("a well-formed plan is parsed and carries the provider:model that answered", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => JSON.stringify({
    verdict: "actions",
    actions: [{ kind: "fill", ref: "ref_1", text: INPUT.allowedUrl }, { kind: "click", ref: "ref_2" }],
    customerHint: "Pointing it at Loopcom…",
  }));
  const advice = await advisePhoneRobot(router as any, INPUT);
  assert.equal(advice.verdict, "actions");
  assert.equal(advice.actions?.length, 2);
  assert.equal(advice.customerHint, "Pointing it at Loopcom…");
  assert.equal(advice.model, "openai:gpt-5");
  assert.equal(router.calls[0].task, "phone_web_robot");
});

test("a ```json fence around the answer is stripped, despite being told not to add one", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => "```json\n" + JSON.stringify({ verdict: "done", customerHint: "We signed into the phone and pointed it at Loopcom." }) + "\n```");
  const advice = await advisePhoneRobot(router as any, INPUT);
  assert.equal(advice.verdict, "done");
});

test("text that is not JSON at all is a safe give_up, never a throw", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => "I think we should click the button.");
  const advice = await advisePhoneRobot(router as any, INPUT);
  assert.equal(advice.verdict, "give_up");
  assert.equal(advice.reason, "malformed_model_response");
});

test("JSON that does not match the schema (missing customerHint) is a safe give_up", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => JSON.stringify({ verdict: "actions", actions: [{ kind: "click", ref: "ref_1" }] }));
  const advice = await advisePhoneRobot(router as any, INPUT);
  assert.equal(advice.verdict, "give_up");
  assert.equal(advice.reason, "schema_mismatch");
});

test("an action kind outside the schema is a safe give_up — the agent-side zod is a second, independent copy of the api's own", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => JSON.stringify({
    verdict: "actions",
    actions: [{ kind: "type_anything_anywhere", ref: "ref_1", text: "http://not-allowed.example" }],
    customerHint: "x",
  }));
  const advice = await advisePhoneRobot(router as any, INPUT);
  assert.equal(advice.verdict, "give_up");
  assert.equal(advice.reason, "schema_mismatch");
});

test("a provider error never escapes — it comes back as a plain give_up", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => new Error("all providers failed"));
  const advice = await advisePhoneRobot(router as any, INPUT);
  assert.equal(advice.verdict, "give_up");
});

test("the system prompt carries the playbook, the hard rules, and this call's allowedUrl", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => JSON.stringify({ verdict: "give_up", customerHint: "x" }));
  await advisePhoneRobot(router as any, INPUT);
  const system = router.calls[0].messages.find((m: any) => m.role === "system").content as string;
  assert.match(system, /allowedUrl/i);
  assert.ok(system.includes(INPUT.allowedUrl!), "the exact allowed URL for THIS call must be in the prompt");
  assert.ok(system.includes("Save-verify discipline"), "the playbook file itself must be loaded, not a stub");
  assert.match(system, /never say ai/i, "the hard rule against naming AI/robot/OpenAI on screen must be in the prompt");
});

test("when allowedUrl is null, the prompt says so plainly rather than omitting it silently", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => JSON.stringify({ verdict: "give_up", customerHint: "x" }));
  await advisePhoneRobot(router as any, { ...INPUT, allowedUrl: null });
  const system = router.calls[0].messages.find((m: any) => m.role === "system").content as string;
  assert.match(system, /no provisioning folder is known yet/i);
});

test("the goal, snapshot and history are all sent to the model, unmodified", async () => {
  __clearPhoneRobotPlaybookCacheForTests();
  const router = fakeRouter(() => JSON.stringify({ verdict: "give_up", customerHint: "x" }));
  const history = [{ actions: [{ kind: "click", ref: "ref_1" }], outcome: "ok" }];
  await advisePhoneRobot(router as any, { ...INPUT, history });
  const user = JSON.parse(router.calls[0].messages.find((m: any) => m.role === "user").content as string);
  assert.equal(user.goal, "provision");
  assert.deepEqual(user.history, history);
  assert.deepEqual(user.snapshot, INPUT.snapshot);
});
