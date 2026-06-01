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

test("CRM SMS panel reads Connect Chat messages, not timeline-only events", () => {
  assert.match(crmSmsSource, /app\.get\("\/crm\/contacts\/:id\/sms"/);
  assert.match(crmSmsSource, /findExistingSmsThreadForPhone/);
  assert.match(crmSmsSource, /db\.connectChatMessage\.findMany/);
  assert.doesNotMatch(crmSmsSource, /crmTimelineEvent\.findMany/);
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
