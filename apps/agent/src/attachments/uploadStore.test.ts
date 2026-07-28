/**
 * ChatUploadStore — chunked chat-widget uploads.
 *
 * Pinned behaviors:
 *  - init → chunk×N → finish reassembles the exact original bytes.
 *  - Attachments resolve ONLY within their own tenant (isolation).
 *  - Size/chunk guards reject oversized or malformed uploads.
 *  - Audio vs document classification drives the hold-music flow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ChatUploadStore, classifyAttachment, safeFilename, MAX_FILE_BYTES } from "./uploadStore";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "chat-uploads-test-"));
}

const ID = { tenantId: "t1", clientUserId: "u1" };

test("chunked upload reassembles the original bytes in order", async () => {
  const store = new ChatUploadStore(tmpRoot());
  const data = Buffer.from("hello ".repeat(1000)); // 6000 bytes
  const chunks = [data.subarray(0, 2500), data.subarray(2500, 5000), data.subarray(5000)];
  const init = await store.init({ ...ID, filename: "song.mp3", mimeType: "audio/mpeg", sizeBytes: data.length, totalChunks: 3 });
  assert.ok("uploadId" in init);
  const uploadId = (init as any).uploadId;
  // Out-of-order on purpose — indexes place the chunks, not arrival order.
  for (const i of [2, 0, 1]) {
    const r = await store.addChunk({ tenantId: "t1", uploadId, index: i, dataBase64: chunks[i].toString("base64") });
    assert.ok("ok" in r, JSON.stringify(r));
  }
  const fin = await store.finish({ tenantId: "t1", uploadId });
  assert.ok("ok" in fin, JSON.stringify(fin));
  const att = (fin as any).attachment;
  assert.equal(att.kind, "audio");
  assert.equal(att.sizeBytes, data.length);
  assert.deepEqual(await fs.promises.readFile(att.path), data);
});

test("attachment lookups are tenant-isolated", async () => {
  const store = new ChatUploadStore(tmpRoot());
  const init = await store.init({ ...ID, filename: "doc.pdf", mimeType: "application/pdf", sizeBytes: 4, totalChunks: 1 });
  const uploadId = (init as any).uploadId;
  await store.addChunk({ tenantId: "t1", uploadId, index: 0, dataBase64: Buffer.from("test").toString("base64") });
  const fin = await store.finish({ tenantId: "t1", uploadId });
  const att = (fin as any).attachment;
  assert.ok(store.get(att.id, "t1"));
  assert.equal(store.get(att.id, "t2"), null); // other tenant sees nothing
});

test("chunk writes are tenant-checked too", async () => {
  const store = new ChatUploadStore(tmpRoot());
  const init = await store.init({ ...ID, filename: "a.mp3", mimeType: "audio/mpeg", sizeBytes: 4, totalChunks: 1 });
  const r = await store.addChunk({ tenantId: "OTHER", uploadId: (init as any).uploadId, index: 0, dataBase64: "dGVzdA==" });
  assert.deepEqual(r, { error: "upload_not_found" });
});

test("finish refuses when chunks are missing", async () => {
  const store = new ChatUploadStore(tmpRoot());
  const init = await store.init({ ...ID, filename: "a.mp3", mimeType: "audio/mpeg", sizeBytes: 8, totalChunks: 2 });
  await store.addChunk({ tenantId: "t1", uploadId: (init as any).uploadId, index: 0, dataBase64: "dGVzdA==" });
  const fin = await store.finish({ tenantId: "t1", uploadId: (init as any).uploadId });
  assert.deepEqual(fin, { error: "chunks_missing" });
});

test("oversized declarations and bad chunk counts are rejected at init", async () => {
  const store = new ChatUploadStore(tmpRoot());
  assert.deepEqual(await store.init({ ...ID, filename: "big.mp3", mimeType: "audio/mpeg", sizeBytes: MAX_FILE_BYTES + 1, totalChunks: 1 }), {
    error: "file_too_large",
  });
  assert.deepEqual(await store.init({ ...ID, filename: "a.mp3", mimeType: "audio/mpeg", sizeBytes: 10, totalChunks: 0 }), {
    error: "bad_chunk_count",
  });
});

test("classification: audio by mime OR extension, everything else is a document", () => {
  assert.equal(classifyAttachment("song.mp3", "application/octet-stream"), "audio");
  assert.equal(classifyAttachment("clip.bin", "audio/mpeg"), "audio");
  assert.equal(classifyAttachment("Song Name.WAV", ""), "audio");
  assert.equal(classifyAttachment("report.pdf", "application/pdf"), "document");
  assert.equal(classifyAttachment("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "document");
});

test("safeFilename strips path tricks and dangerous characters", () => {
  assert.equal(safeFilename("../../etc/passwd"), "passwd");
  assert.ok(!safeFilename("a/b\\c<d>.mp3").includes("/"));
  assert.equal(safeFilename(""), "file");
});

test("sweep drops expired sessions and attachments", async () => {
  const store = new ChatUploadStore(tmpRoot());
  const init = await store.init({ ...ID, filename: "a.mp3", mimeType: "audio/mpeg", sizeBytes: 4, totalChunks: 1 });
  const uploadId = (init as any).uploadId;
  await store.addChunk({ tenantId: "t1", uploadId, index: 0, dataBase64: "dGVzdA==" });
  const fin = await store.finish({ tenantId: "t1", uploadId });
  const att = (fin as any).attachment;
  store.sweep(Date.now() + 25 * 3600_000); // past the 24h attachment TTL
  assert.equal(store.get(att.id, "t1"), null);
});
