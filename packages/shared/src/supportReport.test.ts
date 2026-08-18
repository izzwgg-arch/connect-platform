import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORT_REPORT_AREAS,
  buildSupportReportEmail,
  buildSupportReportSms,
  isSupportReportArea,
  supportReportAreaLabel,
  supportReportCustomerSms,
  supportReportReference,
  supportReportSummary,
  type SupportReportInput,
} from "./supportReport";

const base: SupportReportInput = {
  tenantName: "Gesheft",
  userName: "Joel Landau",
  userEmail: "joel@example.com",
  problem: "The phone in the front office stopped ringing this morning. Calls go to voicemail instead.",
  area: "calls",
  urgent: false,
  callbackPhone: "+18457231213",
  page: "Dashboard",
  reference: "AB2C3D",
};

test("the reference drops characters that are misread down a phone line", () => {
  const ref = supportReportReference("cmsl83ilealfdqn1313zni9az");
  assert.equal(ref.length, 6);
  assert.doesNotMatch(ref, /[ILOS150]/, "0/O, 1/I/L and 5/S are the pairs people get wrong out loud");
  assert.match(ref, /^[A-Z0-9]{6}$/);
});

test("a short or empty id still yields a full-width reference", () => {
  assert.equal(supportReportReference("").length, 6);
  assert.equal(supportReportReference("a1").length, 6);
});

test("the owner's text keeps its line breaks", () => {
  const sms = buildSupportReportSms(base);
  assert.ok(sms.includes("\n"), "collapsing the newlines makes this unreadable on a phone");
  assert.equal(sms.split("\n").length, 5);
});

test("urgency leads the text, so a dead phone system cannot read like a billing question", () => {
  const sms = buildSupportReportSms({ ...base, urgent: true });
  assert.ok(sms.startsWith("** PHONES DOWN **"));
  assert.ok(!buildSupportReportSms(base).includes("PHONES DOWN"));
});

test("the text is plain ASCII — an emoji would quadruple the segment count", () => {
  for (const urgent of [false, true]) {
    const sms = buildSupportReportSms({ ...base, urgent });
    // eslint-disable-next-line no-control-regex
    assert.match(sms, /^[\x20-\x7E\n]*$/, "non-ASCII forces UCS-2 encoding: 70 chars per segment, not 160");
  }
});

test("the reference survives however long the customer's message is", () => {
  const sms = buildSupportReportSms({ ...base, problem: "x".repeat(5000) });
  assert.ok(sms.endsWith("Ref AB2C3D"), "the number they will quote back must never be the part that gets clipped");
  assert.ok(sms.includes("Call back: +18457231213"));
  assert.ok(sms.length < 400, `two segments plus slack, got ${sms.length}`);
});

test("a long company or person name cannot push the callback number out", () => {
  const sms = buildSupportReportSms({
    ...base,
    tenantName: "A Very Long Company Name ".repeat(20),
    userName: "Firstname Middlename Lastname ".repeat(20),
  });
  assert.ok(sms.includes("Call back: +18457231213"));
  assert.ok(sms.endsWith("Ref AB2C3D"));
});

test("the email carries what the customer actually typed, unedited", () => {
  const email = buildSupportReportEmail({ ...base, textThreadNote: "Text thread opened." });
  assert.ok(email.includes(base.problem), "no model summarises this — the words are the report");
  assert.ok(email.includes("REPORTED BY THE CUSTOMER"));
  assert.ok(email.includes("Urgency:        Normal"));
  assert.ok(email.includes("Was looking at: Dashboard"));
  assert.ok(email.includes("Text thread opened."));
});

test("the email says plainly when the phones are down", () => {
  const email = buildSupportReportEmail({ ...base, urgent: true, textThreadNote: "" });
  assert.ok(email.includes("PHONES ARE DOWN RIGHT NOW"));
});

test("the email omits the page line rather than printing an empty one", () => {
  const email = buildSupportReportEmail({ ...base, page: null, textThreadNote: "" });
  assert.ok(!email.includes("Was looking at:"));
});

test("the customer's confirmation names the reference and invites a reply", () => {
  const sms = supportReportCustomerSms({ reference: "AB2C3D", urgent: false });
  assert.ok(sms.includes("AB2C3D"));
  assert.ok(/repl(y|ies)/i.test(sms), "the text is what opens the thread — it has to say a reply reaches us");
  assert.ok(sms.length <= 300);
});

test("areas are validated against one list, and unknown ids never crash a screen", () => {
  assert.ok(isSupportReportArea("calls"));
  assert.ok(!isSupportReportArea("phones"));
  assert.ok(!isSupportReportArea(""));
  assert.ok(!isSupportReportArea(undefined));
  assert.equal(supportReportAreaLabel("voicemail"), "Voicemail");
  assert.equal(supportReportAreaLabel("nonsense"), "Something else");
  assert.equal(new Set(SUPPORT_REPORT_AREAS.map((a) => a.id)).size, SUPPORT_REPORT_AREAS.length);
});

test("the one-line summary leads with the urgency, not the area", () => {
  assert.ok(supportReportSummary({ ...base, urgent: true }).startsWith("Phones down"));
  assert.ok(supportReportSummary(base).startsWith("Calls"));
  assert.ok(supportReportSummary({ ...base, problem: "y".repeat(900) }).length <= 240);
});
