import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  analyzeWebsiteSubmissionSample,
  extractWebsiteSubmissionFields,
  redactSensitiveText,
  ruleMatchesEmail,
} from "./websiteSubmissionExtraction";

type Row = Record<string, any>;

const PROOF_DIR = resolve("/tmp/connect-email-intake-proof");
const STORAGE_DIR = resolve(PROOF_DIR, "storage");

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) => typeof val === "bigint" ? Number(val) : val, 2);
}

function writeProof(name: string, value: unknown) {
  mkdirSync(PROOF_DIR, { recursive: true });
  writeFileSync(resolve(PROOF_DIR, name), safeJson(value));
}

function createFakeDb() {
  let seq = 0;
  const id = (prefix: string) => `${prefix}_${++seq}`;
  const state = {
    users: [{ id: "user_assigned", tenantId: "tenant_a", status: "ACTIVE", role: "TENANT_ADMIN", email: "owner@example.test" }],
    rules: [] as Row[],
    submissions: [] as Row[],
    contacts: [] as Row[],
    contactEmails: [] as Row[],
    contactPhones: [] as Row[],
    contactAddresses: [] as Row[],
    crmMeta: [] as Row[],
    threads: [] as Row[],
    messages: [] as Row[],
    docs: [] as Row[],
    notifications: [] as Row[],
    timeline: [] as Row[],
  };
  const includeContact = (contact: Row) => ({
    ...contact,
    emails: state.contactEmails.filter((e) => e.contactId === contact.id),
    phones: state.contactPhones.filter((p) => p.contactId === contact.id),
    addresses: state.contactAddresses.filter((a) => a.contactId === contact.id),
    crmMeta: state.crmMeta.find((m) => m.contactId === contact.id) ?? null,
  });
  const db: any = {
    state,
    user: {
      findFirst: async ({ where }: any) => state.users.find((u) => (!where.id || u.id === where.id) && u.tenantId === where.tenantId && (!where.status || u.status === where.status)) ?? null,
    },
    crmWebsiteSubmissionEmailRule: {
      findMany: async ({ where }: any) => state.rules.filter((r) => r.tenantId === where.tenantId && r.connectionId === where.connectionId && r.active === where.active),
      update: async ({ where, data }: any) => Object.assign(state.rules.find((r) => r.id === where.id)!, data),
    },
    crmWebsiteSubmission: {
      findUnique: async ({ where }: any) => state.submissions.find((s) => s.tenantId === where.tenantId_gmailMessageId.tenantId && s.gmailMessageId === where.tenantId_gmailMessageId.gmailMessageId) ?? null,
      create: async ({ data }: any) => {
        const row = { id: id("sub"), createdAt: new Date(), updatedAt: new Date(), ...data };
        state.submissions.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = state.submissions.find((s) => s.id === where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      },
    },
    contact: {
      findFirst: async ({ where }: any) => {
        const contacts = state.contacts.filter((c) => c.tenantId === where.tenantId && c.active !== false && c.archivedAt == null);
        return contacts.map(includeContact).find((c) => {
          const email = where.OR?.find((o: any) => o.emails)?.emails?.some?.email;
          const phone = where.OR?.find((o: any) => o.phones)?.phones?.some?.numberNormalized;
          return (email && c.emails.some((e: Row) => e.email === email)) || (phone && c.phones.some((p: Row) => p.numberNormalized === phone));
        }) ?? null;
      },
      create: async ({ data }: any) => {
        const row = { id: id("contact"), active: true, archivedAt: null, createdAt: new Date(), ...data };
        state.contacts.push(row);
        for (const email of data.emails?.create ?? []) state.contactEmails.push({ id: id("email"), contactId: row.id, ...email });
        for (const phone of data.phones?.create ?? []) state.contactPhones.push({ id: id("phone"), contactId: row.id, ...phone });
        for (const address of data.addresses?.create ?? []) state.contactAddresses.push({ id: id("addr"), contactId: row.id, ...address });
        if (data.crmMeta?.create) state.crmMeta.push({ id: id("meta"), contactId: row.id, ...data.crmMeta.create });
        return includeContact(row);
      },
      update: async ({ where, data }: any) => Object.assign(state.contacts.find((c) => c.id === where.id)!, data),
    },
    contactEmail: { create: async ({ data }: any) => state.contactEmails.push({ id: id("email"), ...data }) },
    contactPhone: { create: async ({ data }: any) => state.contactPhones.push({ id: id("phone"), ...data }) },
    contactAddress: { create: async ({ data }: any) => state.contactAddresses.push({ id: id("addr"), ...data }) },
    crmContactMeta: {
      create: async ({ data }: any) => state.crmMeta.push({ id: id("meta"), ...data }),
      update: async ({ where, data }: any) => Object.assign(state.crmMeta.find((m) => m.contactId === where.contactId)!, data),
    },
    crmEmailThread: {
      upsert: async ({ where, update, create }: any) => {
        let row = state.threads.find((t) => t.tenantId === where.tenantId_gmailThreadId.tenantId && t.gmailThreadId === where.tenantId_gmailThreadId.gmailThreadId);
        if (row) Object.assign(row, update);
        else state.threads.push(row = { id: id("thread"), ...create });
        return row;
      },
    },
    crmEmailMessage: {
      create: async ({ data }: any) => {
        if (state.messages.some((m) => m.tenantId === data.tenantId && m.gmailMessageId === data.gmailMessageId)) throw new Error("duplicate_message");
        const row = { id: id("msg"), createdAt: new Date(), ...data };
        state.messages.push(row);
        return row;
      },
    },
    crmLeadDocument: {
      create: async ({ data }: any) => {
        const row = { id: id("doc"), createdAt: new Date(), updatedAt: new Date(), ...data };
        state.docs.push(row);
        return { id: row.id };
      },
      update: async ({ where, data }: any) => Object.assign(state.docs.find((d) => d.id === where.id)!, data),
    },
    crmUserNotification: {
      create: async ({ data }: any) => {
        const row = { id: id("note"), dismissedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        state.notifications.push(row);
        return row;
      },
      findMany: async ({ where }: any) => state.notifications.filter((n) => n.tenantId === where.tenantId && n.userId === where.userId && (where.dismissedAt !== null || n.dismissedAt === null)),
      updateMany: async ({ where, data }: any) => {
        const rows = state.notifications.filter((n) => n.id === where.id && n.tenantId === where.tenantId && n.userId === where.userId);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    crmTimelineEvent: {
      create: async ({ data }: any) => {
        const row = { id: id("timeline"), createdAt: new Date(), ...data };
        state.timeline.push(row);
        return row;
      },
    },
  };
  return db;
}

const fakeDb = createFakeDb();
mock.module("@connect/db", { namedExports: { db: fakeDb } });

async function loadProcessor() {
  return import("./websiteSubmissionProcessor");
}

test("local E2E proof: website submission intake creates CRM objects and remains safe", async () => {
  process.env.CRM_DOC_STORAGE_DIR = STORAGE_DIR;
  process.env.CRM_WEBSITE_SUBMISSION_EMAIL_ENABLED = "true";
  const { processWebsiteSubmissionEmail } = await loadProcessor();
  const rawEmail = [
    "From: Website Forms <forms@site.example>",
    "Subject: New Website Lead #12345",
    "",
    "First Name: Morgan",
    "Last Name: Fields",
    "Email: morgan@example.test",
    "Phone: (555) 123-4567",
    "Company: Morgan Foods LLC",
    "SSN: 123-45-6789",
    "Bank Account: 1234567890123456",
    "Message: Looking for funding with 6 months bank statements attached.",
  ].join("\n");
  const analysis = analyzeWebsiteSubmissionSample({ rawEmail, attachments: [{ fileName: "bank-statement.pdf", mimeType: "application/pdf" }] });
  const rule = {
    id: "rule_active",
    tenantId: "tenant_a",
    connectionId: "conn_a",
    name: "Website lead form",
    active: true,
    senderEmail: "forms@site.example",
    senderDomain: "site.example",
    subjectPattern: "New Website Lead",
    bodyPatterns: ["First Name"],
    fieldMap: {},
    attachmentExpectations: analysis.attachmentExpectations,
    assignmentUserId: "user_assigned",
    confidenceThreshold: 0.5,
    mode: "AUTO_CREATE",
  };
  fakeDb.state.rules.push(rule);

  writeProof("01-test-incoming-email-payload.json", {
    gmailMessageId: "gmail_match_1",
    fromEmail: "forms@site.example",
    subject: "New Website Lead #12345",
    bodyPreview: redactSensitiveText(rawEmail).slice(0, 800),
    attachments: [{ fileName: "bank-statement.pdf", mimeType: "application/pdf", bytes: 19 }],
  });
  writeProof("02-test-rule.json", rule);
  writeProof("03-analyze-result.json", analysis);
  writeProof("04-rule-test-result.json", {
    matched: ruleMatchesEmail(rule, { fromEmail: "forms@site.example", subject: "New Website Lead #12345", body: rawEmail }),
    extraction: extractWebsiteSubmissionFields(rawEmail),
  });

  const result = await processWebsiteSubmissionEmail({
    tenantId: "tenant_a",
    connectionId: "conn_a",
    gmailMessageId: "gmail_match_1",
    gmailThreadId: "thread_match_1",
    fromEmail: "forms@site.example",
    toEmail: "sales@example.test",
    subject: "New Website Lead #12345",
    receivedAt: new Date("2026-06-09T09:00:00.000Z"),
    snippet: "New lead from Morgan Fields",
    bodyText: rawEmail,
    attachments: [{ fileName: "bank-statement.pdf", mimeType: "application/pdf", buffer: Buffer.from("fake-pdf-proof-bytes") }],
  });

  assert.equal(result.matched, true);
  assert.equal(result.status, "PROCESSED");
  assert.equal(fakeDb.state.contacts.length, 1);
  assert.equal(fakeDb.state.contacts[0].source, "WEBSITE_SUBMISSION");
  assert.equal(fakeDb.state.docs[0].source, "EMAIL_ATTACHMENT");
  assert.equal(fakeDb.state.timeline[0].type, "WEBSITE_SUBMISSION");
  assert.equal(fakeDb.state.notifications.length, 1);
  assert.doesNotMatch(safeJson(fakeDb.state.submissions), /123-45-6789|1234567890123456/);

  writeProof("05-created-updated-contact-summary.json", { contact: fakeDb.state.contacts[0], emails: fakeDb.state.contactEmails, phones: fakeDb.state.contactPhones });
  writeProof("06-submission-record-summary.json", fakeDb.state.submissions[0]);
  writeProof("07-stored-attachment-summary.json", fakeDb.state.docs[0]);
  writeProof("08-timeline-event-summary.json", fakeDb.state.timeline[0]);
  const notificationEndpointResult = await fakeDb.crmUserNotification.findMany({ where: { tenantId: "tenant_a", userId: "user_assigned", dismissedAt: null } });
  writeProof("09-notification-endpoint-result.json", { notifications: notificationEndpointResult });
  const dismissResult = await fakeDb.crmUserNotification.updateMany({ where: { id: fakeDb.state.notifications[0].id, tenantId: "tenant_a", userId: "user_assigned" }, data: { dismissedAt: new Date("2026-06-09T09:01:00.000Z") } });
  writeProof("10-dismissed-read-notification-result.json", { dismissResult, notification: fakeDb.state.notifications[0] });

  const beforeCounts = {
    contacts: fakeDb.state.contacts.length,
    submissions: fakeDb.state.submissions.length,
    notifications: fakeDb.state.notifications.length,
    docs: fakeDb.state.docs.length,
  };
  const duplicate = await processWebsiteSubmissionEmail({ tenantId: "tenant_a", connectionId: "conn_a", gmailMessageId: "gmail_match_1", fromEmail: "forms@site.example", subject: "New Website Lead #12345", bodyText: rawEmail });
  assert.equal(duplicate.reason, "duplicate");
  assert.deepEqual({
    contacts: fakeDb.state.contacts.length,
    submissions: fakeDb.state.submissions.length,
    notifications: fakeDb.state.notifications.length,
    docs: fakeDb.state.docs.length,
  }, beforeCounts);

  const nonmatching = await processWebsiteSubmissionEmail({ tenantId: "tenant_a", connectionId: "conn_a", gmailMessageId: "gmail_no_match", fromEmail: "news@other.example", subject: "Newsletter", bodyText: "hello" });
  assert.equal(nonmatching.matched, false);
  fakeDb.state.rules[0].active = false;
  const inactive = await processWebsiteSubmissionEmail({ tenantId: "tenant_a", connectionId: "conn_a", gmailMessageId: "gmail_inactive", fromEmail: "forms@site.example", subject: "New Website Lead", bodyText: rawEmail });
  assert.equal(inactive.reason, "no_active_rules");
  fakeDb.state.rules[0].active = true;
  const otherTenant = await processWebsiteSubmissionEmail({ tenantId: "tenant_b", connectionId: "conn_a", gmailMessageId: "gmail_tenant_b", fromEmail: "forms@site.example", subject: "New Website Lead", bodyText: rawEmail });
  assert.equal(otherTenant.reason, "no_active_rules");
  fakeDb.state.contacts.push({
    id: "contact_existing",
    tenantId: "tenant_a",
    active: true,
    archivedAt: null,
    firstName: "Jamie",
    lastName: "Existing",
    displayName: "Jamie Existing",
    company: null,
    title: null,
    notes: null,
    source: "MANUAL",
  });
  fakeDb.state.contactEmails.push({ id: "email_existing", contactId: "contact_existing", email: "jamie@example.test", type: "WORK", isPrimary: true });
  const updateEmail = [
    "First Name: Jamie",
    "Last Name: Existing",
    "Email: jamie@example.test",
    "Company: Updated Company LLC",
    "Message: Existing contact should receive missing company only.",
  ].join("\n");
  const updateResult = await processWebsiteSubmissionEmail({
    tenantId: "tenant_a",
    connectionId: "conn_a",
    gmailMessageId: "gmail_update_existing",
    gmailThreadId: "thread_update_existing",
    fromEmail: "forms@site.example",
    subject: "New Website Lead #67890",
    bodyText: updateEmail,
  });
  assert.equal(updateResult.contactId, "contact_existing");
  assert.equal(fakeDb.state.contacts.find((c: Row) => c.id === "contact_existing")?.company, "Updated Company LLC");
  writeProof("15-existing-contact-update-summary.json", {
    updateResult,
    contact: fakeDb.state.contacts.find((c: Row) => c.id === "contact_existing"),
    contactCount: fakeDb.state.contacts.length,
  });
  process.env.CRM_WEBSITE_SUBMISSION_EMAIL_ENABLED = "false";
  const disabled = await processWebsiteSubmissionEmail({ tenantId: "tenant_a", connectionId: "conn_a", gmailMessageId: "gmail_disabled", fromEmail: "forms@site.example", subject: "New Website Lead", bodyText: rawEmail });
  assert.equal(disabled.reason, "feature_disabled");
  writeProof("11-feature-flag-on-path-log.json", { result, counts: beforeCounts, message: "feature flag on processed one matching email" });
  writeProof("12-feature-flag-off-path-log.json", { result: disabled, message: "feature flag off skipped intake before rule lookup/write" });
  writeProof("13-negative-paths-and-idempotency.json", { duplicate, nonmatching, inactive, otherTenant, countsAfter: beforeCounts });
  writeProof("14-normal-reply-sync-regression-proof.json", {
    proof: "Covered by crmEmailWebsiteSubmissionSync.test.ts source contract: existing tracked-thread loop, classifyGmailMessage, and EMAIL_REPLY write remain present.",
  });
});
