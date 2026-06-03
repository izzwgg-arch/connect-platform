import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRichMime, CRM_EMAIL_LOGO_CID, isGoogleAuthRejection } from "./crmEmailSend";

test("CRM email send: rich MIME includes template attachments", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-email-send-"));
  const previous = process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
  process.env.CRM_EMAIL_ASSET_STORAGE_DIR = root;
  try {
    const storageKey = "tenants/tenant-a/templates/template-1/attachment-1.pdf";
    const filePath = path.join(root, storageKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from("pdf-bytes"));

    const mime = await buildRichMime({
      fromHeader: "Sender <sender@example.com>",
      to: "recipient@example.com",
      subject: "Proposal",
      bodyText: "Plain fallback",
      bodyHtml: "<p>HTML body</p>",
      attachments: [{
        id: "attachment-1",
        originalFileName: "proposal.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
        storageKey,
      }],
    });

    assert.match(mime, /multipart\/mixed/);
    assert.match(mime, /Content-Disposition: attachment; filename="proposal.pdf"/);
    assert.match(mime, /Content-Type: application\/pdf; name="proposal.pdf"/);
  } finally {
    if (previous === undefined) delete process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
    else process.env.CRM_EMAIL_ASSET_STORAGE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CRM email send: detects Google auth rejection errors", () => {
  assert.equal(isGoogleAuthRejection("invalid_grant: Token has been expired or revoked."), true);
  assert.equal(isGoogleAuthRejection("Request had invalid authentication credentials. Expected OAuth 2 access token."), true);
  assert.equal(isGoogleAuthRejection("rate_limit_exceeded"), false);
});

test("CRM email send: rich MIME includes CC header when ccSelf is requested", async () => {
  const mime = await buildRichMime({
    fromHeader: "Sender <sender@example.com>",
    to: "recipient@example.com",
    ccEmail: "agent@example.com",
    subject: "Proposal",
    bodyText: "Plain fallback",
    bodyHtml: "<p>HTML body</p>",
    attachments: [],
  });

  assert.match(mime, /^Cc: <agent@example\.com>$/m);
  assert.match(mime, /^To: <recipient@example\.com>$/m);
  assert.match(mime, /^From: Sender <sender@example\.com>$/m);
});

test("CRM email send: rich MIME supports inline CID logo", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-email-logo-"));
  const previous = process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
  process.env.CRM_EMAIL_ASSET_STORAGE_DIR = root;
  try {
    const storageKey = "tenants/tenant-a/branding/branding/logo-1.png";
    const filePath = path.join(root, storageKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from("logo-bytes"));

    const mime = await buildRichMime({
      fromHeader: "Sender <sender@example.com>",
      to: "recipient@example.com",
      subject: "Welcome",
      bodyText: "Plain fallback",
      bodyHtml: `<img src="cid:${CRM_EMAIL_LOGO_CID}" alt="Logo" />`,
      attachments: [{
        id: "branding-logo",
        originalFileName: "logo.png",
        mimeType: "image/png",
        sizeBytes: 10,
        storageKey,
        contentId: CRM_EMAIL_LOGO_CID,
        inline: true,
      }],
    });

    assert.match(mime, new RegExp(`Content-ID: <${CRM_EMAIL_LOGO_CID}>`));
    assert.match(mime, /multipart\/related/);
    assert.match(mime, /Content-Disposition: inline; filename="logo.png"/);
    assert.doesNotMatch(mime, /logoStorageKey|tenants\/tenant-a\/branding/);
  } finally {
    if (previous === undefined) delete process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
    else process.env.CRM_EMAIL_ASSET_STORAGE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CRM email send: missing inline branding logo does not block delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-email-missing-logo-"));
  const previous = process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
  process.env.CRM_EMAIL_ASSET_STORAGE_DIR = root;
  try {
    const mime = await buildRichMime({
      fromHeader: "Sender <sender@example.com>",
      to: "recipient@example.com",
      subject: "Welcome",
      bodyText: "Plain fallback",
      bodyHtml: `<img src="cid:${CRM_EMAIL_LOGO_CID}" alt="Logo" /><p>Hello</p>`,
      attachments: [{
        id: "branding-logo",
        originalFileName: "logo.png",
        mimeType: "image/png",
        sizeBytes: 10,
        storageKey: "tenants/tenant-a/branding/branding/missing-logo.png",
        contentId: CRM_EMAIL_LOGO_CID,
        inline: true,
      }],
    });

    assert.match(mime, /multipart\/mixed/);
    assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
    assert.doesNotMatch(mime, new RegExp(`Content-ID: <${CRM_EMAIL_LOGO_CID}>`));
    assert.doesNotMatch(mime, /Content-Disposition: inline; filename="logo.png"/);
  } finally {
    if (previous === undefined) delete process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
    else process.env.CRM_EMAIL_ASSET_STORAGE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CRM email send: branded HTML keeps multipart text/plain fallback", async () => {
  const { buildCrmEmailHtmlDocument, htmlToCrmPlainText } = await import("@connect/shared");
  const html = buildCrmEmailHtmlDocument({
    subject: "Welcome",
    previewText: "Preview",
    contentHtml: "<p>Hello {{contact.firstName}}</p>",
    branding: { businessName: "Acme", logoUrl: "cid:connect-crm-business-logo", address: "123 Main" },
    signature: { senderName: "Jordan", companyName: "Acme" },
  });
  const text = htmlToCrmPlainText(html);
  const mime = await buildRichMime({
    fromHeader: "Sender <sender@example.com>",
    to: "recipient@example.com",
    subject: "Welcome",
    bodyText: text,
    bodyHtml: html,
    attachments: [],
  });

  assert.match(mime, /multipart\/alternative/);
  assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);

  const htmlPartMatch = mime.match(/Content-Type: text\/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--connect_alt/);
  assert.ok(htmlPartMatch, "expected base64 html part");
  const decodedHtml = Buffer.from(htmlPartMatch![1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(decodedHtml, /Acme/);
  assert.match(decodedHtml, /Unsubscribe/);
  assert.match(decodedHtml, /Jordan/);
  assert.match(decodedHtml, /cid:connect-crm-business-logo/);

  const plainPartMatch = mime.match(/Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--connect_alt/);
  assert.ok(plainPartMatch, "expected base64 plain part");
  const decodedPlain = Buffer.from(plainPartMatch![1].replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.match(decodedPlain, /Acme/);
  assert.match(decodedPlain, /Unsubscribe/);
});
