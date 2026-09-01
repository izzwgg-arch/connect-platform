/**
 * The Support Desk's shape, after the 2026-08-24 redesign.
 * https://claude.ai/code/artifact/6f514701-4e37-4dea-a80f-2366ed600030
 *
 * ⛔ SOURCE guards, because every defect these cover is an absence or a piece
 * of structure: a deleted screen, a missing scope on a fetch, a tab that came
 * back. Nothing throws when one regresses, so no component test can see it.
 *
 * ⛔ Reads are CRLF-normalised — Izzy's checkout is CRLF under a global
 * core.autocrlf=true, and a multi-line LF pattern silently matches nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(__dirname, "..", "app", "(platform)", "admin", "support");
const read = (f: string) => readFileSync(join(DIR, f), "utf8").replace(/\r\n/g, "\n");
/** Comments stripped, so prose explaining a rule can never satisfy that rule. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("⛔⛔ the Inbox is DELETED, not hidden", () => {
  // It browsed every company's private conversations — 679 threads, 2,477
  // messages measured on 2026-08-24 — with no case attached to the reading.
  // A dead-coded screen is one import away from returning.
  assert.equal(existsSync(join(DIR, "SupportInbox.tsx")), false, "SupportInbox.tsx is back");
  const shell = code("page.tsx");
  assert.ok(!shell.includes("SupportInbox"), "the shell still references the Inbox");
});

test("the desk is four tabs, and the work is the first one", () => {
  // "agent" joined 2026-08-31 (727a4d18) — the live view of the automatic
  // support agent. This guard lagged a day behind; the shape it pins now is
  // desk-first with the agent's runs one click away.
  const shell = code("page.tsx");
  const ids = [...shell.matchAll(/\{\s*id:\s*"([a-z]+)"\s*,\s*label:/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["desk", "agent", "workbench", "rules"]);
  assert.match(shell, /useState<View>\("desk"\)/, "the desk must be what opens");
});

test("⛔ a customer's threads can only be fetched WITH the company", () => {
  const c = code("SupportThreads.tsx");
  const fetches = [...c.matchAll(/apiGet<[^>]*>\(\s*`([^`]+)`/g)].map((m) => m[1]);
  const list = fetches.find((f) => f.includes("/admin/support/threads?"));
  assert.ok(list, "the thread list fetch is gone");
  assert.match(String(list), /tenantId=/, "the thread list is fetched without a company — that is the browse surface again");
  assert.match(String(list), /caseRef=/, "the open is not attributed to a case");
});

test("⛔ the threads screen cannot be rendered without a case", () => {
  const c = code("SupportThreads.tsx");
  // Required props, not optional ones: an optional caseRef would let a future
  // caller mount this with nothing to attribute the reading to.
  assert.match(c, /tenantId:\s*string;/, "tenantId is not a required prop");
  assert.match(c, /caseRef:\s*string;/, "caseRef is not a required prop");
  assert.ok(!/caseRef\?:/.test(c), "caseRef became optional — the audit trail is then a guess");
});

test("the screen SAYS the open was recorded, because it was", () => {
  // The sentence is the feature. Same data as the old Inbox; what changed is
  // that the reading now carries a reason a person can be held to.
  assert.match(read("SupportThreads.tsx"), /open was recorded/i);
});

test("⛔ taking over is a button in the composer, never a tab", () => {
  const desk = code("SupportDesk.tsx");
  assert.match(desk, /Take over/, "the take-over control is gone");
  const shell = code("page.tsx");
  assert.ok(!/id:\s*"assistant"/.test(shell), "the Assistant tab came back — 0 take-overs ever went through it");
});

test("⛔ approving a fix still posts to the ONE existing password-gated apply path", () => {
  const desk = code("SupportDesk.tsx");
  assert.match(desk, /admin\/agent-confirmations\/\$\{encodeURIComponent\(actionId\)\}\/apply/);
  // A second apply path is how the two drift; the desk must never grow one.
  assert.ok(!desk.includes("applyConfirmedAction"), "the desk grew its own apply path");
});

test("⛔ the Watchman is in view, not behind a tab", () => {
  const desk = code("SupportDesk.tsx");
  assert.match(desk, /admin\/support\/watchman/, "the desk never asks the Watchman");
  assert.match(desk, /WatchmanStrip/, "the Watchman strip is gone");
  // A probe that cannot answer must READ as unchecked, never as fine.
  assert.match(read("SupportDesk.tsx"), /unchecked|didn.{0,3}t answer/i);
});

test("⛔⛔ the browser's fence is the SERVER's, never this screen's", () => {
  const wb = code("SupportWorkbench.tsx");
  // The screen may not carry its own idea of what is browsable: two opinions
  // drift, and the one that matters is the one on the server.
  assert.ok(!/BROWSABLE_HOSTS\s*=/.test(wb), "the workbench declared its own host allowlist");
  assert.match(wb, /admin\/support\/workbench\/browse\?url=/, "the preview does not go through the server");
});

test("the preview shows BOTH halves — pixels for the person, facts for the agent", () => {
  const wb = code("SupportWorkbench.tsx");
  assert.match(wb, /<iframe/, "there is no preview frame");
  assert.match(wb, /ide-pagefacts/, "what the server read is not shown beside it");
  // The honest limit, stated on screen rather than implied.
  assert.match(read("SupportWorkbench.tsx"), /does NOT screenshot|not screenshot|cannot see/i);
});

test("⛔ every new class the redesign added is actually styled", () => {
  const css = readFileSync(join(DIR, "supportDesk.css"), "utf8").replace(/\r\n/g, "\n");
  for (const cls of ["sd-wstrip", "sd-wstrip-item", "sd-wstrip-tail", "sd-dot", "sd-subhead", "sd-locked", "sd-body-2", "sd-queue-head"]) {
    assert.ok(css.includes("." + cls), `.${cls} is used but never styled`);
  }
  const ide = readFileSync(join(DIR, "workbenchIde.css"), "utf8").replace(/\r\n/g, "\n");
  for (const cls of ["ide-addr", "ide-url", "ide-abtn", "ide-wbtn", "ide-preview", "ide-frame", "ide-pagefacts", "ide-pf-status"]) {
    assert.ok(ide.includes("." + cls), `.${cls} is used but never styled`);
  }
});

test("⛔⛔ every --var the IDE stylesheet uses is DECLARED in it", () => {
  // An invented var() name resolves to nothing, which paints an invisible
  // panel and reads exactly like a failed deploy. This caught a whole block
  // written against an --ide-* namespace that does not exist here.
  const ide = readFileSync(join(DIR, "workbenchIde.css"), "utf8").replace(/\r\n/g, "\n");
  const start = ide.indexOf(".ide-root {");
  const root = ide.slice(start, ide.indexOf("}", start));
  const declared = new Set([...root.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...ide.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !declared.has(v));
  assert.deepEqual(missing, [], `workbenchIde.css uses variables it never declares: ${missing.join(", ")}`);
});
