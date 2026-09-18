import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fenceReply, improvise, scriptedLine, stickerEndsIn, type GuideFacts } from "./laybelGuide";
import { resetRecipeFor } from "@connect/shared";

const facts = (over: Partial<GuideFacts> = {}, phone: Partial<NonNullable<GuideFacts["phone"]>> = {}): GuideFacts => ({
  extension: { number: "101", name: "Sarah" },
  phone: { model: "SIP-T42S", vendor: "yealink", stickerEndsIn: "60 5F", connected: false, registeredAsExt: null, statusLine: null, freshOutOfBox: false, ...phone },
  recipe: resetRecipeFor("yealink", "SIP-T42S"),
  progress: { connected: 0, total: 4 },
  ...over,
});

describe("stickerEndsIn", () => {
  it("is the last four hex characters, spaced in pairs, from any MAC spelling", () => {
    assert.equal(stickerEndsIn("c074ad8c605f"), "60 5F");
    assert.equal(stickerEndsIn("C0:74:AD:8C:60:5F"), "60 5F");
    assert.equal(stickerEndsIn("60"), null);
    assert.equal(stickerEndsIn(null), null);
  });
});

describe("scriptedLine — every situation has a line built from the facts", () => {
  it("names the extension, the phone, and the sticker code", () => {
    const r = scriptedLine("confirm_phone", facts());
    assert.match(r.say, /SIP-T42S/);
    assert.match(r.say, /60 5F/);
    assert.match(r.say, /Sarah/);
    assert.match(r.say, /wipe it first/);
    assert.match(scriptedLine("confirm_phone", facts({}, { freshOutOfBox: true })).say, /no reset needed/);
  });
  it("the reset line carries the recipe's first step and hold time", () => {
    const r = scriptedLine("reset", facts());
    assert.match(r.say, /Hold the OK button/);
    assert.match(r.say, /10 seconds/);
    assert.ok(r.chips.includes("It wants a password"));
  });
  it("⛔ 'connected' only says connected when the facts do", () => {
    assert.match(scriptedLine("connected", facts()).say, /still waiting/);
    const live = scriptedLine("connected", facts({}, { connected: true, registeredAsExt: "101" }));
    assert.match(live.say, /live/);
    assert.match(live.say, /check in as 101/);
  });
  it("never uses technician words on any situation", () => {
    const all = ["choose_extension", "choose_phone", "confirm_phone", "reset", "reset_waiting", "connecting", "connected", "stuck_old_provider", "stuck_password", "stuck_not_checking_in", "stuck_unsupported", "needs_serial", "done_all"] as const;
    for (const s of all) {
      const r = scriptedLine(s, facts());
      assert.ok(r.say.length > 10, s);
      // (a model NAME like "SIP-T42S" is the phone's own name and is allowed; the bare word is not)
      assert.ok(!/provision|\bSIP\b(?!-)|P\d{2,3}\b|LCD|firmware|MAC address/i.test(r.say), `${s}: ${r.say}`);
    }
  });
});

describe("fenceReply — the truth fence", () => {
  it("drops a sentence claiming connection when the phone is not connected", () => {
    const out = fenceReply("Nice, your phone is connected now. Pick up the next one.", facts());
    assert.equal(out, "Pick up the next one.");
  });
  it("keeps the claim when the facts back it", () => {
    const out = fenceReply("Your phone is connected now. Pick up the next one.", facts({}, { connected: true, registeredAsExt: "101" }));
    assert.match(out ?? "", /connected now/);
  });
  it("keeps honest negatives ('not connected yet', 'once it is connected')", () => {
    const out = fenceReply("It is not connected yet. Once it is connected I'll tell you.", facts());
    assert.equal(out, "It is not connected yet. Once it is connected I'll tell you.");
  });
  it("drops any request for the phone's password and every URL/IP", () => {
    const out = fenceReply("Open http://192.168.6.170 in a browser. What is your password? Hold OK for ten seconds.", facts());
    assert.equal(out, "Open in a browser. Hold OK for ten seconds.");
  });
  it("returns null when nothing honest is left, so the caller falls back", () => {
    assert.equal(fenceReply("It's connected and working!", facts()), null);
  });
});

describe("improvise — the model behind the fence, with a budget", () => {
  const deps = (reply: string | Error, budget = 5) => {
    let left = budget; let calls = 0;
    return {
      deps: { callModel: async () => { calls++; if (reply instanceof Error) throw reply; return reply; }, budgetLeft: () => left, spend: () => { left--; } },
      calls: () => calls, left: () => left,
    };
  };
  it("answers a free-form message through the model, parsed, fenced, chips capped at 3", async () => {
    const d = deps(JSON.stringify({ say: "Hold it a bit longer — a full fifteen seconds. Your phone is connected! Then tell me what the screen says.", chips: ["Holding", "It asked", "Nothing", "Extra"] }));
    const r = await improvise("reset", facts(), "nothing happened when I held it", [], d.deps);
    assert.equal(r.improvised, true);
    assert.equal(r.say, "Hold it a bit longer — a full fifteen seconds. Then tell me what the screen says.");
    assert.deepEqual(r.chips, ["Holding", "It asked", "Nothing"]);
    assert.equal(d.calls(), 1);
    assert.equal(d.left(), 4);
  });
  it("no message → the scripted line, no model call", async () => {
    const d = deps("should not be called");
    const r = await improvise("reset", facts(), "", [], d.deps);
    assert.equal(r.improvised, false);
    assert.equal(d.calls(), 0);
  });
  it("no key, exhausted budget, a thrown call, or an all-lies reply → scripted fallback, never silence", async () => {
    const noKey = await improvise("reset", facts(), "help", [], { callModel: null, budgetLeft: () => 5, spend: () => {} });
    assert.match(noKey.say, /didn't quite get that/);
    const spent = deps("x", 0);
    assert.equal((await improvise("reset", facts(), "help", [], spent.deps)).improvised, false);
    assert.equal(spent.calls(), 0);
    const threw = deps(new Error("boom"));
    assert.equal((await improvise("reset", facts(), "help", [], threw.deps)).improvised, false);
    const lies = deps(JSON.stringify({ say: "It's connected and working now!", chips: [] }));
    const r = await improvise("reset", facts(), "is it done?", [], lies.deps);
    assert.equal(r.improvised, false);
    assert.match(r.say, /Hold the OK button/);
  });
  it("a non-JSON model reply is still used as plain text (fenced)", async () => {
    const d = deps("Try holding the button again for fifteen seconds.");
    const r = await improvise("reset", facts(), "?", [], d.deps);
    assert.equal(r.say, "Try holding the button again for fifteen seconds.");
    assert.deepEqual(r.chips, []);
  });
});
