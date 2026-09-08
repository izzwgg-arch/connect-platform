import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDraftListQuery, draftSearchWhere, DRAFTS_DEFAULT_PAGE_SIZE, DRAFTS_MAX_PAGE_SIZE } from "./draftListQuery";

test("empty query → defaults, no filters", () => {
  const q = parseDraftListQuery({});
  assert.equal(q.page, 1);
  assert.equal(q.pageSize, DRAFTS_DEFAULT_PAGE_SIZE);
  assert.equal(q.status, undefined);
  assert.equal(q.sourceType, undefined);
  assert.equal(q.from, undefined);
  assert.equal(q.to, undefined);
  assert.equal(q.q, undefined);
  assert.equal(parseDraftListQuery(null).page, 1);
});

test("status and source are whitelisted; unknown values mean 'all'", () => {
  assert.equal(parseDraftListQuery({ status: "SUBMIT_FAILED" }).status, "SUBMIT_FAILED");
  assert.equal(parseDraftListQuery({ status: "ALL" }).status, undefined);
  assert.equal(parseDraftListQuery({ status: "needs_review" }).status, undefined);
  assert.equal(parseDraftListQuery({ source: "Voicemail" }).sourceType, "voicemail");
  assert.equal(parseDraftListQuery({ source: "fax" }).sourceType, undefined);
});

test("from/to parse as instants; inverted pair swapped; garbage ignored", () => {
  const q = parseDraftListQuery({ from: "2026-06-30T23:59:59.999Z", to: "2026-06-01T00:00:00.000Z" });
  assert.equal(q.from?.toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal(q.to?.toISOString(), "2026-06-30T23:59:59.999Z");
  assert.equal(parseDraftListQuery({ from: "yesterday" }).from, undefined);
});

test("page/pageSize clamp; q is trimmed and capped", () => {
  assert.equal(parseDraftListQuery({ page: "0" }).page, 1);
  assert.equal(parseDraftListQuery({ page: "7" }).page, 7);
  assert.equal(parseDraftListQuery({ pageSize: "9999" }).pageSize, DRAFTS_MAX_PAGE_SIZE);
  assert.equal(parseDraftListQuery({ pageSize: "x" }).pageSize, DRAFTS_DEFAULT_PAGE_SIZE);
  assert.equal(parseDraftListQuery({ q: "  Weiss " }).q, "Weiss");
  assert.equal(parseDraftListQuery({ q: "a".repeat(200) }).q?.length, 80);
  assert.equal(parseDraftListQuery({ q: ["Weiss"] }).q, undefined);
});

test("search: a name searches customerName (insensitive) and posOrderId", () => {
  const w = draftSearchWhere("Weiss")!;
  assert.deepEqual(w.OR, [
    { customerName: { contains: "Weiss", mode: "insensitive" } },
    { posOrderId: { contains: "Weiss" } },
  ]);
});

test("search: a phone searches by digits and by raw text", () => {
  const w = draftSearchWhere("(845) 555-01")!;
  assert.deepEqual(w.OR, [
    { customerPhone: { contains: "84555501" } },
    { customerPhone: { contains: "(845) 555-01" } },
    { posOrderId: { contains: "(845) 555-01" } },
  ]);
  const plain = draftSearchWhere("48211")!;
  assert.deepEqual(plain.OR, [{ customerPhone: { contains: "48211" } }, { posOrderId: { contains: "48211" } }]);
});

test("search: short digits still search the name; empty → null", () => {
  const w = draftSearchWhere("12")!;
  assert.ok(w.OR.some((c) => "customerName" in c));
  assert.equal(draftSearchWhere(""), null);
  assert.equal(draftSearchWhere(undefined), null);
});
