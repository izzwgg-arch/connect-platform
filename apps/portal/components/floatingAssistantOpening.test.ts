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

test("the chat widget's stale support language is gone", () => {
  assert.doesNotMatch(src, /Online — here to help/, "reads like a website widget waiting for a live agent");
  assert.doesNotMatch(src, /Viewing with you:/, "the page context moved into the header line");
  assert.doesNotMatch(src, /fa-live/);
});
