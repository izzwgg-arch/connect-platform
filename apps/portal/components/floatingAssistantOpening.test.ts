import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-reading guards. The behaviour that matters here lives in a "use client"
// React component that cannot be imported into node:test, and every defect this
// file protects against has been a CALLER-side omission — a button that stopped
// being rendered, an error read off a field that does not exist — which a unit
// test of a helper passes straight through.
const src = readFileSync(join(__dirname, "FloatingAssistant.tsx"), "utf8");

test("the way to reach a person is always rendered, not only on the opening screen", () => {
  // Someone who has been going back and forth with the assistant for five
  // minutes without getting anywhere is exactly who needs a person. The help
  // bar must not sit inside the `messages.length === 0` branch.
  const helpAt = src.indexOf('className="fa-help"');
  assert.ok(helpAt > 0, "the report button is gone");
  const openingBranch = src.slice(src.indexOf("{messages.length === 0 && ("), src.indexOf('<div ref={bottomRef} />'));
  assert.ok(!openingBranch.includes('className="fa-help"'), "the report button must survive once a conversation starts");
});

test("the report posts to the API, never through the assistant", () => {
  // The whole point of the button is that reaching a person does not depend on
  // a model choosing to pass something along.
  assert.match(src, /apiPost<[^>]*>\(\s*"\/support\/report"/);
  const start = src.indexOf("const fileReport");
  const fileReport = src.slice(start, src.indexOf("[filing, problem, callback, area, urgent, label]);", start));
  assert.ok(!fileReport.includes("agentPost"), "a report must not travel through the agent");
});

test("a failed report shows the server's sentence, read from .body", () => {
  // `.payload` has never existed on ApiError and silently falls through to the
  // bare error code — and this is the one screen a customer reaches when
  // something is already broken.
  assert.match(src, /e instanceof ApiError \? \(e\.body as \{ message\?: string \} \| undefined\) : undefined/);
  assert.doesNotMatch(src, /\.payload\?\./);
  assert.match(src, /845\) 723-1213/, "if we cannot file it, the fallback must give them a number");
});

test("the confirmation only promises a text when the text actually went", () => {
  assert.match(src, /confirmationTexted \? \(/);
  assert.match(src, /We&apos;ll text you back on/);
  assert.match(src, /We&apos;ll be in touch on/);
});

test("the unheard count is fetched as a count, not as a page of voicemail", () => {
  // Asking for a full page here would be the voicemail flood again: 100 rows
  // fetched every time anyone opens the panel.
  assert.match(src, /\/voice\/voicemail\?folder=inbox&pageSize=1/);
  assert.match(src, /unreadTotal/);
});

test("the opening screen greets through the shared helper", () => {
  // Greeting off `user.name` directly prints the email address for anyone
  // without a display name.
  assert.match(src, /assistantGreetingLine/);
  assert.doesNotMatch(src, /Good afternoon, \$\{/, "assemble the line in one place, not inline");
});

test("the areas come from one shared list", () => {
  // A hand-copied list in the portal drifts from the API's enum and the report
  // starts failing validation for one option nobody notices.
  assert.match(src, /SUPPORT_REPORT_AREAS\.map/);
  assert.doesNotMatch(src, /"Voicemail", "Texting"/);
});

test("Suggest a feature sits right beside Report a problem, on every screen", () => {
  // Izzy's ask (2026-08-20): the two doors side by side. Both live in the
  // fa-help-row OUTSIDE the opening branch, so they survive once a
  // conversation starts — same rule as the report button above.
  const rowAt = src.indexOf('className="fa-help-row"');
  assert.ok(rowAt > 0, "the help row is gone");
  const row = src.slice(rowAt, src.indexOf("{pendingFiles.length > 0"));
  assert.match(row, /Report a problem/);
  assert.match(row, /Suggest a feature/);
  const openingBranch = src.slice(src.indexOf("{messages.length === 0 && ("), src.indexOf('<div ref={bottomRef} />'));
  assert.ok(!openingBranch.includes("fa-help-row"), "the two doors must survive once a conversation starts");
});

test("a suggestion posts to the API, never through the assistant", () => {
  // An idea must not depend on a model choosing to pass it along — the API
  // emails it to the product inbox itself.
  assert.match(src, /apiPost<[^>]*>\(\s*"\/support\/feature-suggestion"/);
  const start = src.indexOf("const sendSuggestion");
  assert.ok(start > 0, "the send handler is gone");
  const fn = src.slice(start, src.indexOf("[suggesting, suggestion, label]);", start));
  assert.ok(!fn.includes("agentPost"), "a suggestion must not travel through the agent");
  // and a failed one shows the server's sentence, read from .body (the
  // .payload trap is already pinned file-wide by the doesNotMatch above)
  assert.match(fn, /e\.body as \{ message\?: string \}/);
});

test("the chat widget's stale support language is gone", () => {
  assert.doesNotMatch(src, /Online — here to help/, "reads like a website widget waiting for a live agent");
  assert.doesNotMatch(src, /Viewing with you:/, "the page context moved into the header line");
  assert.doesNotMatch(src, /fa-live/);
});

test("Talk to Laybel adds video to the existing Assistant, not another agent", () => {
  assert.match(src, /<b>Talk to Laybel<\/b>/);
  assert.match(src, /A video call with your Assistant/);
  assert.match(src, /<LaybelVideoCall/);
  assert.match(src, /onTurn=\{text => send\(text, "voice", false\)\}/);
  assert.match(src, /channel: "chat" \| "voice"/);
  assert.match(src, /void send\(r\.text, "voice"\)/, "the existing authenticated transcription feeds the existing send path");
  assert.match(src, /window\.speechSynthesis\.speak\(utterance\)/, "the visible Assistant reply is read through local browser speech");
  assert.doesNotMatch(src, /\/voice-agent\//, "Laybel must not use a separate assistant brain");
});

import { LaybelTurns } from "../lib/laybelTurns";

test("video capture requires explicit consent and cleans up owned media", () => {
  const video = readFileSync(join(process.cwd(), "components/LaybelVideoCall.tsx"), "utf8");
  assert.match(video, /if \(!started\) return/);
  assert.match(video, /disabled=\{!status\?\.available\}/);
  assert.match(video, /Start video call/);
  assert.match(video, /video: false/);
  assert.match(video, /getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
  assert.match(video, /stopStreaming\(\)/);
  assert.match(video, /return \(\) => \{ disposed = true; stop\(\)/);
  assert.match(video, /USER_SPEECH_STARTED/);
  assert.match(video, /MESSAGE_HISTORY_UPDATED/);
});

test("video transcript repeats are processed once and turns remain serial", async () => {
  const events: string[] = [];
  const queue = new LaybelTurns(async text => { events.push(`ask:${text}`); return { reply: text }; }, async text => { events.push(`say:${text}`); }, () => assert.fail("unexpected failure"), () => assert.fail("unexpected takeover"));
  await Promise.all([queue.submit("1", "one"), queue.submit("1", "one"), queue.submit("2", "two")]);
  assert.deepEqual(events, ["ask:one", "say:one", "ask:two", "say:two"]);
});

test("barge-in suppresses obsolete speech without retrying tool-bearing turns", async () => {
  let resolve!: (answer: { reply: string }) => void;
  const said: string[] = [];
  const queue = new LaybelTurns(() => new Promise(done => { resolve = done; }), async text => { said.push(text); }, () => assert.fail(), () => assert.fail());
  const pending = queue.submit("1", "question");
  await Promise.resolve();
  queue.interrupt(); resolve({ reply: "old response" }); await pending;
  assert.deepEqual(said, []);
});

test("ending a call stops late speech and queued turns", async () => {
  let resolve!: (answer: { reply: string }) => void;
  let count = 0;
  const queue = new LaybelTurns(() => { count++; return new Promise(done => { resolve = done; }); }, async () => assert.fail("late audio"), () => assert.fail(), () => assert.fail());
  const first = queue.submit("1", "first");
  const second = queue.submit("2", "second");
  await Promise.resolve(); queue.close(); resolve({ reply: "late" });
  await Promise.all([first, second]);
  assert.equal(count, 1);
});

test("human takeover closes video and assistant failures are not retried", async () => {
  let takeover = 0;
  const queue = new LaybelTurns(async () => ({ reply: "", humanTakeover: true }), async () => assert.fail(), () => assert.fail(), () => { takeover++; });
  await queue.submit("1", "help"); await queue.submit("2", "more");
  assert.equal(takeover, 1);
  let failures = 0; let calls = 0;
  const failed = new LaybelTurns(async () => { calls++; throw new Error("upstream"); }, async () => assert.fail(), () => { failures++; }, () => assert.fail());
  await failed.submit("a", "help"); await failed.submit("a", "help");
  assert.equal(calls, 1); assert.equal(failures, 1);
});
