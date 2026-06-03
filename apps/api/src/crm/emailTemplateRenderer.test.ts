import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCrmEmailHtmlDocument } from "@connect/shared";
import { resolveCrmSendTemplateBody } from "./emailTemplateRenderer";

const dir = dirname(fileURLToPath(import.meta.url));
const emailRoutesSource = readFileSync(join(dir, "emailRoutes.ts"), "utf8");
const bulkJobSource = readFileSync(join(dir, "../../../worker/src/crmBulkEmailJob.ts"), "utf8");

test("resolveCrmSendTemplateBody: bodyText override preserves saved bodyHtml", () => {
  const result = resolveCrmSendTemplateBody({
    templateBodyText: "Saved plain body",
    templateBodyHtml: "<p>Saved rich body</p>",
    bodyTextOverride: "Edited plain from compose",
  });
  assert.equal(result.bodyText, "Edited plain from compose");
  assert.equal(result.bodyHtml, "<p>Saved rich body</p>");
});

test("resolveCrmSendTemplateBody: explicit bodyHtml override wins", () => {
  const result = resolveCrmSendTemplateBody({
    templateBodyText: "Saved plain",
    templateBodyHtml: "<p>Saved html</p>",
    bodyTextOverride: "Edited plain",
    bodyHtmlOverride: "<p>Explicit html override</p>",
  });
  assert.equal(result.bodyText, "Edited plain");
  assert.equal(result.bodyHtml, "<p>Explicit html override</p>");
});

test("resolveCrmSendTemplateBody: no overrides uses saved template fields", () => {
  const result = resolveCrmSendTemplateBody({
    templateBodyText: "Saved plain",
    templateBodyHtml: "<p>Saved html</p>",
  });
  assert.equal(result.bodyText, "Saved plain");
  assert.equal(result.bodyHtml, "<p>Saved html</p>");
});

test("email send route uses resolveCrmSendTemplateBody instead of nulling bodyHtml on text override", () => {
  const sendBlock = emailRoutesSource.slice(
    emailRoutesSource.indexOf('app.post("/crm/email/send"'),
    emailRoutesSource.indexOf('app.get("/crm/email/merge-fields"'),
  );
  assert.match(sendBlock, /resolveCrmSendTemplateBody\(/);
  assert.doesNotMatch(sendBlock, /hasBodyTextOverride\s*\?\s*null\s*:\s*tpl\.bodyHtml/);
});

test("bulk email worker uses shared renderCrmEmailTemplate for outbound HTML", () => {
  assert.match(bulkJobSource, /import\s*\{\s*renderCrmEmailTemplate\s*\}\s*from\s*"\.\.\/\.\.\/api\/src\/crm\/emailTemplateRenderer"/);
  const processBlock = bulkJobSource.slice(
    bulkJobSource.indexOf("for (const recipient of recipients)"),
    bulkJobSource.indexOf("// Persist running counts periodically"),
  );
  assert.match(processBlock, /await renderCrmEmailTemplate\(/);
  assert.match(processBlock, /bodyHtml:\s*rendered\.html/);
  assert.match(processBlock, /bodyText:\s*rendered\.text/);
  assert.doesNotMatch(processBlock, /plainTextToCrmHtml\(template\.bodyText\)/);
});

test("rendered CRM email HTML includes branding wrapper and plain-text fallback source", () => {
  const html = buildCrmEmailHtmlDocument({
    subject: "Hello",
    previewText: "Preview line",
    contentHtml: "<p>Hi Alex,</p>",
    branding: {
      businessName: "Acme Dental",
      logoUrl: "cid:connect-crm-business-logo",
      address: "123 Main Street",
    },
    signature: {
      senderName: "Jordan Smith",
      senderTitle: "Account Manager",
      companyName: "Acme Dental",
    },
  });
  assert.match(html, /Acme Dental/);
  assert.match(html, /cid:connect-crm-business-logo/);
  assert.match(html, /Jordan Smith/);
  assert.match(html, /Unsubscribe/);
  assert.match(html, /Privacy Policy/);
  assert.match(html, /<p>Hi Alex,<\/p>/);
});
