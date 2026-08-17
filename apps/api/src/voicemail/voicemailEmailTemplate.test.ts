import { strict as assert } from "node:assert";
import test from "node:test";

import {
  formatVoicemailCaller,
  formatVoicemailDuration,
  voicemailEmail,
  type VoicemailEmailTemplateInput,
} from "./voicemailEmailTemplate";

const BASE: VoicemailEmailTemplateInput = {
  voicemailId: "vm_abc123",
  callerName: "WIRELESS CALLER",
  callerNumber: "(845) 537-7994",
  extension: "102",
  extensionName: "Ari Schonbrun",
  durationSec: 39,
  receivedAtLabel: "Sat, Aug 16 at 2:15 PM",
  transcript: null,
  transcriptLanguage: null,
  attachmentName: "voicemail-2026-08-16-1415.mp3",
};

// ─── the settled design ──────────────────────────────────────────────────────

test("there is no listen button — the recording is attached instead", () => {
  const e = voicemailEmail(BASE);
  assert.ok(!/Listen in Loopcom/i.test(e.html), "the button must not come back");
  assert.match(e.html, /The recording is attached to this email/);
  assert.match(e.html, /voicemail-2026-08-16-1415\.mp3/);
  assert.match(e.text, /The recording is attached to this email/);
});

test("the audio marker is embedded so the send door can attach the file", () => {
  assert.match(voicemailEmail(BASE).html, /connect-voicemail:vm_abc123/);
});

// ─── Yiddish is the majority case ────────────────────────────────────────────

test("a Yiddish transcript is rendered right-to-left", () => {
  const e = voicemailEmail({ ...BASE, transcript: "העלא, דאס איז משה.", transcriptLanguage: "yi" });
  assert.match(e.html, /dir="rtl"/);
  assert.match(e.html, /text-align:right/);
});

test("an English transcript is not", () => {
  const e = voicemailEmail({ ...BASE, transcript: "Hello, it's Goldberg.", transcriptLanguage: "en" });
  assert.ok(!/dir="rtl"/.test(e.html));
  assert.match(e.html, /text-align:left/);
});

test("mixed yi-en still reads right-to-left", () => {
  const e = voicemailEmail({ ...BASE, transcript: "העלא hello", transcriptLanguage: "yi-en" });
  assert.match(e.html, /dir="rtl"/);
});

// ─── no transcript is a normal case, not an error ────────────────────────────

test("without a transcript the email still makes sense and leans on the attachment", () => {
  const e = voicemailEmail(BASE);
  assert.match(e.html, /No typed-out version for this one/);
  assert.ok(!/What they said/.test(e.html));
  assert.match(e.text, /No typed-out version/);
});

test("with a transcript the hedge points at the recording as the record", () => {
  const e = voicemailEmail({ ...BASE, transcript: "hello there", transcriptLanguage: "en" });
  assert.match(e.html, /What they said/);
  assert.match(e.html, /it can get words wrong\. The recording attached is the record/);
});

// ─── the caller line ─────────────────────────────────────────────────────────

test("carrier noise is never shown as if it were a person's name", () => {
  assert.equal(formatVoicemailCaller("WIRELESS CALLER", "8455377994"), "8455377994");
  assert.equal(formatVoicemailCaller("Unknown", "8455377994"), "8455377994");
  assert.equal(formatVoicemailCaller("Private", null), "Unknown caller");
});

test("a real name keeps the number beside it, because that is what they call back on", () => {
  assert.equal(formatVoicemailCaller("Moshe Goldberg", "8455377994"), "Moshe Goldberg · 8455377994");
});

test("a number with no name still works", () => {
  assert.equal(formatVoicemailCaller(null, "8455377994"), "8455377994");
});

// ─── duration reads like speech ──────────────────────────────────────────────

test("duration is spoken, not a stopwatch", () => {
  assert.equal(formatVoicemailDuration(1), "1 second");
  assert.equal(formatVoicemailDuration(39), "39 seconds");
  assert.equal(formatVoicemailDuration(60), "1 min");
  assert.equal(formatVoicemailDuration(72), "1 min 12 sec");
  assert.equal(formatVoicemailDuration(270), "4 min 30 sec");
  assert.equal(formatVoicemailDuration(null), "0 seconds");
});

// ─── it is a Loopcom email, hardened like the others ─────────────────────────

test("it carries the Loopcom shell, its Outlook wrapper and no Connect wording", () => {
  const e = voicemailEmail(BASE);
  assert.match(e.html, /<!--\[if mso\]><table[^>]*width="600"/);
  assert.match(e.html, /Loopcom/);
  assert.ok(!/Connect Communications/.test(e.html), "no Connect Communications anywhere");
});

test("a transcript cannot inject markup into the email", () => {
  const e = voicemailEmail({ ...BASE, transcript: '<script>alert(1)</script>', transcriptLanguage: "en" });
  assert.ok(!/<script>/.test(e.html), "transcript must be escaped");
  assert.match(e.html, /&lt;script&gt;/);
});
