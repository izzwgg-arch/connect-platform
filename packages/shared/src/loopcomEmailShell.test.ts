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

// ─── the footer names the customer's own company ─────────────────────────────
// Izzy, 2026-08-24, looking at a Trust Bookkeepings voicemail email: "where it
// says sent on behalf of your organization, it should say the tenant name."

test("the footer names the tenant when it is given", () => {
  const html = loopcomEmailShell({ ...OPTS, organizationName: "Trust Bookkeepings" });
  assert.ok(
    html.includes("This email was sent on behalf of Trust Bookkeepings."),
    "the footer does not name the tenant",
  );
  assert.ok(!html.includes("on behalf of your organization"), "the generic wording survived");
});

test("without a name the footer keeps the old generic wording — it never guesses", () => {
  for (const organizationName of [undefined, null, "", "   "]) {
    const html = loopcomEmailShell({ ...OPTS, organizationName });
    assert.ok(
      html.includes("This email was sent on behalf of your organization."),
      `blank name (${JSON.stringify(organizationName)}) did not fall back`,
    );
    assert.ok(!/on behalf of\s*\./.test(html), "an empty name rendered as a stub sentence");
  }
});

test("the tenant name is escaped — it is customer-typed text going into HTML", () => {
  const html = loopcomEmailShell({ ...OPTS, organizationName: `A & B <script>alert(1)</script>` });
  assert.ok(!html.includes("<script>"), "a company name injected markup into the email");
  assert.ok(html.includes("A &amp; B &lt;script&gt;"), "company name not escaped");
});

test("GUARD: every builder on this shell passes the tenant through", () => {
  // The renderer is trivially right; the defect that matters is a CALLER that
  // knows the company and forgets to say so, leaving that one email generic.
  for (const [path, expected] of [
    ["../../../apps/api/src/voicemail/voicemailEmailTemplate.ts", "organizationName: input.organizationName"],
    ["../../../apps/agent/src/notify/smsEmail.ts", "organizationName: input.organizationName"],
    ["../../../apps/api/src/userEmailTemplates.ts", "organizationName: input.tenantName"],
  ] as const) {
    const src = stripComments(read(path));
    assert.ok(src.includes(expected), `${path} no longer passes the tenant name to the shell`);
  }
});

test("GUARD: the voicemail sender takes the name from the tenant-scoped extension lookup", () => {
  // ⛔ Whatever names the company must be scoped to the voicemail's OWN tenant.
  // The extension lookup already is; a stray fetch on some other id is how one
  // customer's name lands on another customer's email.
  const sender = stripComments(read("../../../apps/api/src/voicemail/voicemailEmailSender.ts"));
  assert.ok(sender.includes("organizationName: ext.tenantName"), "the voicemail email stopped naming the tenant");
  const runtime = stripComments(read("../../../apps/api/src/voicemail/voicemailEmailRuntime.ts"));
  assert.ok(
    /tenant: \{ select: \{ name: true \} \}/.test(runtime),
    "the extension lookup no longer loads the tenant name",
  );
  assert.ok(runtime.includes("tenantName: ext.tenant?.name ?? null"), "the runtime stopped returning the tenant name");
});
