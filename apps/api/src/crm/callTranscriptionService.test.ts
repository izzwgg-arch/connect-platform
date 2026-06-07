import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSummaryResponse } from "./callTranscriptionService";

const serviceSource = readFileSync(join(process.cwd(), "src/crm/callTranscriptionService.ts"), "utf8");
const cdrHookSource = readFileSync(join(process.cwd(), "src/crm/cdrHook.ts"), "utf8");

test("parseSummaryResponse parses strict JSON summary payloads", () => {
  const parsed = parseSummaryResponse(JSON.stringify({
    summary: "Caller wants a quote.",
    actionItems: [{ title: "Send quote", detail: "Email pricing", dueHint: "tomorrow" }],
    sentiment: "positive",
    intent: "pricing",
  }), "gemini-test");

  assert.equal(parsed.summary, "Caller wants a quote.");
  assert.deepEqual(parsed.actionItems, [{ title: "Send quote", detail: "Email pricing", dueHint: "tomorrow" }]);
  assert.equal(parsed.sentiment, "positive");
  assert.equal(parsed.intent, "pricing");
  assert.equal(parsed.modelName, "gemini-test");
});

test("parseSummaryResponse falls back to text summary when JSON is unavailable", () => {
  const parsed = parseSummaryResponse("Plain summary", "gemini-test");
  assert.equal(parsed.summary, "Plain summary");
  assert.deepEqual(parsed.actionItems, []);
});

test("call transcription service gates by tenant CRM settings and CRM contact", () => {
  assert.match(serviceSource, /transcriptionEnabled/);
  assert.match(serviceSource, /tenantId: input\.tenantId/);
  assert.match(serviceSource, /crmMeta:\s*\{\s*isNot:\s*null\s*\}/);
});

test("call transcription service is idempotent by tenant and linkedId", () => {
  assert.match(serviceSource, /tenantId_linkedId/);
  assert.match(serviceSource, /existing\?\.status === "PROCESSING" \|\| existing\?\.status === "COMPLETED"/);
});

test("call transcription service uses Google Cloud without exposing raw PBX paths", () => {
  assert.match(serviceSource, /GOOGLE_CALL_TRANSCRIPTS_BUCKET/);
  assert.match(serviceSource, /longRunningRecognize/);
  assert.match(serviceSource, /VertexAI/);
  assert.doesNotMatch(serviceSource, /recordingPath:\s*speechResult|pbxFilePath:\s*speechResult/);
  assert.doesNotMatch(serviceSource, /data:\s*\{[\s\S]*recordingPath[\s\S]*status:\s*"COMPLETED"/);
});

test("cdr hook enqueues transcription only for enabled recorded CRM calls", () => {
  assert.match(cdrHookSource, /transcriptionEnabled/);
  assert.match(cdrHookSource, /recordingAvailable/);
  assert.match(cdrHookSource, /enqueueAndProcessCallTranscription\(\{ tenantId, contactId, linkedId \}\)/);
});
