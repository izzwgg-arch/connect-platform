/**
 * The escalation report parser behind the support desk's detail view.
 * The format is model-written, so the tests lean on the ugly cases: missing
 * headings (degraded reports), duplicated headings, preamble text, and the
 * optional NOT CHECKED section from the evidence rule.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEscalationReport, fixStatusLabel } from "./escalationReport";

const FULL = [
  "Escalation for Gesheft.",
  "ISSUE: Voicemails from ext 112 stopped emailing on Aug 17.",
  "FINDINGS: [E1] no VoicemailEmailRecipient row for 112.",
  "[E2] last VOICEMAIL_NOTIFICATION 2026-08-17 21:25Z.",
  "PROPOSED FIX: Add Orders@gesheftkosher.com for ext 112.",
  "NOT CHECKED: whether a second address is expected.",
  "APPROVAL: reply FIX 123456.",
].join("\n");

test("a full report splits into its five sections plus preamble", () => {
  const r = parseEscalationReport(FULL);
  assert.equal(r.hasSections, true);
  assert.equal(r.preamble, "Escalation for Gesheft.");
  assert.ok(r.issue.startsWith("Voicemails from ext 112"));
  assert.ok(r.findings.includes("[E2]"));
  assert.ok(r.proposedFix.includes("Orders@gesheftkosher.com"));
  assert.ok(r.notChecked.includes("second address"));
  assert.ok(r.approval.includes("FIX 123456"));
});

test("⛔ a degraded report with no headings keeps everything in raw, hasSections false", () => {
  const r = parseEscalationReport("my phones are all dead please help");
  assert.equal(r.hasSections, false);
  assert.equal(r.raw, "my phones are all dead please help");
  assert.equal(r.issue, "");
});

test("a duplicated heading keeps the first occurrence's body", () => {
  const r = parseEscalationReport("ISSUE: the real issue\nISSUE: a restatement\nAPPROVAL: ok");
  assert.equal(r.issue, "the real issue");
  assert.equal(r.approval, "ok");
});

test("headings are matched case-insensitively and with stray spaces", () => {
  const r = parseEscalationReport("issue :   lowercase heading\nProposed Fix:  do the thing");
  assert.equal(r.hasSections, true);
  assert.equal(r.issue, "lowercase heading");
  assert.equal(r.proposedFix, "do the thing");
});

test("null/empty input parses to an empty, section-less report", () => {
  const r = parseEscalationReport("");
  assert.equal(r.hasSections, false);
  assert.equal(r.raw, "");
});

test("fixStatusLabel wording", () => {
  assert.equal(fixStatusLabel("offered", true), "Fix ready");
  assert.equal(fixStatusLabel("applied", true), "Fix applied");
  assert.equal(fixStatusLabel(null, true), "Fix drafted");
  assert.equal(fixStatusLabel(null, false), null);
});
