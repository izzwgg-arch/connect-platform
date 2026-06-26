// Tests for parseDestExtenFromRecordingPath — the VitalPBX recording-filename
// destination-extension parser that lets IVR/DID-fronted inbound calls send a
// native "ring now" mobile push (the trunk leg never exposes the extension).
//
// Run: pnpm --filter @connect/telephony test

import test from "node:test";
import assert from "node:assert/strict";

// env.ts validates required env on import; CallStateStore -> logger -> env.
process.env.JWT_SECRET = "x".repeat(32);
process.env.AMI_USERNAME = "test";
process.env.AMI_PASSWORD = "test";
process.env.ARI_BASE_URL = "http://test.invalid";
process.env.ARI_USERNAME = "test";
process.env.ARI_PASSWORD = "test";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "fatal";

// require() (not import) so the env vars above are set before CallStateStore ->
// logger -> env.ts runs its load-time validation.
const { parseDestExtenFromRecordingPath } =
  require("./CallStateStore") as typeof import("./CallStateStore");

const LINKED = "1782507389.141209";

test("parses destination extension from a real Luxure IVR recording path", () => {
  const path = `/var/spool/asterisk/monitor/da5327df4a24f3a8/2026/06/26/165633-IN-IVR-5622096644-101-${LINKED}.wav`;
  assert.equal(parseDestExtenFromRecordingPath(path, LINKED), "101");
});

test("parses from the bare (no tenant-hash) path variant", () => {
  const path = `/var/spool/asterisk/monitor/2026/06/26/165633-IN-IVR-5622096644-101-${LINKED}.wav`;
  assert.equal(parseDestExtenFromRecordingPath(path, LINKED), "101");
});

test("anchors on linkedId so a numeric caller-id run is never mistaken for the dest", () => {
  // SOURCE here is a short internal-looking number; DEST is 105. Without the
  // linkedId anchor a naive parser could grab the wrong token.
  const path = `/x/170000-IN-QUEUE-2345-105-${LINKED}.wav`;
  assert.equal(parseDestExtenFromRecordingPath(path, LINKED), "105");
});

test("falls back to the recording-id tail when linkedId is not supplied", () => {
  const path = `/x/165633-IN-IVR-5622096644-101-${LINKED}.wav`;
  assert.equal(parseDestExtenFromRecordingPath(path, null), "101");
});

test("returns null when the dest token is not extension-shaped", () => {
  const path = `/x/165633-IN-IVR-5622096644-5622096644-${LINKED}.wav`;
  assert.equal(parseDestExtenFromRecordingPath(path, LINKED), null);
});

test("returns null for empty / malformed input", () => {
  assert.equal(parseDestExtenFromRecordingPath("", LINKED), null);
  assert.equal(parseDestExtenFromRecordingPath(null, LINKED), null);
  assert.equal(parseDestExtenFromRecordingPath("/x/not-a-recording.txt", LINKED), null);
});

test("ignores the special 's'/'h' dialplan extens (not numeric)", () => {
  const path = `/x/165633-IN-IVR-5622096644-s-${LINKED}.wav`;
  assert.equal(parseDestExtenFromRecordingPath(path, LINKED), null);
});
