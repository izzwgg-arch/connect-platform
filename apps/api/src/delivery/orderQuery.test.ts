import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOrdersQuery, ORDERS_DEFAULT_PAGE_SIZE, ORDERS_MAX_PAGE_SIZE } from "./orderQuery";

test("empty query yields defaults: page 1, default page size, no filters", () => {
  const q = parseOrdersQuery({});
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, ORDERS_DEFAULT_PAGE_SIZE);
  assert.equal(q.status, undefined);
  assert.equal(q.storeId, undefined);
  assert.equal(q.from, undefined);
  assert.equal(q.to, undefined);
});

test("null / undefined query is tolerated", () => {
  assert.equal(parseOrdersQuery(null).page, 1);
  assert.equal(parseOrdersQuery(undefined).pageSize, ORDERS_DEFAULT_PAGE_SIZE);
});

test("strings are trimmed and blanks dropped", () => {
  const q = parseOrdersQuery({ status: "  DELIVERED ", storeId: "   " });
  assert.equal(q.status, "DELIVERED");
  assert.equal(q.storeId, undefined);
});

test("from/to parse as instants and an inverted pair is swapped", () => {
  const q = parseOrdersQuery({ from: "2026-06-30T23:59:59.999Z", to: "2026-06-01T00:00:00.000Z" });
  assert.equal(q.from?.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(q.to?.toISOString(), "2026-06-30T23:59:59.999Z");
});

test("unparsable dates are ignored, not thrown", () => {
  const q = parseOrdersQuery({ from: "last tuesday", to: "" });
  assert.equal(q.from, undefined);
  assert.equal(q.to, undefined);
});

test("page and pageSize are clamped; garbage falls back to defaults", () => {
  assert.equal(parseOrdersQuery({ page: "0" }).page, 1);
  assert.equal(parseOrdersQuery({ page: "-4" }).page, 1);
  assert.equal(parseOrdersQuery({ page: "3" }).page, 3);
  assert.equal(parseOrdersQuery({ page: "abc" }).page, 1);
  assert.equal(parseOrdersQuery({ pageSize: "5000" }).pageSize, ORDERS_MAX_PAGE_SIZE);
  assert.equal(parseOrdersQuery({ pageSize: "0" }).pageSize, 1);
  assert.equal(parseOrdersQuery({ pageSize: "25.7" }).pageSize, 25);
  assert.equal(parseOrdersQuery({ pageSize: "nope" }).pageSize, ORDERS_DEFAULT_PAGE_SIZE);
});

test("non-string values for string fields are ignored (array-injection safe)", () => {
  const q = parseOrdersQuery({ status: ["DELIVERED", "READY"], storeId: 42, from: ["2026-01-01"] });
  assert.equal(q.status, undefined);
  assert.equal(q.storeId, undefined);
  assert.equal(q.from, undefined);
});
