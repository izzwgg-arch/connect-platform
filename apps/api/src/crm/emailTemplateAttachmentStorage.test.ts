import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertCrmEmailFileAllowed,
  buildCrmEmailAssetStorageKey,
  readCrmEmailAssetFile,
  resolveCrmEmailAssetStoragePath,
  writeCrmEmailAssetFile,
} from "./emailTemplateAttachmentStorage";

test("CRM email storage: tenant-scoped logo writes never expose raw path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-email-assets-"));
  const previous = process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
  process.env.CRM_EMAIL_ASSET_STORAGE_DIR = root;
  try {
    const written = await writeCrmEmailAssetFile({
      tenantId: "tenant-a",
      ownerId: "branding",
      fileId: "logo-1",
      buffer: Buffer.from("logo-bytes"),
      mimeType: "image/png",
      originalFileName: "logo.png",
      logo: true,
    });
    assert.match(written.storageKey, /^tenants\/tenant-a\/branding\/branding\/logo-1\.png$/);
    assert.doesNotMatch(written.storageKey, /\\/);
    assert.equal((await readCrmEmailAssetFile(written.storageKey)).toString("utf8"), "logo-bytes");
  } finally {
    if (previous === undefined) delete process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
    else process.env.CRM_EMAIL_ASSET_STORAGE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CRM email storage: rejects ZIP attachments", () => {
  assert.throws(() => assertCrmEmailFileAllowed({
    mimeType: "application/zip",
    originalFileName: "archive.zip",
    sizeBytes: 1024,
  }), /unsupported_file_type/);
});

test("CRM email storage: accepts requested attachment allowlist", () => {
  for (const [mimeType, fileName] of [
    ["application/pdf", "doc.pdf"],
    ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "doc.docx"],
    ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet.xlsx"],
    ["text/csv", "data.csv"],
    ["image/jpeg", "photo.jpg"],
    ["image/png", "image.png"],
    ["image/webp", "image.webp"],
  ]) {
    assert.doesNotThrow(() => assertCrmEmailFileAllowed({ mimeType, originalFileName: fileName, sizeBytes: 128 }));
  }
});

test("CRM email storage: path traversal is rejected", () => {
  assert.throws(() => resolveCrmEmailAssetStoragePath("../secret"), /invalid_storage_key/);
});

test("CRM email storage: attachment keys are tenant scoped", () => {
  const keyA = buildCrmEmailAssetStorageKey({
    tenantId: "tenant-a",
    ownerId: "template-1",
    fileId: "file-1",
    mimeType: "application/pdf",
    originalFileName: "proposal.pdf",
  });
  const keyB = buildCrmEmailAssetStorageKey({
    tenantId: "tenant-b",
    ownerId: "template-1",
    fileId: "file-1",
    mimeType: "application/pdf",
    originalFileName: "proposal.pdf",
  });
  assert.notEqual(keyA, keyB);
  assert.match(keyA, /^tenants\/tenant-a\/templates\//);
  assert.match(keyB, /^tenants\/tenant-b\/templates\//);
});
