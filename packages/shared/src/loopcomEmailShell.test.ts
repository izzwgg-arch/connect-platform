import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loopcomEmailShell, escapeEmailHtml, emailPreheader } from "./loopcomEmailShell";

const OPTS = {
  headerTitle: "Text from Chaim",
  headerSubtitle: "(845) 305-9595",
  body: "<p>hello</p>",
  logoUrl: "https://app.loopcom.net/brand/loopcom/loopcom-wordmark-email-336.png",
  year: 2026,
};

// Source-reading guards: the defects this move exists to prevent are all in the
// CALLERS, so a unit test of the renderer alone passes straight through them.
const read = (p: string) => readFileSync(join(__dirname, p), "utf8").replace(/\r\n/g, "\n");
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

test("renders the Loopcom card: logo, accent rule, title, body, footer", () => {
  const html = loopcomEmailShell(OPTS);
  assert.ok(html.includes(OPTS.logoUrl), "logo missing");
  assert.ok(html.includes('alt="Loopcom"'), "logo alt missing");
  assert.ok(html.includes("Text from Chaim"), "title missing");
  assert.ok(html.includes("<p>hello</p>"), "body missing");
  assert.ok(html.includes("&copy; 2026 Loopcom"), "footer year/brand missing");
});

test("Outlook survival kit is intact — these are load-bearing, not decoration", () => {
  const html = loopcomEmailShell(OPTS);
  assert.ok(html.includes("<!--[if mso]>"), "mso fixed-width wrapper missing");
  assert.ok(html.includes('bgcolor="#ffffff"'), "solid bgcolor behind the card missing");
  assert.ok(html.includes('bgcolor="#22a8ff"'), "solid bgcolor behind the accent gradient missing");
  assert.ok(html.includes('name="color-scheme" content="light"'), "light pin missing");
});

test("the header title and subtitle are escaped", () => {
  const html = loopcomEmailShell({ ...OPTS, headerTitle: `A & B <script>`, headerSubtitle: `x"y` });
  assert.ok(html.includes("A &amp; B &lt;script&gt;"), "title not escaped");
  assert.ok(html.includes(`x&quot;y`), "subtitle not escaped");
  assert.ok(!html.includes("<script>"), "raw script tag leaked into the email");
});

test("the logo URL is escaped — it is interpolated into an attribute", () => {
  const html = loopcomEmailShell({ ...OPTS, logoUrl: `https://x/a.png" onerror="alert(1)` });
  assert.ok(!html.includes(`onerror="alert(1)"`), "logo url broke out of the src attribute");
  assert.ok(html.includes("&quot;"), "logo url not escaped");
});

test("the body is NOT escaped — callers pass rendered HTML", () => {
  const html = loopcomEmailShell({ ...OPTS, body: "<table><tr><td>bubble</td></tr></table>" });
  assert.ok(html.includes("<table><tr><td>bubble</td></tr></table>"), "body was escaped");
});

test("preheader is emitted only when asked for", () => {
  assert.ok(!loopcomEmailShell(OPTS).includes("mso-hide:all"), "preheader emitted unasked");
  assert.ok(loopcomEmailShell({ ...OPTS, preheaderText: "peek" }).includes("mso-hide:all"));
  assert.ok(emailPreheader("a & b").includes("a &amp; b"), "preheader not escaped");
});

test("escapeEmailHtml handles null/undefined without throwing", () => {
  assert.equal(escapeEmailHtml(null), "");
  assert.equal(escapeEmailHtml(undefined), "");
  assert.equal(escapeEmailHtml(`&<>"`), "&amp;&lt;&gt;&quot;");
});

test("GUARD: apps/api keeps resolving its own logo and never takes one as input", () => {
  const src = stripComments(read("../../../apps/api/src/userEmailTemplates.ts"));
  assert.ok(src.includes("loopcomEmailShell({"), "api no longer delegates to the shared shell");
  assert.ok(src.includes("logoUrl: brandLogoUrl()"), "api stopped resolving brandLogoUrl() itself");
  assert.ok(
    !/export function loopComShell[\s\S]{0,400}<!doctype html>/.test(src),
    "apps/api has re-grown a local copy of the shell markup",
  );
});

test("GUARD: apps/agent renders the SHARED shell, not a second copy", () => {
  // ⛔ Case-insensitive, and check the <html>/<body> tags too. A first draft of
  // this guard tested only lowercase "<!doctype html>" and PASSED against the
  // pre-change file, which opened with uppercase "<!DOCTYPE html>" — it guarded
  // nothing. Only the replay-against-HEAD run caught it.
  const ownsAShell = (s: string) =>
    /<!doctype\s+html/i.test(s) || /<html[\s>]/i.test(s) || /<body[\s>]/i.test(s);

  const shell = stripComments(read("../../../apps/agent/src/notify/loopcomShell.ts"));
  assert.ok(shell.includes(`from "@connect/shared"`), "agent wrapper does not use the shared package");
  assert.ok(shell.includes("logoUrl: agentBrandLogoUrl()"), "agent wrapper stopped resolving the logo itself");
  assert.ok(!ownsAShell(shell), "agent wrapper has copied the shell markup");

  const sms = stripComments(read("../../../apps/agent/src/notify/smsEmail.ts"));
  assert.ok(sms.includes("loopcomShellForAgent("), "the SMS email is not on the Loopcom shell");
  assert.ok(!ownsAShell(sms), "the SMS email still carries its own shell");
  assert.ok(!/prefers-color-scheme/.test(sms), "old dark-mode shell left behind in the SMS template");
});

test("GUARD: no email builder accepts a logo URL as an input", () => {
  for (const p of ["../../../apps/agent/src/notify/smsEmail.ts", "../../../apps/api/src/voicemail/voicemailEmailTemplate.ts"]) {
    const src = stripComments(read(p));
    assert.ok(!/logoUrl\??:/.test(src), `${p} takes a logoUrl input — resolve it in the app wrapper instead`);
  }
});
