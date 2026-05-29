/**
 * Unit tests for CRM email reply sync helpers.
 *
 * Tests cover:
 *  - parseHeader: case-insensitive header lookup
 *  - extractEmail: RFC 5322 address parsing
 *  - classifyGmailMessage: inbound vs outbound vs sent-copy detection
 *
 * Integration behaviour (DB + fetch calls) is covered by typecheck and
 * end-to-end smoke tests; the functions below are the pure decision layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseHeader, extractEmail, classifyGmailMessage } from "./crmEmailSync";

// ── parseHeader ────────────────────────────────────────────────────────────────

test("parseHeader: returns value for matching header (exact case)", () => {
  const headers = [{ name: "Subject", value: "Hello" }];
  assert.equal(parseHeader(headers, "Subject"), "Hello");
});

test("parseHeader: case-insensitive match", () => {
  const headers = [{ name: "SUBJECT", value: "Hello" }];
  assert.equal(parseHeader(headers, "subject"), "Hello");
});

test("parseHeader: returns null when header not present", () => {
  const headers = [{ name: "From", value: "a@b.com" }];
  assert.equal(parseHeader(headers, "Subject"), null);
});

test("parseHeader: returns empty string for blank header value (not null)", () => {
  const headers = [{ name: "Subject", value: "" }];
  assert.equal(parseHeader(headers, "Subject"), "");
});

test("parseHeader: returns null for empty headers array", () => {
  assert.equal(parseHeader([], "From"), null);
});

test("parseHeader: returns first match when multiple with same name", () => {
  const headers = [
    { name: "X-Custom", value: "first" },
    { name: "X-Custom", value: "second" },
  ];
  assert.equal(parseHeader(headers, "X-Custom"), "first");
});

// ── extractEmail ───────────────────────────────────────────────────────────────

test("extractEmail: plain email address returned as-is", () => {
  assert.equal(extractEmail("alice@example.com"), "alice@example.com");
});

test("extractEmail: RFC 5322 angle-bracket form extracts inner address", () => {
  assert.equal(extractEmail("Alice Smith <alice@example.com>"), "alice@example.com");
});

test("extractEmail: angle-bracket form without display name", () => {
  assert.equal(extractEmail("<bob@example.com>"), "bob@example.com");
});

test("extractEmail: null input returns null", () => {
  assert.equal(extractEmail(null), null);
});

test("extractEmail: empty string returns null", () => {
  assert.equal(extractEmail(""), null);
});

test("extractEmail: whitespace-only string returns null", () => {
  assert.equal(extractEmail("   "), null);
});

test("extractEmail: quoted display name with angle brackets", () => {
  assert.equal(extractEmail('"Sales Team" <sales@acme.com>'), "sales@acme.com");
});

// ── classifyGmailMessage ───────────────────────────────────────────────────────

test("classifyGmailMessage: message in INBOX from third party is inbound", () => {
  const result = classifyGmailMessage({
    labelIds: ["INBOX", "CATEGORY_PERSONAL"],
    fromEmail: "customer@example.com",
    senderEmailAddress: "agent@company.com",
  });
  assert.equal(result.inbound, true);
  assert.equal(result.reason, "inbound");
});

test("classifyGmailMessage: message NOT in INBOX is not inbound (e.g. SENT copy)", () => {
  const result = classifyGmailMessage({
    labelIds: ["SENT"],
    fromEmail: "customer@example.com",
    senderEmailAddress: "agent@company.com",
  });
  assert.equal(result.inbound, false);
  assert.equal(result.reason, "not_in_inbox");
});

test("classifyGmailMessage: message in INBOX but from own sender address is not inbound", () => {
  const result = classifyGmailMessage({
    labelIds: ["INBOX"],
    fromEmail: "agent@company.com",
    senderEmailAddress: "agent@company.com",
  });
  assert.equal(result.inbound, false);
  assert.equal(result.reason, "self_sent");
});

test("classifyGmailMessage: self-sender comparison is case-insensitive", () => {
  const result = classifyGmailMessage({
    labelIds: ["INBOX"],
    fromEmail: "AGENT@COMPANY.COM",
    senderEmailAddress: "agent@company.com",
  });
  assert.equal(result.inbound, false);
  assert.equal(result.reason, "self_sent");
});

test("classifyGmailMessage: null fromEmail in INBOX is treated as inbound (unknown sender)", () => {
  // fromEmail may be null if the header is missing; we should not skip — downstream
  // dedup / upsert handles it. isOwnSender requires a truthy fromEmail.
  const result = classifyGmailMessage({
    labelIds: ["INBOX"],
    fromEmail: null,
    senderEmailAddress: "agent@company.com",
  });
  assert.equal(result.inbound, true);
});

test("classifyGmailMessage: empty labelIds array is not inbound", () => {
  const result = classifyGmailMessage({
    labelIds: [],
    fromEmail: "customer@example.com",
    senderEmailAddress: "agent@company.com",
  });
  assert.equal(result.inbound, false);
  assert.equal(result.reason, "not_in_inbox");
});

test("classifyGmailMessage: message with multiple labels including INBOX is inbound", () => {
  const result = classifyGmailMessage({
    labelIds: ["UNREAD", "INBOX", "Label_12345"],
    fromEmail: "lead@prospect.com",
    senderEmailAddress: "crm@company.com",
  });
  assert.equal(result.inbound, true);
});

test("classifyGmailMessage: INBOX label check is exact (not substring)", () => {
  // 'INBOX_UPDATES' should not match 'INBOX'
  const result = classifyGmailMessage({
    labelIds: ["INBOX_UPDATES"],
    fromEmail: "lead@prospect.com",
    senderEmailAddress: "crm@company.com",
  });
  assert.equal(result.inbound, false);
  assert.equal(result.reason, "not_in_inbox");
});
