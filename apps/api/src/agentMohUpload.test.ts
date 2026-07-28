/**
 * Agent MOH-upload door — pure helper contracts.
 *
 * Pinned behaviors:
 *  - Base64 decode enforces the total-size ceiling and rejects empty files.
 *  - Name uniquify appends " 2", " 3", … case-insensitively.
 *  - Filename → profile-name derivation strips extensions and separators.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentMohUploadRequest,
  decodeAgentMohUploadFiles,
  uniquifyMohName,
  nameFromFilename,
  AGENT_MOH_UPLOAD_MAX_TOTAL_BYTES,
} from "./agentMohUpload";

test("schema: accepts a well-formed playlist payload", () => {
  const r = AgentMohUploadRequest.safeParse({
    tenantId: "21",
    name: "Party Mix",
    requestedBy: "agent:conv1",
    files: [
      { filename: "a.mp3", dataBase64: "QUFBQUFBQUE=" },
      { filename: "b.mp3", dataBase64: "QkJCQkJCQkI=" },
    ],
  });
  assert.equal(r.success, true);
});

test("schema: rejects empty file list and over-long names", () => {
  assert.equal(AgentMohUploadRequest.safeParse({ tenantId: "21", name: "X", files: [] }).success, false);
  assert.equal(
    AgentMohUploadRequest.safeParse({ tenantId: "21", name: "x".repeat(61), files: [{ filename: "a.mp3", dataBase64: "QUFBQQ==" }] }).success,
    false,
  );
});

test("decode: strips data-URL prefixes and rejects tiny/empty files", () => {
  const buf = Buffer.alloc(256, 7);
  const out = decodeAgentMohUploadFiles([{ filename: "a.mp3", dataBase64: `data:audio/mpeg;base64,${buf.toString("base64")}` }]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].buffer, buf);
  assert.throws(() => decodeAgentMohUploadFiles([{ filename: "tiny.mp3", dataBase64: Buffer.alloc(16).toString("base64") }]), /file_empty/);
});

test("decode: enforces the cumulative size ceiling", () => {
  const big = Buffer.alloc(Math.ceil(AGENT_MOH_UPLOAD_MAX_TOTAL_BYTES / 2) + 1024).toString("base64");
  assert.throws(
    () =>
      decodeAgentMohUploadFiles([
        { filename: "a.mp3", dataBase64: big },
        { filename: "b.mp3", dataBase64: big },
      ]),
    /upload_too_large/,
  );
});

test("uniquify: appends counters case-insensitively", () => {
  const taken = new Set(["party mix", "party mix 2"]);
  assert.equal(uniquifyMohName("Party Mix", taken), "Party Mix 3");
  assert.equal(uniquifyMohName("Fresh Name", taken), "Fresh Name");
  assert.equal(uniquifyMohName("  spaced   out  ", new Set()), "spaced out");
});

test("nameFromFilename: strips extension and separators", () => {
  assert.equal(nameFromFilename("my-holiday_jazz.v2.mp3"), "my holiday jazz v2");
  assert.equal(nameFromFilename("Track01.WAV"), "Track01");
  assert.equal(nameFromFilename(""), "Uploaded music");
});
