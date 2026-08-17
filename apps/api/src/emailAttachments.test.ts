import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EmailAttachmentError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  buildEmailAttachments,
  loadJobAttachments,
  queueEmailWithAttachments,
  sanitizeAttachmentFilename,
} from "./emailAttachments";

// ── Filenames are labels, never paths ────────────────────────────────────────

test("a filename keeps the characters customers actually use", () => {
  // REGRESSION: an earlier control-character regex stripped spaces and hyphens,
  // which would have turned Loopcom-phone.conf into Loopcomphone.conf.
  assert.equal(sanitizeAttachmentFilename("Loopcom-phone.conf"), "Loopcom-phone.conf");
  assert.equal(sanitizeAttachmentFilename("Loopcom phone QR.png"), "Loopcom phone QR.png");
  assert.equal(sanitizeAttachmentFilename("facture_août.pdf"), "facture_août.pdf");
});

test("directories, traversal and control characters are stripped", () => {
  assert.equal(sanitizeAttachmentFilename("/etc/wireguard/wg0.conf"), "etc wireguard wg0.conf");
  assert.equal(sanitizeAttachmentFilename("C:\\keys\\peer.conf"), "C: keys peer.conf");
  assert.equal(sanitizeAttachmentFilename("../../secret.key"), "secret.key");
  assert.equal(sanitizeAttachmentFilename("bad\u0000\u001bname.conf"), "badname.conf");
});

test("an unusable filename still yields something sendable", () => {
  assert.equal(sanitizeAttachmentFilename(""), "attachment");
  assert.equal(sanitizeAttachmentFilename("..."), "attachment");
  assert.equal(sanitizeAttachmentFilename(undefined as any), "attachment");
  assert.equal(sanitizeAttachmentFilename("a".repeat(400)).length, 120);
});

// ── Building ─────────────────────────────────────────────────────────────────

test("round-trips content exactly, including binary", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
  const stored = buildEmailAttachments([
    { filename: "tunnel.conf", contentType: "text/plain", content: Buffer.from("[Interface]\nPrivateKey = x\n") },
    { filename: "qr.png", contentType: "image/png", content: png },
  ]);
  const loaded = loadJobAttachments({ id: "j1", attachments: stored });
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].content.toString(), "[Interface]\nPrivateKey = x\n");
  assert.equal(loaded[0].contentType, "text/plain");
  assert.deepEqual([...loaded[1].content], [...png], "binary must survive base64 unchanged");
});

test("no attachments is the normal case and costs nothing", () => {
  assert.deepEqual(buildEmailAttachments([]), []);
  assert.deepEqual(loadJobAttachments({ id: "j", attachments: [] }), []);
  assert.deepEqual(loadJobAttachments({ id: "j" }), [], "a job predating the column");
  assert.deepEqual(loadJobAttachments({ id: "j", attachments: null }), []);
});

test("content type defaults to something every mail client can save", () => {
  const [a] = buildEmailAttachments([{ filename: "x.conf", content: Buffer.from("hi") }]);
  assert.equal(a.contentType, "application/octet-stream");
});

// ── Limits, refused at creation ──────────────────────────────────────────────

test("an oversized file is refused with a message a person can act on", () => {
  const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 1);
  assert.throws(
    () => buildEmailAttachments([{ filename: "huge.bin", content: big }]),
    (e: any) => e instanceof EmailAttachmentError && e.code === "attachment_too_large" && /huge\.bin/.test(e.message),
  );
});

test("too many files, and too much in total, are both refused", () => {
  const one = { filename: "a.conf", content: Buffer.from("x") };
  assert.throws(
    () => buildEmailAttachments(Array.from({ length: MAX_ATTACHMENT_COUNT + 1 }, () => one)),
    (e: any) => e.code === "too_many_attachments",
  );
  const threeMb = Buffer.alloc(1024 * 1024 * 2, 7);
  assert.throws(
    () => buildEmailAttachments([
      { filename: "a", content: threeMb },
      { filename: "b", content: threeMb },
      { filename: "c", content: threeMb },
    ]),
    (e: any) => e.code === "attachments_too_large",
  );
});

test("an empty file is refused rather than sent as a 0-byte attachment", () => {
  assert.throws(
    () => buildEmailAttachments([{ filename: "empty.conf", content: Buffer.alloc(0) }]),
    (e: any) => e.code === "empty_attachment",
  );
});

// ── ⛔ A declared attachment that cannot be read must FAIL the send ──────────

test("a corrupt attachment fails the send instead of delivering a bare email", () => {
  // The whole point of these emails is the file. "Here are your connection
  // files" with nothing attached is worse than a retry.
  assert.throws(
    () => loadJobAttachments({ id: "j", attachments: [{ filename: "a.conf", contentType: "text/plain" }] }),
    (e: any) => e.code === "attachment_content_missing",
  );
  assert.throws(
    () => loadJobAttachments({ id: "j", attachments: [{ filename: "a.conf", contentBase64: "" }] }),
    (e: any) => e.code === "attachment_content_missing",
  );
  assert.throws(
    () => loadJobAttachments({ id: "j", attachments: { nope: true } as any }),
    (e: any) => e.code === "attachments_malformed",
  );
});

// ── Queueing ─────────────────────────────────────────────────────────────────

test("queueing validates BEFORE writing the row", async () => {
  let created = false;
  const db = { emailJob: { create: async () => { created = true; return { id: "e1" }; } } };
  await assert.rejects(
    queueEmailWithAttachments(db, {
      tenantId: "t", type: "X", toEmail: "a@b.c", subject: "s", htmlBody: "<p>h</p>", textBody: "h",
      attachments: [{ filename: "huge", content: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }],
    }),
    (e: any) => e.code === "attachment_too_large",
  );
  assert.equal(created, false, "a bad attachment must never leave a job behind to retry at 2am");
});

test("a queued job carries QUEUED status and the encoded files", async () => {
  let data: any = null;
  const db = { emailJob: { create: async (args: any) => { data = args.data; return { id: "e1" }; } } };
  const res = await queueEmailWithAttachments(db, {
    tenantId: "t", type: "REMOTE_ACCESS_FILES", toEmail: "a@b.c", subject: "s",
    htmlBody: "<p>h</p>", textBody: "h",
    attachments: [{ filename: "Loopcom-phone.conf", contentType: "text/plain", content: Buffer.from("[Interface]") }],
  });
  assert.equal(res.id, "e1");
  assert.equal(data.status, "QUEUED");
  assert.equal(data.attachments.length, 1);
  assert.equal(data.attachments[0].filename, "Loopcom-phone.conf");
  assert.deepEqual(loadJobAttachments({ attachments: data.attachments })[0].content.toString(), "[Interface]");
});

// ── ⛔ BOTH send paths must carry attachments (the defect is a CALLER) ────────

test("SendGrid and SMTP both push job attachments into the same list", () => {
  // A unit test of the loader passes straight through a send path that forgot
  // to call it — the existing code comment says as much about voicemail audio.
  // So read the source.
  const src = readFileSync(join(__dirname, "server.ts"), "utf8");
  const hits = src.match(/pdfAttachments\.push\(\.\.\.loadJobAttachments\(job\)\)/g) || [];
  assert.equal(hits.length, 2, "expected the SendGrid path AND the SMTP path to attach job files");
  assert.ok(
    /import \{ loadJobAttachments \} from "\.\/emailAttachments"/.test(src),
    "server.ts must import the loader",
  );
  assert.ok(
    !/loadJobAttachments\(job\)\.catch/.test(src),
    "job attachments must NOT be swallowed — a missing file has to fail the send",
  );
});
