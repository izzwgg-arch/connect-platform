import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const emailRoutesSource = readFileSync(join(dir, "emailRoutes.ts"), "utf8");
const brandingSource = readFileSync(join(dir, "emailTemplateBranding.ts"), "utf8");
const workerSource = readFileSync(join(dir, "../../../worker/src/crmEmailSend.ts"), "utf8");

test("branding logo route is tenant scoped and does not return raw storage key", () => {
  const routeBlock = emailRoutesSource.slice(
    emailRoutesSource.indexOf('app.get("/crm/email/branding/logo"'),
    emailRoutesSource.indexOf('app.put("/crm/email/branding"'),
  );
  assert.match(routeBlock, /requireCrmAccess\(req, reply\)/);
  assert.match(routeBlock, /where:\s*\{\s*tenantId:\s*user\.tenantId\s*\}/);
  assert.doesNotMatch(routeBlock, /return\s+\{\s*logoStorageKey/);
});

test("branding response uses safe preview URL or CID, never raw storage key", () => {
  assert.match(brandingSource, /CRM_EMAIL_LOGO_CID/);
  assert.match(brandingSource, /cid:\$\{CRM_EMAIL_LOGO_CID\}/);
  assert.match(brandingSource, /"\/api\/crm\/email\/branding\/logo"/);
});

test("send worker constrains template attachments by tenant and template", () => {
  const loadBlock = workerSource.slice(
    workerSource.indexOf("async function loadTemplateAttachments"),
    workerSource.indexOf("async function loadInlineLogoAttachment"),
  );
  assert.match(loadBlock, /tenantId:\s*input\.tenantId/);
  assert.match(loadBlock, /where\.templateId\s*=\s*input\.templateId/);
  assert.match(loadBlock, /where\.id\s*=\s*\{\s*in:\s*input\.attachmentIds\s*\}/);
});
