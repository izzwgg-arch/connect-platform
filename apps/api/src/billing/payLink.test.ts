import test from "node:test";
import assert from "node:assert/strict";
import { PAY_LINK_CODE_RE, computePayableSet, generatePayLinkCode, payLinkPublicUrl } from "./payLink";

// ---------------------------------------------------------------------------
// generatePayLinkCode
// ---------------------------------------------------------------------------

test("generatePayLinkCode produces 6-char unambiguous codes", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const code = generatePayLinkCode();
    assert.equal(code.length, 6);
    assert.match(code, PAY_LINK_CODE_RE);
    assert.doesNotMatch(code, /[0O1lI]/);
    seen.add(code);
  }
  // Collisions in 2000 draws over 31^6 (~887M) space should be effectively zero.
  assert.ok(seen.size >= 1999, `unexpected collision rate: ${seen.size}/2000`);
});

// ---------------------------------------------------------------------------
// computePayableSet
// ---------------------------------------------------------------------------

const inv = (over: Partial<{ id: string; invoiceNumber: string; status: string; totalCents: number; balanceDueCents: number; periodStart: string }>) => ({
  id: "i1",
  invoiceNumber: "CC-1",
  status: "OPEN",
  totalCents: 4665,
  balanceDueCents: 4665,
  periodStart: "2026-05-06T00:00:00.000Z",
  ...over,
});

test("computePayableSet totals open invoices and orders oldest-first", () => {
  const { payable, settled, totalDueCents } = computePayableSet([
    inv({ id: "b", invoiceNumber: "CC-2", periodStart: "2026-06-06T00:00:00.000Z" }),
    inv({ id: "a", invoiceNumber: "CC-1", periodStart: "2026-05-06T00:00:00.000Z" }),
  ]);
  assert.equal(totalDueCents, 9330);
  assert.equal(settled.length, 0);
  assert.deepEqual(payable.map((i) => i.id), ["a", "b"]);
});

test("computePayableSet drops invoices paid or voided elsewhere (stale-invoice rule)", () => {
  const { payable, settled, totalDueCents } = computePayableSet([
    inv({ id: "a" }),
    inv({ id: "b", status: "PAID", balanceDueCents: 0 }),
    inv({ id: "c", status: "VOID" }),
  ]);
  assert.equal(totalDueCents, 4665);
  assert.deepEqual(payable.map((i) => i.id), ["a"]);
  assert.deepEqual(settled.map((i) => i.id).sort(), ["b", "c"]);
});

test("computePayableSet includes OVERDUE and FAILED invoices with balance", () => {
  const { payable, totalDueCents } = computePayableSet([
    inv({ id: "a", status: "OVERDUE" }),
    inv({ id: "b", status: "FAILED", periodStart: "2026-06-06T00:00:00.000Z" }),
  ]);
  assert.equal(totalDueCents, 9330);
  assert.equal(payable.length, 2);
});

test("computePayableSet handles zero-balance and null-balance rows", () => {
  const { payable, totalDueCents } = computePayableSet([
    inv({ id: "a", balanceDueCents: 0 }),
    inv({ id: "b", balanceDueCents: null as unknown as number, totalCents: 1200 }),
  ]);
  // null balance falls back to totalCents (matches single-invoice pay flow).
  assert.deepEqual(payable.map((i) => i.id), ["b"]);
  assert.equal(totalDueCents, 1200);
});

// ---------------------------------------------------------------------------
// payLinkPublicUrl
// ---------------------------------------------------------------------------

test("payLinkPublicUrl builds short /p/{code} URL", () => {
  const url = payLinkPublicUrl("X7K2QF");
  assert.match(url, /^https:\/\/.+\/p\/X7K2QF$/);
});
