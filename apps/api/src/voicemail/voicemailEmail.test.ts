import { strict as assert } from "node:assert";
import test from "node:test";

import {
  MIN_VOICEMAIL_SECONDS_FOR_EMAIL,
  decideVoicemailEmail,
  extractVoicemailIdFromEmailBody,
  resolveVoicemailRecipients,
  transcriptIsRtl,
  voicemailEmailMarker,
  type VoicemailEmailInput,
} from "./voicemailEmail";

const OK: VoicemailEmailInput = {
  pbxUserEmail: "orders@gesheftkosher.com",
  vmEmailEnabled: true,
  durationSec: 39,
  hasAudio: true,
};

// ─── the requirement: no path does nothing quietly ───────────────────────────

test("every outcome carries a reason — there is no silent no-op", () => {
  const cases: VoicemailEmailInput[] = [
    OK,
    { ...OK, emailedAt: new Date() },
    { ...OK, vmEmailEnabled: false },
    { ...OK, hasAudio: false },
    { ...OK, durationSec: 1 },
    { ...OK, pbxUserEmail: null },
  ];
  for (const c of cases) {
    const d = decideVoicemailEmail(c);
    if (d.send) assert.ok(d.recipients.length > 0, "a send must name recipients");
    else assert.ok(typeof d.reason === "string" && d.reason.length > 0, "a skip must carry a reason");
  }
});

test("only a missing recipient needs attention — the deliberate skips do not", () => {
  const attention = (i: VoicemailEmailInput) => {
    const d = decideVoicemailEmail(i);
    return d.send ? false : d.needsAttention;
  };
  assert.equal(attention({ ...OK, vmEmailEnabled: false }), false, "switched off is deliberate");
  assert.equal(attention({ ...OK, hasAudio: false }), false, "no recording is deliberate");
  assert.equal(attention({ ...OK, durationSec: 1 }), false, "a hang-up is deliberate");
  assert.equal(attention({ ...OK, emailedAt: new Date() }), false, "already queued is deliberate");
  assert.equal(attention({ ...OK, pbxUserEmail: null }), true, "nobody to send to IS a problem");
});

// ─── rule 3: no recording, no email ──────────────────────────────────────────

test("no audio means no email, whatever else is true", () => {
  const d = decideVoicemailEmail({ ...OK, hasAudio: false });
  assert.equal(d.send, false);
  assert.equal(d.send === false && d.reason, "no_recording");
});

test("a hang-up is not a message", () => {
  assert.equal(decideVoicemailEmail({ ...OK, durationSec: 0 }).send, false);
  assert.equal(decideVoicemailEmail({ ...OK, durationSec: 1 }).send, false);
  assert.equal(decideVoicemailEmail({ ...OK, durationSec: MIN_VOICEMAIL_SECONDS_FOR_EMAIL }).send, true);
});

test("never sent twice", () => {
  const d = decideVoicemailEmail({ ...OK, emailedAt: new Date("2026-08-16T10:00:00Z") });
  assert.equal(d.send === false && d.reason, "already_queued");
});

// ─── rule 2: recipients ──────────────────────────────────────────────────────

test("the PBX address is used, and it comes first", () => {
  const r = resolveVoicemailRecipients({
    pbxUserEmail: "orders@gesheftkosher.com",
    extraRecipients: ["boss@gesheftkosher.com"],
  });
  assert.deepEqual(r, ["orders@gesheftkosher.com", "boss@gesheftkosher.com"]);
});

test("admins can add any number of addresses", () => {
  const r = resolveVoicemailRecipients({
    pbxUserEmail: "a@x.com",
    extraRecipients: ["b@x.com", "c@x.com", "d@x.com"],
  });
  assert.equal(r.length, 4);
});

test("duplicates and casing collapse, so nobody is emailed twice", () => {
  const r = resolveVoicemailRecipients({
    pbxUserEmail: "Orders@Gesheft.com",
    extraRecipients: ["orders@gesheft.com", "  ORDERS@GESHEFT.COM  "],
  });
  assert.deepEqual(r, ["orders@gesheft.com"]);
});

test("rubbish addresses are dropped, not sent to", () => {
  const r = resolveVoicemailRecipients({
    pbxUserEmail: "not-an-email",
    extraRecipients: ["", null, undefined, "@nope.com", "trailing@", "has space@x.com", "good@x.com"],
  });
  assert.deepEqual(r, ["good@x.com"]);
});

test("an extension with no address is reported, never silently skipped", () => {
  const d = decideVoicemailEmail({ ...OK, pbxUserEmail: null, extraRecipients: [] });
  assert.equal(d.send, false);
  assert.equal(d.send === false && d.reason, "no_recipient");
  assert.equal(d.send === false && d.needsAttention, true);
});

test("an admin address alone is enough when the PBX has none", () => {
  const d = decideVoicemailEmail({ ...OK, pbxUserEmail: null, extraRecipients: ["admin@x.com"] });
  assert.equal(d.send, true);
  assert.deepEqual(d.send === true && d.recipients, ["admin@x.com"]);
});

// ─── Yiddish ─────────────────────────────────────────────────────────────────

test("Yiddish transcripts are right-to-left, English is not", () => {
  assert.equal(transcriptIsRtl("yi"), true);
  assert.equal(transcriptIsRtl("yi-en"), true);
  assert.equal(transcriptIsRtl("YI"), true);
  assert.equal(transcriptIsRtl("en"), false);
  assert.equal(transcriptIsRtl(null), false);
  assert.equal(transcriptIsRtl(""), false);
});

// ─── the attachment marker ───────────────────────────────────────────────────

test("the audio marker survives a round trip through the email body", () => {
  const body = `<p>hello</p>${voicemailEmailMarker("vm_abc123")}<p>bye</p>`;
  assert.equal(extractVoicemailIdFromEmailBody(body), "vm_abc123");
});

test("a body with no marker yields null rather than a wrong id", () => {
  assert.equal(extractVoicemailIdFromEmailBody("<p>nothing here</p>"), null);
  assert.equal(extractVoicemailIdFromEmailBody(null), null);
});
