import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const emailRoutesSource = readFileSync(join(dir, "emailRoutes.ts"), "utf8");
const workerSendSource = readFileSync(resolve(dir, "../../../worker/src/crmEmailSend.ts"), "utf8");
const contactWorkspaceSource = readFileSync(resolve(dir, "../../../portal/components/crm/email/ContactEmailWorkspacePanel.tsx"), "utf8");
const templateLibrarySource = readFileSync(resolve(dir, "../../../portal/app/(platform)/crm/email/templates/page.tsx"), "utf8");

const sendBlock = emailRoutesSource.slice(
  emailRoutesSource.indexOf('app.post("/crm/email/send"'),
  emailRoutesSource.indexOf('app.get("/crm/email/merge-fields"'),
);

test("workspace email send: agents use tenant-first implicit sender without personal Gmail", () => {
  assert.match(emailRoutesSource, /resolveImplicitSenderConnectionOrder/);
  assert.match(emailRoutesSource, /tenant default TENANT connection/);
  assert.match(contactWorkspaceSource, /apiPost<\{ ok: boolean \}>\("\/crm\/email\/send"/);
  assert.doesNotMatch(contactWorkspaceSource, /connectionId:/);
});

test("workspace email send: contact scope and tenant template isolation remain enforced", () => {
  assert.match(sendBlock, /assertCrmContactAllowed/);
  assert.match(sendBlock, /tenantId: user\.tenantId/);
  assert.match(sendBlock, /visibility: "SHARED"/);
  assert.match(sendBlock, /visibility: "PRIVATE", createdByUserId: user\.sub/);
});

test("workspace email send: CC myself only uses logged-in user email", () => {
  assert.match(sendBlock, /ccSelf/);
  assert.match(sendBlock, /db\.user\.findFirst/);
  assert.match(sendBlock, /id: user\.sub, tenantId: user\.tenantId/);
  assert.match(sendBlock, /user email required for ccSelf/);
  assert.doesNotMatch(sendBlock, /ccEmail\s*=\s*String\(body/);
});

test("workspace email send: template attachments and timeline metadata are preserved", () => {
  assert.match(workerSendSource, /loadTemplateAttachments/);
  assert.match(workerSendSource, /templateId: job\.templateId/);
  assert.match(workerSendSource, /ccSelf: Boolean\(job\.ccSelf && job\.ccEmail\)/);
  assert.match(workerSendSource, /senderConnectionId/);
});

test("workspace email send: no fake reply-tracking BCC address is added", () => {
  assert.doesNotMatch(workerSendSource, /^Bcc:/m);
  assert.doesNotMatch(workerSendSource, /tracking.*address/i);
});

test("workspace email panel: templates remain visible when send prerequisites are missing", () => {
  assert.match(contactWorkspaceSource, /sendBlocker/);
  assert.match(contactWorkspaceSource, /No recipient email/);
  assert.match(contactWorkspaceSource, /Connect sender account/);
  assert.doesNotMatch(contactWorkspaceSource, /if \(!contactEmail\)\s*\{\s*return/);
  assert.doesNotMatch(contactWorkspaceSource, /if \(!selectedSender\)\s*\{\s*return/);
});

test("workspace email panel: archived templates stay hidden and merge preview includes contact fields", () => {
  assert.match(contactWorkspaceSource, /!tpl\.isDraft && !tpl\.isArchived/);
  assert.match(contactWorkspaceSource, /contact\.phone/);
  assert.match(contactWorkspaceSource, /contact\.city/);
  assert.match(contactWorkspaceSource, /contact\.state/);
  assert.match(contactWorkspaceSource, /missingMergeFieldWarnings/);
});

test("workspace email panel: template library changes can refresh the workspace without reload", () => {
  assert.match(contactWorkspaceSource, /crm:email-templates:changed/);
  assert.match(contactWorkspaceSource, /crm\.emailTemplates\.changedAt/);
  assert.match(contactWorkspaceSource, /window\.addEventListener\("focus", refresh\)/);
  assert.match(templateLibrarySource, /notifyTemplateWorkspaceRefresh/);
  assert.match(templateLibrarySource, /window\.localStorage\.setItem\(TEMPLATE_REFRESH_STORAGE_KEY/);
});
