import { test } from "node:test";
import assert from "node:assert/strict";
import { readFinalSpeech, SpeechStreamError } from "./speechStream";
import { ModelRouter } from "./router";

const message = (phase?: string) => ({ id: "m1", type: "message", role: "assistant", phase, content: [{ type: "output_text", text: "Four. More detail." }] });
const added = (item: any) => ({ type: "response.output_item.added", item });
const delta = (text: string) => ({ type: "response.output_text.delta", item_id: "m1", delta: text });
const completed = (output: any[]) => ({ type: "response.completed", response: { output, usage: {} } });
async function* events(items: any[]) { yield* items; }

test("final-answer deltas arrive before model completion; response replay is unchanged", async () => {
  const spoken: string[] = [];
  const response = completed([message("final_answer")]);
  async function* live() {
    yield added(message("final_answer")); yield delta("Four. ");
    assert.deepEqual(spoken, ["Four. "], "first sentence must not wait for completion");
    yield delta("More detail."); yield response;
  }
  assert.equal(await readFinalSpeech(live(), text => spoken.push(text)), response.response);
  assert.equal(spoken.join(""), "Four. More detail.");
});

for (const phase of [undefined, "commentary"]) test(`never speaks ${phase ?? "unphased"} text before a tool call`, async () => {
  const items = [message(phase), { type: "function_call", name: "lookup" }];
  await readFinalSpeech(events([added(items[0]), delta("Internal update"), added(items[1]), completed(items)]), () => assert.fail("not final speech"));
});

test("tool-bearing response cannot emit final speech even if it labels later text final", async () => {
  await readFinalSpeech(events([added({ type: "function_call" }), added(message("final_answer")), delta("No."), completed([{ type: "function_call" }])]), () => assert.fail());
});

test("partial stream failures have a no-replay error", async () => {
  await assert.rejects(readFinalSpeech(events([added(message("final_answer")), delta("Four. ")]), () => {}), SpeechStreamError);
  await assert.rejects(readFinalSpeech(events([{ type: "response.incomplete" }]), () => {}), /did not complete/);
});

test("router never falls back after partial speech or re-executes a tool", async () => {
  const router = new ModelRouter({ openaiApiKey: "sk-test" } as any, { record: async () => true } as any);
  let calls = 0; let tools = 0; let fallback = 0;
  (router as any).openai = {
    responses: { create: async () => {
      calls++;
      if (calls === 1) return events([completed([{ type: "function_call", call_id: "c1", name: "lookup", arguments: "{}" }])]);
      return events([added(message("final_answer")), delta("Four. ")]);
    } },
    chat: { completions: { create: async () => { fallback++; throw new Error("must not fallback"); } } },
  };
  await assert.rejects(router.completeWithTools("support_chat", [{ role: "user", content: "q" }], [{ name: "lookup", description: "d", minRole: "customer", parameters: { type: "object", properties: {}, additionalProperties: false }, run: async () => { tools++; return {}; } }], { tenantId: "tenant", role: "customer" }, { onSpeechDelta: () => {} }), SpeechStreamError);
  assert.equal(calls, 2); assert.equal(tools, 1); assert.equal(fallback, 0);
});
