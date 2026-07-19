import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseProvider, Transcriber } from "./transcriber";

const audit = { record: async () => true };

test("provider selection by language + available keys", () => {
  assert.equal(chooseProvider("yi", { openaiApiKey: "x", everettApiKey: "y" }), "everett");
  assert.equal(chooseProvider("yi", { openaiApiKey: "x", everettApiKey: null }), "none");
  assert.equal(chooseProvider("en", { openaiApiKey: "x", everettApiKey: null }), "whisper");
  assert.equal(chooseProvider("auto", { openaiApiKey: "x", everettApiKey: "y" }), "whisper");
  assert.equal(chooseProvider("auto", { openaiApiKey: null, everettApiKey: "y" }), "everett");
  assert.equal(chooseProvider("auto", { openaiApiKey: null, everettApiKey: null }), "none");
});

test("no provider configured → ok:false, no crash, audited", async () => {
  const t = new Transcriber({}, { openaiApiKey: null, everettApiKey: null }, audit);
  const r = await t.transcribe({ recordingId: "rec1", audioRef: "/x.wav", languageHint: "auto" });
  assert.equal(r.ok, false);
  assert.equal(r.provider, "none");
});

test("with a key, provider selected but call is guarded until wired", async () => {
  const t = new Transcriber({}, { openaiApiKey: "sk-x", everettApiKey: null }, audit);
  const r = await t.transcribe({ recordingId: "rec2", audioRef: "/x.wav", languageHint: "en" });
  assert.equal(r.provider, "whisper");
  assert.equal(r.ok, false); // not wired until real key/audio path — never fabricates a transcript
});
