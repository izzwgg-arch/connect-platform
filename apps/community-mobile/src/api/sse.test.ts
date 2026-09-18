import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSseChunk, parseSseData } from "./sse";

test("a single complete frame with event + data", () => {
  const { frames, rest } = parseSseChunk("event: notification\ndata: {\"id\":\"1\"}\n\n");
  assert.deepEqual(frames, [{ event: "notification", data: '{"id":"1"}', id: null }]);
  assert.equal(rest, "");
});

test("a frame with no event: line defaults to 'message'", () => {
  const { frames } = parseSseChunk("data: hello\n\n");
  assert.deepEqual(frames, [{ event: "message", data: "hello", id: null }]);
});

test("multiple frames in one chunk", () => {
  const { frames, rest } = parseSseChunk("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
  assert.deepEqual(frames, [
    { event: "a", data: "1", id: null },
    { event: "b", data: "2", id: null },
  ]);
  assert.equal(rest, "");
});

test("an incomplete trailing frame is returned as rest, not parsed", () => {
  const { frames, rest } = parseSseChunk("event: a\ndata: 1\n\nevent: b\ndata: 2");
  assert.deepEqual(frames, [{ event: "a", data: "1", id: null }]);
  assert.equal(rest, "event: b\ndata: 2");
});

test("rest from one call can be prepended to the next chunk and still parse correctly", () => {
  const first = parseSseChunk("event: b\ndata: 2");
  const second = parseSseChunk(`${first.rest}\n\n`);
  assert.deepEqual(second.frames, [{ event: "b", data: "2", id: null }]);
});

test("multi-line data: fields join with a newline, per the SSE spec", () => {
  const { frames } = parseSseChunk("data: line one\ndata: line two\n\n");
  assert.deepEqual(frames, [{ event: "message", data: "line one\nline two", id: null }]);
});

test("comment lines (starting with ':') are ignored, e.g. keep-alive pings", () => {
  const { frames } = parseSseChunk(":keep-alive\n\nevent: a\ndata: 1\n\n");
  assert.deepEqual(frames, [{ event: "a", data: "1", id: null }]);
});

test("a frame with only a comment and no data: is dropped", () => {
  const { frames } = parseSseChunk(":ping\n\n");
  assert.deepEqual(frames, []);
});

test("id: is captured when present", () => {
  const { frames } = parseSseChunk("id: 42\nevent: a\ndata: 1\n\n");
  assert.deepEqual(frames, [{ event: "a", data: "1", id: "42" }]);
});

test("CRLF line endings are normalized", () => {
  const { frames } = parseSseChunk("event: a\r\ndata: 1\r\n\r\n");
  assert.deepEqual(frames, [{ event: "a", data: "1", id: null }]);
});

test("parseSseData decodes valid JSON", () => {
  assert.deepEqual(parseSseData('{"unread":3}'), { unread: 3 });
});

test("parseSseData falls back to the raw string on malformed JSON", () => {
  assert.equal(parseSseData("not json"), "not json");
});

test("parseSseData on an empty string returns the empty string, not an error", () => {
  assert.equal(parseSseData(""), "");
});
