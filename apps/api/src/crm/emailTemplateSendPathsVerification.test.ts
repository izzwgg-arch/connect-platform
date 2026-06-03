import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildCrmEmailHtmlDocument,
  renderCrmMergeTemplate,
} from "@connect/shared";
import { CRM_EMAIL_LOGO_CID } from "./emailTemplateBranding";
import {
  renderCrmEmailTemplate,
  resolveCrmSendTemplateBody,
  type CrmEmailTemplateLike,
} from "./emailTemplateRenderer";
import { buildRichMime } from "../../../worker/src/crmEmailSend";

/** Scan rendered outbound email HTML for URLs that external clients (Gmail/Outlook) cannot load. */
export function scanOutgoingEmailHtmlForUnsafeUrls(html: string): string[] {
  const issues: string[] = [];
  if (/src\s*=\s*["']\/(?!\/)/i.test(html)) issues.push('relative src="/…"');
  if (/src\s*=\s*["']\.\//i.test(html)) issues.push('relative src="./…"');
  if (/localhost/i.test(html)) issues.push("localhost");
  if (/127\.0\.0\.1/.test(html)) issues.push("127.0.0.1");
  if (/\/api\/crm\/email\/branding\/logo/i.test(html)) issues.push("auth-only preview logo path");
  return issues;
}

function decodeMimePart(mime: string, contentType: string): string {
  const re = new RegExp(
    `Content-Type: ${contentType.replace("/", "\\/")}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--connect_alt`,
  );
  const match = mime.match(re);
  assert.ok(match, `expected ${contentType} part in MIME`);
  return Buffer.from(match![1].replace(/\r\n/g, ""), "base64").toString("utf8");
}

const FIXTURE_TEMPLATE: CrmEmailTemplateLike = {
  subject: "Hello {{contact.firstName}} from {{business.name}}",
  previewText: "A quick note for {{contact.fullName}}",
  bodyText: "Hi {{contact.firstName}},\n\nThank you for connecting with {{business.name}}.\n\nBest,\n{{sender.name}}",
  bodyHtml:
    "<p>Hi <strong>{{contact.firstName}}</strong>,</p>" +
    "<p>Thank you for connecting with {{business.name}}.</p>" +
    "<p>Your rep is {{crm.assignedAgent}}.</p>" +
    "<p>Best,<br/>{{sender.name}}</p>",
};

const FIXTURE_BRANDING = {
  businessName: "Connect Communications",
  tagline: "Business voice + messaging",
  website: "https://connectcomunications.com",
  phone: "(845) 723-1213",
  email: "hello@connectcomunications.com",
  address: "123 Main Street, New York, NY 10001",
  logoUrl: `cid:${CRM_EMAIL_LOGO_CID}`,
};

const FIXTURE_SIGNATURE = {
  senderName: "Jordan Smith",
  senderTitle: "Account Manager",
  companyName: "Connect Communications",
  phone: "(845) 723-1213",
  email: "jordan.smith@connectcomunications.com",
  website: "https://connectcomunications.com",
  avatarUrl: "https://connectcomunications.com/assets/signature-avatar.png",
};

const FIXTURE_SENDER = {
  emailAddress: "jordan.smith@connectcomunications.com",
  senderName: "Jordan Smith",
  displayName: "Jordan Smith",
};

const FIXTURE_MERGE_VARS = {
  "contact.firstName": "Alex",
  "contact.lastName": "Morgan",
  "contact.fullName": "Alex Morgan",
  "contact.name": "Alex Morgan",
  "contact.email": "alex@example.com",
  "business.name": "Connect Communications",
  "crm.assignedAgent": "Taylor Brooks",
  "sender.name": "Jordan Smith",
  "business.logo": `cid:${CRM_EMAIL_LOGO_CID}`,
};

async function renderSendTestPath() {
  return renderCrmEmailTemplate({
    template: FIXTURE_TEMPLATE,
    tenantId: "tenant-verify",
    userId: "user-verify",
    toEmail: "verify@gmail.com",
    sender: FIXTURE_SENDER,
    branding: FIXTURE_BRANDING,
    signature: FIXTURE_SIGNATURE,
    mergeVars: FIXTURE_MERGE_VARS,
  });
}

async function renderContactWorkspacePath() {
  const resolved = resolveCrmSendTemplateBody({
    templateBodyText: FIXTURE_TEMPLATE.bodyText,
    templateBodyHtml: FIXTURE_TEMPLATE.bodyHtml,
    bodyTextOverride: "Hi Alex,\n\nThank you for connecting with Connect Communications.\n\nBest,\nJordan Smith",
  });
  return renderCrmEmailTemplate({
    template: {
      subject: FIXTURE_TEMPLATE.subject,
      previewText: FIXTURE_TEMPLATE.previewText,
      bodyText: resolved.bodyText,
      bodyHtml: resolved.bodyHtml,
    },
    tenantId: "tenant-verify",
    userId: "user-verify",
    toEmail: "alex@example.com",
    contactId: "contact-verify",
    sender: FIXTURE_SENDER,
    branding: FIXTURE_BRANDING,
    signature: FIXTURE_SIGNATURE,
    mergeVars: {
      ...FIXTURE_MERGE_VARS,
      "contact.firstName": "Alex",
      "contact.fullName": "Alex Morgan",
    },
  });
}

async function renderBulkSendPath() {
  return renderCrmEmailTemplate({
    template: FIXTURE_TEMPLATE,
    tenantId: "tenant-verify",
    userId: "user-verify",
    toEmail: "bulk-recipient@example.com",
    contactId: "contact-bulk",
    sender: FIXTURE_SENDER,
    branding: FIXTURE_BRANDING,
    signature: FIXTURE_SIGNATURE,
    mergeVars: FIXTURE_MERGE_VARS,
  });
}

function assertBrandedEmailContent(label: string, rendered: { html: string; text: string }) {
  const htmlIssues = scanOutgoingEmailHtmlForUnsafeUrls(rendered.html);
  assert.deepEqual(htmlIssues, [], `${label}: unsafe URL patterns in HTML: ${htmlIssues.join(", ")}`);

  assert.match(rendered.html, /cid:connect-crm-business-logo/, `${label}: header CID logo`);
  assert.match(rendered.html, /Connect Communications/, `${label}: business name`);
  assert.match(rendered.html, /Jordan Smith/, `${label}: signature name`);
  assert.match(rendered.html, /signature-avatar\.png/, `${label}: signature avatar https URL`);
  assert.match(rendered.html, /Unsubscribe/, `${label}: unsubscribe link`);
  assert.match(rendered.html, /Privacy Policy/, `${label}: privacy link`);
  assert.match(rendered.html, /123 Main Street/, `${label}: footer address`);
  assert.match(rendered.html, /<p>Hi <strong>Alex<\/strong>/, `${label}: merge field in body`);
  assert.match(rendered.text, /Alex/, `${label}: plain-text fallback includes body`);
  assert.doesNotMatch(rendered.text, /Unsubscribe/, `${label}: plain-text is body-only (no wrapper)`);
}

test("pre-deploy: fixture template includes logo, signature, footer, merge fields", () => {
  const previewHtml = buildCrmEmailHtmlDocument({
    subject: renderCrmMergeTemplate(FIXTURE_TEMPLATE.subject || "", FIXTURE_MERGE_VARS),
    previewText: FIXTURE_TEMPLATE.previewText || "",
    contentHtml: renderCrmMergeTemplate(FIXTURE_TEMPLATE.bodyHtml || "", FIXTURE_MERGE_VARS),
    branding: FIXTURE_BRANDING,
    signature: FIXTURE_SIGNATURE,
  });
  assert.match(previewHtml, /cid:connect-crm-business-logo/);
  assert.match(previewHtml, /Jordan Smith/);
  assert.match(previewHtml, /Unsubscribe/);
  assert.match(previewHtml, /Alex/);
});

test("pre-deploy: Send Test path renders branded multipart-safe HTML", async () => {
  const rendered = await renderSendTestPath();
  assertBrandedEmailContent("Send Test", rendered);
});

test("pre-deploy: Contact Workspace path preserves saved bodyHtml with text-only override", async () => {
  const resolved = resolveCrmSendTemplateBody({
    templateBodyText: FIXTURE_TEMPLATE.bodyText,
    templateBodyHtml: FIXTURE_TEMPLATE.bodyHtml,
    bodyTextOverride: "Edited plain only",
  });
  assert.equal(resolved.bodyHtml, FIXTURE_TEMPLATE.bodyHtml);

  const rendered = await renderContactWorkspacePath();
  assertBrandedEmailContent("Contact Workspace", rendered);
  assert.match(rendered.html, /<strong>Alex<\/strong>/, "Contact Workspace: rich body HTML preserved");
});

test("pre-deploy: Bulk Send path uses shared renderer output", async () => {
  const rendered = await renderBulkSendPath();
  assertBrandedEmailContent("Bulk Send", rendered);
});

test("pre-deploy: all three paths produce matching branded HTML markers", async () => {
  const [sendTest, contact, bulk] = await Promise.all([
    renderSendTestPath(),
    renderContactWorkspacePath(),
    renderBulkSendPath(),
  ]);
  for (const [label, rendered] of [
    ["Send Test", sendTest],
    ["Contact Workspace", contact],
    ["Bulk Send", bulk],
  ] as const) {
    assert.match(rendered.html, /cid:connect-crm-business-logo/, label);
    assert.match(rendered.html, /Unsubscribe/, label);
    assert.match(rendered.html, /Jordan Smith/, label);
    assert.deepEqual(scanOutgoingEmailHtmlForUnsafeUrls(rendered.html), [], label);
  }
});

test("pre-deploy: Gmail Show Original expectations — multipart/alternative with plain + html", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crm-email-verify-logo-"));
  const previous = process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
  process.env.CRM_EMAIL_ASSET_STORAGE_DIR = root;
  try {
    const storageKey = "tenants/tenant-verify/branding/branding/logo.png";
    fs.mkdirSync(path.dirname(path.join(root, storageKey)), { recursive: true });
    fs.writeFileSync(path.join(root, storageKey), Buffer.from("logo-bytes"));

    const rendered = await renderSendTestPath();
    const mime = await buildRichMime({
      fromHeader: "Jordan Smith <jordan.smith@connectcomunications.com>",
      to: "verify@gmail.com",
      subject: rendered.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
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

    assert.match(mime, /multipart\/alternative/);
    assert.match(mime, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(mime, /Content-Type: text\/html; charset=UTF-8/);
    assert.match(mime, /Content-ID: <connect-crm-business-logo>/);
    assert.match(mime, /multipart\/related/);

    const decodedHtml = decodeMimePart(mime, "text/html");
    const decodedPlain = decodeMimePart(mime, "text/plain");
    assert.deepEqual(scanOutgoingEmailHtmlForUnsafeUrls(decodedHtml), []);
    assert.match(decodedHtml, /cid:connect-crm-business-logo/);
    assert.match(decodedHtml, /Unsubscribe/);
    assert.match(decodedPlain, /Alex/);
    assert.doesNotMatch(decodedPlain, /Unsubscribe/);
    assert.doesNotMatch(mime, /localhost|127\.0\.0\.1|src="\/api\//);
  } finally {
    if (previous === undefined) delete process.env.CRM_EMAIL_ASSET_STORAGE_DIR;
    else process.env.CRM_EMAIL_ASSET_STORAGE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pre-deploy: preview logo path must not appear in send-mode branding", () => {
  const sendHtml = buildCrmEmailHtmlDocument({
    subject: "Test",
    contentHtml: "<p>Hi</p>",
    branding: { businessName: "Acme", logoUrl: `cid:${CRM_EMAIL_LOGO_CID}` },
  });
  const previewHtml = buildCrmEmailHtmlDocument({
    subject: "Test",
    contentHtml: "<p>Hi</p>",
    branding: { businessName: "Acme", logoUrl: "/api/crm/email/branding/logo" },
  });
  assert.doesNotMatch(sendHtml, /\/api\/crm\/email\/branding\/logo/);
  assert.match(previewHtml, /\/api\/crm\/email\/branding\/logo/);
});
