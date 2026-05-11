import test from "node:test";
import assert from "node:assert/strict";
import { parseBytesRangeHeader } from "./httpVoicemailRange";

test("parseBytesRangeHeader: missing → null", () => {
  assert.equal(parseBytesRangeHeader(undefined, 100), null);
  assert.equal(parseBytesRangeHeader("", 100), null);
});

test("parseBytesRangeHeader: non-bytes → null", () => {
  assert.equal(parseBytesRangeHeader("items=0-1", 100), null);
});

test("parseBytesRangeHeader: closed range", () => {
  const r = parseBytesRangeHeader("bytes=0-9", 100);
  assert.deepEqual(r, { start: 0, end: 9 });
});

test("parseBytesRangeHeader: open-end range", () => {
  const r = parseBytesRangeHeader("bytes=90-", 100);
  assert.deepEqual(r, { start: 90, end: 99 });
});

test("parseBytesRangeHeader: suffix length", () => {
  const r = parseBytesRangeHeader("bytes=-10", 100);
  assert.deepEqual(r, { start: 90, end: 99 });
});

test("parseBytesRangeHeader: start past end of body → null", () => {
  assert.equal(parseBytesRangeHeader("bytes=100-200", 100), null);
});

test("parseBytesRangeHeader: first range only when comma-separated", () => {
  const r = parseBytesRangeHeader("bytes=0-1, 2-3", 100);
  assert.deepEqual(r, { start: 0, end: 1 });
});
