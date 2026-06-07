import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..", "..", "..", "..");

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

const crmSmsSource = readSource("apps/api/src/crm/smsRoutes.ts");
const chatSource = readSource("apps/api/src/connectChatRoutes.ts");
const contactWorkspaceSource = readSource("apps/portal/app/(platform)/crm/contacts/[id]/page.tsx");
const smsPanelSource = readSource("apps/portal/components/crm/contact/ContactSmsPanel.tsx");
const chatPageSource = readSource("apps/portal/app/(platform)/chat/page.tsx");
const smsTemplateMigrationSource = readSource("packages/db/prisma/migrations/20260611022000_crm_sms_templates/migration.sql");

test("CRM SMS creates/reuses ConnectChatThread through shared chat helper", () => {
  assert.match(crmSmsSource, /findOrCreateConnectChatSmsThread/);
  assert.match(chatSource, /export async function findOrCreateConnectChatSmsThread/);
  assert.match(chatSource, /db\.connectChatThread\.findUnique\(\{ where: \{ dedupeKey: dk \} \}\)/);
  assert.match(chatSource, /db\.connectChatThread\.create\(/);
});

test("CRM SMS outbound uses Connect Chat send path and appears in main Chat", () => {
  assert.match(crmSmsSource, /sendConnectChatSmsMessage/);
  assert.match(chatSource, /export async function sendConnectChatSmsMessage/);
  assert.match(chatSource, /db\.connectChatMessage\.create\(/);
  assert.match(chatSource, /kind: "CONNECT_CHAT" as const/);
  assert.match(chatSource, /app\.post\("\/chat\/threads\/:threadId\/messages"[\s\S]*sendConnectChatSmsMessage/);
});

test("CRM SMS workspace opens the exact Connect Chat conversation", () => {
  assert.match(smsPanelSource, /Open in Chat/);
  assert.match(contactWorkspaceSource, /apiPost<\{ threadId: string \}>\("\/chat\/threads"/);
  assert.match(contactWorkspaceSource, /type: "sms"/);
  assert.match(contactWorkspaceSource, /externalPhone: selectedPhone/);
  assert.match(contactWorkspaceSource, /router\.push\(`\/chat\?threadId=\$\{encodeURIComponent\(res\.threadId\)\}`\)/);
});

test("Chat page selects direct threadId route after tenant-scoped thread list loads", () => {
  assert.match(chatPageSource, /searchParams\.get\("threadId"\)/);
  assert.match(chatPageSource, /threads\.find\(\(item\) => item\.id === targetThreadId\)/);
  assert.match(chatPageSource, /setActiveThread\(thread\)/);
});

test("CRM SMS panel reads Connect Chat messages, not timeline-only events", () => {
  assert.match(crmSmsSource, /app\.get\("\/crm\/contacts\/:id\/sms"/);
  assert.match(crmSmsSource, /findExistingSmsThreadForPhone/);
  assert.match(crmSmsSource, /db\.connectChatMessage\.findMany/);
  assert.match(crmSmsSource, /outboundConfigured/);
  assert.match(crmSmsSource, /isCrmOutboundSmsConfigured\(user\.tenantId\)/);
  assert.doesNotMatch(crmSmsSource, /crmTimelineEvent\.findMany/);
});

test("CRM SMS workspace avoids raw no-sender-number errors", () => {
  assert.match(contactWorkspaceSource, /if \(smsThreadId\)/);
  assert.match(contactWorkspaceSource, /if \(!smsOutboundConfigured\)/);
  assert.match(contactWorkspaceSource, /formatSmsWorkspaceError/);
  assert.match(contactWorkspaceSource, /active outbound SMS number in Settings/);
  assert.match(smsPanelSource, /outboundConfigured/);
  assert.match(smsPanelSource, /disabled=\{!outboundConfigured \|\| smsSending/);
});

test("CRM SMS templates have a backing migration and safe UI errors", () => {
  assert.match(smsTemplateMigrationSource, /CREATE TABLE IF NOT EXISTS "CrmSmsTemplate"/);
  assert.match(smsTemplateMigrationSource, /"tenantId" TEXT NOT NULL/);
  assert.match(smsTemplateMigrationSource, /"bodyText" TEXT NOT NULL/);
  assert.match(crmSmsSource, /sms_templates_unavailable/);
  assert.match(crmSmsSource, /SMS templates are temporarily unavailable\./);
  assert.match(contactWorkspaceSource, /formatSmsTemplateError/);
  assert.match(smsPanelSource, /No SMS templates yet\./);
  assert.match(smsPanelSource, /crm-contact-sms-template-safe-error/);
});

test("CRM SMS panel renders compact embedded chat primitives", () => {
  assert.match(smsPanelSource, /Conversation with \{contactName\}/);
  assert.match(smsPanelSource, /groupMessagesByDay/);
  assert.match(smsPanelSource, /crm-contact-sms-date-separator/);
  assert.match(smsPanelSource, /crm-contact-sms-template-list/);
  assert.match(smsPanelSource, /Insert/);
});

test("direct provider send is not used by CRM SMS route", () => {
  assert.doesNotMatch(crmSmsSource, /TwilioSmsProvider/);
  assert.doesNotMatch(crmSmsSource, /VoipMsSmsProvider/);
  assert.doesNotMatch(crmSmsSource, /\.sendMessage\(/);
  assert.doesNotMatch(crmSmsSource, /providerCredential\.findUnique/);
});

test("CRM SMS route enforces CRM, contact scope, SMS send permission, and CRM disabled blocks", () => {
  assert.match(crmSmsSource, /requireCrmAccess\(req, reply\)/);
  assert.match(crmSmsSource, /assertCrmContactAllowed\(user, contactId, reply\)/);
  assert.match(crmSmsSource, /canSendSmsUser\(chatUser\)/);
});

test("Chat CRM SMS labels require viewer CRM/contact access and avoid ambiguous linking", () => {
  assert.match(chatSource, /resolveCrmSmsThreadDecoration/);
  assert.match(chatSource, /crmTenantSettings\.findUnique/);
  assert.match(chatSource, /loadCrmUserAccessRole/);
  assert.match(chatSource, /userCanAccessCrmContact/);
  assert.match(chatSource, /accessible\.length > 1/);
  assert.match(chatSource, /crmAmbiguous: true/);
  assert.match(chatSource, /title: t\.type === "SMS" \? \(crmSms\?\.crmContactName \? t\.title : null\) : t\.title/);
});
