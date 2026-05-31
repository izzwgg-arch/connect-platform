import test from "node:test";
import assert from "node:assert/strict";
import {
  CRM_EMAIL_MERGE_FIELDS,
  buildCrmEmailHtmlDocument,
  htmlToCrmPlainText,
  plainTextToCrmHtml,
  renderCrmMergeTemplate,
} from "./crmEmailTemplates";

test("CRM email merge fields include requested groups", () => {
  const groups = new Set(CRM_EMAIL_MERGE_FIELDS.map((field) => field.group));
  assert.ok(groups.has("Contact"));
  assert.ok(groups.has("CRM"));
  assert.ok(groups.has("Business"));
  assert.ok(groups.has("User/Sender"));
});

test("renderCrmMergeTemplate supports legacy and expanded aliases", () => {
  const result = renderCrmMergeTemplate(
    "Hi {{firstName}} {{contact.displayName}} from {{business.name}} {{missing}}",
    {
      "contact.firstName": "Alex",
      "contact.fullName": "Alex Morgan",
      "business.name": "Connect",
    },
  );
  assert.equal(result, "Hi Alex Alex Morgan from Connect ");
});

test("renderCrmMergeTemplate leaves missing merge values empty instead of failing", () => {
  const result = renderCrmMergeTemplate("Hello {{contact.firstName}} {{unknown.value}}", {});
  assert.equal(result, "Hello  ");
});

test("plain/html conversion keeps readable fallback text", () => {
  const html = plainTextToCrmHtml("Hello\nWorld\n\nSecond paragraph");
  assert.match(html, /<p>/);
  assert.equal(htmlToCrmPlainText(html), "Hello\nWorld\nSecond paragraph");
});

test("buildCrmEmailHtmlDocument includes branding and compliance links", () => {
  const html = buildCrmEmailHtmlDocument({
    subject: "Welcome",
    previewText: "Preview",
    contentHtml: "<p>Hello</p>",
    branding: { businessName: "Acme", address: "123 Main" },
  });
  assert.match(html, /Acme/);
  assert.match(html, /Unsubscribe/);
  assert.match(html, /Privacy Policy/);
});

test("buildCrmEmailHtmlDocument can render a safe preview logo without exposing storage keys", () => {
  const html = buildCrmEmailHtmlDocument({
    subject: "Logo",
    previewText: "Preview",
    contentHtml: "<p>Hello</p>",
    branding: { businessName: "Acme", logoUrl: "/api/crm/email/branding/logo" },
  });
  assert.match(html, /\/api\/crm\/email\/branding\/logo/);
  assert.doesNotMatch(html, /logoStorageKey|tenants\/tenant-a/);
});

test("buildCrmEmailHtmlDocument supports CID logos for final sends", () => {
  const html = buildCrmEmailHtmlDocument({
    subject: "Logo",
    previewText: "Preview",
    contentHtml: plainTextToCrmHtml("Simple template"),
    branding: { businessName: "Acme", logoUrl: "cid:connect-crm-business-logo" },
  });
  assert.match(html, /src="cid:connect-crm-business-logo"/);
  assert.match(htmlToCrmPlainText(html), /Simple template/);
});
