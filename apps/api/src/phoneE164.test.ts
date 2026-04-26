import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUsCanadaToE164 } from "@connect/shared";

describe("normalizeUsCanadaToE164", () => {
  const cases: [string, string][] = [
    ["8455551234", "+18455551234"],
    ["18455551234", "+18455551234"],
    ["+18455551234", "+18455551234"],
    ["(845) 555-1234", "+18455551234"],
    ["845-555-1234", "+18455551234"],
    ["1-845-555-1234", "+18455551234"],
    ["+1 (845) 555-1234", "+18455551234"],
  ];
  for (const [input, want] of cases) {
    it(`normalizes ${JSON.stringify(input)}`, () => {
      const r = normalizeUsCanadaToE164(input);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.e164, want);
    });
  }

  it("same canonical for all campaign variants", () => {
    const a = normalizeUsCanadaToE164("8455551234");
    const b = normalizeUsCanadaToE164("+18455551234");
    assert(a.ok && b.ok);
    assert.equal(a.e164, b.e164);
  });
});
