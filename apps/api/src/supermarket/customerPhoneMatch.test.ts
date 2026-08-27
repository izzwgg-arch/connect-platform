/**
 * Phone matching — "they said 783 and it came through as 780" (Izzy,
 * 2026-08-27). The safety property under test: a corrected or ambiguous
 * number NEVER reads as certain, because an account carries cards on file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { digitDistance, needsRepConfirmation, resolveCustomerPhone } from "./customerPhoneMatch";

test("digitDistance counts one slip, including an ADJACENT TRANSPOSITION", () => {
  assert.equal(digitDistance("8457831234", "8457831234"), 0);
  assert.equal(digitDistance("8457801234", "8457831234"), 1, "one substituted digit");
  assert.equal(digitDistance("8457381234", "8457831234"), 1, "783 heard as 738 is ONE slip, not two");
  assert.equal(digitDistance("845783123", "8457831234"), 1, "a dropped digit");
  assert.ok(digitDistance("8452481234", "8457831234") > 1, "a different customer is not 'close'");
});

test("nothing spoken falls back to the number they called from", () => {
  const v = resolveCustomerPhone({ spoken: "", callerId: "8457831234" });
  assert.equal(v.phone, "8457831234");
  assert.equal(v.confidence, "caller_id");
  assert.equal(needsRepConfirmation(v), false);
});

test("saying the number you are calling from is the strongest agreement", () => {
  const v = resolveCustomerPhone({ spoken: "783-1234", callerId: "8457831234" });
  assert.equal(v.phone, "8457831234", "7 digits imply 845");
  assert.equal(v.confidence, "stated");
});

test("one digit off the CALLER ID resolves to the caller ID — and asks the rep", () => {
  const v = resolveCustomerPhone({ spoken: "8457801234", callerId: "8457831234" });
  assert.equal(v.phone, "8457831234", "the call physically came from here");
  assert.equal(v.confidence, "corrected");
  assert.equal(v.heard, "8457801234");
  assert.ok(v.note?.includes("(845) 780-1234") && v.note?.includes("(845) 783-1234"));
  assert.equal(needsRepConfirmation(v), true, "a card on file makes a silent bind unacceptable");
});

test("one digit off exactly ONE past customer is corrected to that customer", () => {
  const v = resolveCustomerPhone({
    spoken: "8457801234",
    callerId: "",
    known: ["8457831234", "8452489999", "8457741111"],
  });
  assert.equal(v.phone, "8457831234");
  assert.equal(v.confidence, "corrected");
  assert.equal(needsRepConfirmation(v), true);
});

test("⛔ several equally-close customers pick NOTHING — the wrong-account guard", () => {
  const v = resolveCustomerPhone({
    spoken: "8457831234",
    callerId: "",
    known: ["8457831235", "8457831230", "8457831634"],
  });
  assert.equal(v.confidence, "ambiguous");
  assert.ok((v.candidates ?? []).length >= 2, "the rep is handed the choices");
  assert.equal(needsRepConfirmation(v), true);
  assert.ok(v.note?.includes("confirm"));
});

test("an exact past customer is stated even when calling from another phone", () => {
  const v = resolveCustomerPhone({ spoken: "8457831234", callerId: "9175550000", known: ["8457831234"] });
  assert.equal(v.phone, "8457831234");
  assert.equal(v.confidence, "stated");
  assert.equal(needsRepConfirmation(v), false);
});

test("a number new to us is kept as spoken, with the caller ID offered", () => {
  const v = resolveCustomerPhone({ spoken: "8459990000", callerId: "8457831234", known: ["8457741111"] });
  assert.equal(v.phone, "8459990000");
  assert.equal(v.confidence, "unknown");
  assert.deepEqual(v.candidates, ["8457831234"]);
});

test("no usable digits anywhere is honest, not a guess", () => {
  const v = resolveCustomerPhone({ spoken: "hello", callerId: "" });
  assert.equal(v.phone, "");
  assert.equal(v.confidence, "unknown");
});

test("the caller ID is preferred over a same-distance history match", () => {
  // both are one digit away; the call physically came from the caller ID
  const v = resolveCustomerPhone({ spoken: "8457801234", callerId: "8457831234", known: ["8457821234"] });
  assert.equal(v.phone, "8457831234");
});

test("REAL MONROE PREFIXES: a 783/782/774/238/662 slip resolves, a stranger does not", () => {
  const known = ["8457831111", "8457822222", "8457743333", "8452384444", "8456625555"];
  for (const [heard, want] of [
    ["8457831112", "8457831111"],
    ["8457872222", "8457822222"],
    ["8457743334", "8457743333"],
  ] as const) {
    const v = resolveCustomerPhone({ spoken: heard, callerId: "", known });
    assert.equal(v.phone, want, `${heard} should correct to ${want}`);
    assert.equal(v.confidence, "corrected");
  }
  const far = resolveCustomerPhone({ spoken: "7185550000", callerId: "", known });
  assert.equal(far.confidence, "unknown", "a genuinely different number must not be dragged onto a local one");
});

test("knownCustomerPhones reads SUBMITTED orders only, normalized and deduped", async () => {
  const { knownCustomerPhones } = await import("./customerPhoneMatch");
  const seen: any[] = [];
  const db = {
    supermarketOrderDraft: {
      findMany: async (a: any) => {
        seen.push(a);
        return [
          { customerPhone: "845-783-1234" },
          { customerPhone: "8457831234" },
          { customerPhone: "782-9999" },
          { customerPhone: "" },
          { customerPhone: "junk" },
        ];
      },
    },
  };
  const out = await knownCustomerPhones(db, "t1");
  // ⛔ SUBMITTED only: an un-submitted draft may itself carry the mis-heard
  // number this whole module exists to correct
  assert.equal(seen[0].where.status, "SUBMITTED");
  assert.equal(seen[0].where.tenantId, "t1");
  assert.deepEqual(out, ["8457831234", "8457829999"], "normalized, deduped, junk dropped");
});

test("a failed history read costs the correction, never the draft", async () => {
  const { knownCustomerPhones } = await import("./customerPhoneMatch");
  const db = { supermarketOrderDraft: { findMany: async () => { throw new Error("boom"); } } };
  assert.deepEqual(await knownCustomerPhones(db, "t1"), []);
});

test("SOURCE GUARDS: both draft paths reconcile, and the reprocess uses the REAL caller ID", async () => {
  const fs = await import("node:fs");
  const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const builder = read("src/supermarket/draftBuilder.ts");
  // ⛔ two creation paths (voicemail + text) — fixing one is this repo's
  // recurring half-fix shape
  assert.equal((builder.match(/resolveCustomerPhone\(/g) ?? []).length, 2, "both draft paths must reconcile the phone");
  assert.equal((builder.match(/phoneMatch: phoneMatch as any,/g) ?? []).length, 2, "both must persist the verdict");
  assert.match(builder, /const knownPhones = await knownCustomerPhones\(/, "history must be read once per tenant, not per draft");
  const routes = read("src/supermarket/supermarketRoutes.ts");
  assert.match(routes, /resolveCustomerPhone\(/, "the re-run must reconcile too");
  // ⛔ SupermarketOrderDraft has NO `thread` relation — a nested select throws
  assert.ok(!/select:\s*\{\s*thread:\s*\{/.test(routes), "never nest-select a relation the draft model does not have");
  assert.match(routes, /connectChatThread[\s\S]{0,120}externalSmsE164/, "the text path must read the thread directly");
});
