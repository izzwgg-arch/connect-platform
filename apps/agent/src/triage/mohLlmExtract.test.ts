/**
 * mohLlmExtract — LLM-first hold-music understanding, validation contracts.
 * The model's JSON is UNTRUSTED: everything is re-validated against the
 * tenant's real profiles / clock, and anything off falls back (returns null).
 * Fixed now = 2026-07-27T23:51:00Z (Mon 7:51 PM EDT), tz America/New_York.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMohExtraction, extractMohRequest, type ExtractInput } from "./mohLlmExtract";

const NOW = new Date("2026-07-27T23:51:00Z");
const INPUT: ExtractInput = {
  text: "switch my music on hold to main until eight o'clock",
  profiles: ["Main", "Classic", "No Music"],
  ownExt: "101",
  isAdmin: false,
  tz: "America/New_York",
  now: NOW,
};

test("valid 'set until' answer converts the local end time to the right UTC instant", () => {
  const r = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"Main","scope":"extension","extension":null,"timing":{"kind":"until","end":"2026-07-27 20:00"},"confidence":0.95}`,
    INPUT,
    NOW,
  );
  assert.ok(r);
  assert.equal(r.operation, "set");
  assert.equal(r.profileName, "Main");
  assert.equal(r.scope, "extension");
  assert.equal(r.timing.kind, "until");
  assert.equal((r.timing as any).endAt.toISOString(), "2026-07-28T00:00:00.000Z"); // 8 PM EDT
  assert.match((r.timing as any).label, /8:00 PM/);
});

test("profile names match case-insensitively and canonicalize to the listed spelling", () => {
  const r = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"main","scope":null,"extension":null,"timing":{"kind":"none"},"confidence":0.9}`,
    INPUT,
    NOW,
  );
  assert.equal(r?.profileName, "Main");
});

test("HALLUCINATION GUARD: a profile not in the tenant's list rejects the whole extraction", () => {
  const r = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"Smooth Jazz","scope":null,"extension":null,"timing":{"kind":"none"},"confidence":0.99}`,
    INPUT,
    NOW,
  );
  assert.equal(r, null);
});

test("low confidence rejects; not-hold-music rejects; garbage rejects", () => {
  assert.equal(
    validateMohExtraction(`{"is_hold_music":true,"operation":"set","profile":"Main","scope":null,"extension":null,"timing":{"kind":"none"},"confidence":0.4}`, INPUT, NOW),
    null,
  );
  assert.equal(
    validateMohExtraction(`{"is_hold_music":false,"operation":"set","profile":null,"scope":null,"extension":null,"timing":{"kind":"none"},"confidence":0.9}`, INPUT, NOW),
    null,
  );
  assert.equal(validateMohExtraction(`Sure! I'd be happy to help with that.`, INPUT, NOW), null);
});

test("a code-fenced JSON answer is accepted", () => {
  const r = validateMohExtraction(
    "```json\n" +
      `{"is_hold_music":true,"operation":"restore","profile":null,"scope":null,"extension":null,"timing":{"kind":"duration","minutes":15},"confidence":0.9}` +
      "\n```",
    INPUT,
    NOW,
  );
  assert.equal(r?.operation, "restore");
  assert.equal(r?.timing.kind, "duration");
  assert.equal((r?.timing as any).minutes, 15);
});

test("an 'until' in the past rejects (the model got the clock wrong)", () => {
  const r = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"Main","scope":null,"extension":null,"timing":{"kind":"until","end":"2026-07-27 08:00"},"confidence":0.9}`,
    INPUT,
    NOW,
  );
  assert.equal(r, null);
});

test("a non-numeric extension rejects; a numeric one is kept", () => {
  const bad = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"Main","scope":"extension","extension":"until 8","timing":{"kind":"none"},"confidence":0.9}`,
    INPUT,
    NOW,
  );
  assert.equal(bad, null);
  const good = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"Main","scope":"extension","extension":"102","timing":{"kind":"none"},"confidence":0.9}`,
    INPUT,
    NOW,
  );
  assert.equal(good?.extension, "102");
});

test("weekly timing validates weekday and HH:MM ordering", () => {
  const ok = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"Main","scope":"tenant","extension":null,"timing":{"kind":"weekly","weekday":5,"startTime":"15:00","endTime":"17:00"},"confidence":0.9}`,
    INPUT,
    NOW,
  );
  assert.equal(ok?.timing.kind, "weekly");
  const bad = validateMohExtraction(
    `{"is_hold_music":true,"operation":"set","profile":"Main","scope":"tenant","extension":null,"timing":{"kind":"weekly","weekday":5,"startTime":"17:00","endTime":"15:00"},"confidence":0.9}`,
    INPUT,
    NOW,
  );
  assert.equal(bad, null);
});

test("extractMohRequest: no llm / no providers / thrown call all return null (regex fallback)", async () => {
  assert.equal(await extractMohRequest(null, INPUT), null);
  assert.equal(await extractMohRequest({ available: () => [], complete: async () => ({ text: "{}" }) }, INPUT), null);
  assert.equal(
    await extractMohRequest(
      { available: () => ["openai"], complete: async () => { throw new Error("boom"); } },
      INPUT,
    ),
    null,
  );
});

test("extractMohRequest: prompt carries the profile list, local clock, and extension", async () => {
  let seenSystem = "";
  const llm = {
    available: () => ["openai"],
    complete: async (_task: any, msgs: any[]) => {
      seenSystem = msgs[0].content;
      return { text: `{"is_hold_music":true,"operation":"status","profile":null,"scope":null,"extension":null,"timing":{"kind":"none"},"confidence":0.9}` };
    },
  };
  const r = await extractMohRequest(llm, INPUT);
  assert.equal(r?.operation, "status");
  assert.match(seenSystem, /"Main", "Classic", "No Music"/);
  assert.match(seenSystem, /Monday 2026-07-27 19:51/); // 7:51 PM EDT local clock
  assert.match(seenSystem, /OWN EXTENSION: 101/);
  assert.match(seenSystem, /NEVER the "profile" value/); // the back-to rule
  assert.match(seenSystem, /NOT tomorrow 09:45/); // next-occurrence worked example (live misread 2026-07-27)
});
