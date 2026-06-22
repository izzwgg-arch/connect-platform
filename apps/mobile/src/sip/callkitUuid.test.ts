import { test } from "node:test";
import assert from "node:assert/strict";

import { deterministicCallKitUuid, fnv1a32, utf8Bytes } from "./callkitUuid";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("output is a canonical, lowercase, version-5/variant UUID", () => {
  const u = deterministicCallKitUuid("clx0a1b2c3d4e5f6g7h8i9j0k1");
  assert.match(u, UUID_RE);
});

test("deterministic — same callId always yields the same UUID", () => {
  const id = "clxabc123def456ghi789";
  assert.equal(deterministicCallKitUuid(id), deterministicCallKitUuid(id));
});

test("different callIds yield different UUIDs", () => {
  const a = deterministicCallKitUuid("clxAAA");
  const b = deterministicCallKitUuid("clxBBB");
  assert.notEqual(a, b);
});

test("empty string still produces a valid UUID (defensive)", () => {
  assert.match(deterministicCallKitUuid(""), UUID_RE);
});

test("utf8Bytes matches ASCII char codes for cuid-style ids", () => {
  assert.deepEqual(utf8Bytes("abc"), [0x61, 0x62, 0x63]);
});

test("fnv1a32 known vector for ASCII 'a' (offset basis path)", () => {
  // FNV-1a-32("a") = 0xe40c292c — canonical reference value.
  assert.equal(fnv1a32([0x61]) >>> 0, 0xe40c292c);
});

// ── Reference vectors (LOCKED) ───────────────────────────────────────────────
// These exact strings MUST be reproduced byte-for-byte by the native Obj-C
// implementation (ConnectDeterministicCallKitUUID in plugins/withIosVoipPush.js).
// If you change the algorithm, update BOTH sides and these vectors together.
test("locked reference vectors (JS↔native parity anchor)", () => {
  assert.equal(
    deterministicCallKitUuid("call-123"),
    "bcbdbb23-3b75-50f2-a5ad-b6d46bada693",
  );
  assert.equal(
    deterministicCallKitUuid("clx0a1b2c3d4e5f6g7h8i9j0k1"),
    "4b9c9e39-9e19-5ebe-8fc9-a826b860851d",
  );
});
