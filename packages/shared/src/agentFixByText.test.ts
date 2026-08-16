import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFixReply, renderFixOfferLine, renderFixOutcomeSms, truncateSms } from "./agentFixByText";

test("the shapes a person actually types are accepted", () => {
  for (const t of ["FIX 481203", "fix481203", "Fix it 481203", "FIX: 481203", "  fix   481203  ", "FIX 481203.", "481203 fix"]) {
    assert.deepEqual(parseFixReply(t), { code: "481203" }, `should accept: ${t}`);
  }
});

test("⛔ a reflex 'ok' is NEVER an approval", () => {
  for (const t of ["ok", "OK", "yes", "yes please", "do it", "approved", "go ahead", "sure", "👍"]) {
    assert.equal(parseFixReply(t), null, `must refuse: ${t}`);
  }
});

test("⛔ a bare code with no word is refused", () => {
  assert.equal(parseFixReply("481203"), null);
  assert.equal(parseFixReply("my number is 481203"), null);
});

test("the word alone, or a wrong-length code, is refused", () => {
  assert.equal(parseFixReply("fix"), null);
  assert.equal(parseFixReply("fix it"), null);
  assert.equal(parseFixReply("fix 4812"), null, "4 digits is not a code");
  assert.equal(parseFixReply("fix 4812035"), null, "7 digits is not a code");
});

test("empty and rubbish input never throw", () => {
  assert.equal(parseFixReply(null), null);
  assert.equal(parseFixReply(undefined), null);
  assert.equal(parseFixReply(""), null);
  assert.equal(parseFixReply("   "), null);
});

test("a real sentence containing the word fix does not approve by accident", () => {
  assert.equal(parseFixReply("can you fix this please"), null);
  assert.equal(parseFixReply("the fix looks right to me"), null);
});

test("the offer line says the code and says nothing happens yet", () => {
  const line = renderFixOfferLine("481203");
  assert.match(line, /FIX 481203/);
  assert.match(line, /Nothing happens until you do/i);
});

test("every outcome says plainly whether anything changed", () => {
  assert.match(renderFixOutcomeSms({ kind: "applied", tenantName: "Acme", summary: "Added extension 104." }), /^Done for Acme\./);
  assert.match(renderFixOutcomeSms({ kind: "refused", detail: "that extension is taken." }), /Nothing was changed/);
  assert.match(renderFixOutcomeSms({ kind: "failed", detail: "the phone system refused." }), /Needs a person/);
  assert.match(renderFixOutcomeSms({ kind: "unknown_code" }), /Nothing was changed/);
  assert.match(renderFixOutcomeSms({ kind: "expired" }), /expired/);
  assert.match(renderFixOutcomeSms({ kind: "already_used" }), /already used/);
});

test("⛔ a failed outcome must NOT invite another reply — the approval is spent", () => {
  const msg = renderFixOutcomeSms({ kind: "failed" });
  assert.match(msg, /rather than replying again/);
});

test("outbound text is capped so it stays readable on a phone", () => {
  assert.ok(truncateSms("x".repeat(500)).length <= 300);
  assert.equal(truncateSms("short"), "short");
});
