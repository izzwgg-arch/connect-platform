/**
 * Source guards for the Coworker's hands on the portal side.
 *
 * The card-era task card (CoworkerTaskCard) stays in the repo for the portal's own
 * corner assistant; since 2026-09-15 the bubble opens the Coworker WORKSPACE, where
 * the computer is reached through the agent's live tools and every "yes" still
 * comes from the desktop's own approval window. These guards pin the parts of that
 * a helper test cannot see.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(__dirname, p), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");

test("the card runs the task the APPROVE route returned and never composes one; the desktop bridge is the only executor", () => {
  const src = code(read("../components/CoworkerTaskCard.tsx"));
  assert.ok(/apiPost<[^>]*>\(`\/coworker\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/approve`/.test(src));
  assert.ok(/b\.runTask\(\{ id: approved\.id, task: approved\.task \}\)/.test(src), "runTask must take the approve response, not local state");
  assert.ok(!/runTask\(\{ id: task\.id, task: task\.task/.test(src));
  assert.ok(/\/coworker\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/result`/.test(src), "the result is reported back");
  assert.ok(!/child_process|node:fs|window\.require|electron/.test(src), "the page touches no filesystem");
});

test("the four questions and the never-rows are on the card", () => {
  const src = read("../components/CoworkerTaskCard.tsx");
  for (const label of ["<dt>What</dt>", "<dt>Where</dt>", "<dt>Why</dt>", "<dt>Undo</dt>"]) assert.ok(src.includes(label), label);
  assert.ok(src.includes("Delete anything"));
  assert.ok(src.includes("Run a program or a command"));
  assert.ok(/never: true/.test(src));
  assert.ok(src.includes('The "Never" rows are not settings'));
});

test("⛔ the workspace never answers an approval itself: a waiting step says where to answer, and there is no approve verb in the page", () => {
  const view = code(read("../components/coworker/CoworkerChatView.tsx"));
  assert.match(view, /Look for the Loopcom approval box on your screen to allow or refuse this\./);
  const all = ["../components/coworker/CoworkerChatView.tsx", "../components/coworker/CoworkerComposer.tsx", "../components/coworker/CoworkerWorkspace.tsx", "../components/coworker/useCoworkerSession.ts", "../components/coworker/coworkerBridge.ts", "../components/coworker/coworkerApi.ts"]
    .map((p) => code(read(p))).join("\n");
  assert.ok(!/coworkerApproval|coworker-approval|approved:\s*true/.test(all), "the hosted page must never be able to answer an approval prompt");
  assert.ok(!/child_process|node:fs|window\.require/.test(all), "the page touches no filesystem");
});

test("⛔ raising access goes only through the desktop bridge (which asks natively); the page has no other way to change it", () => {
  const session = code(read("../components/coworker/useCoworkerSession.ts"));
  assert.match(session, /b\.setAccess\(profile\)/);
  const all = ["../components/coworker/CoworkerComposer.tsx", "../components/coworker/CoworkerWorkspace.tsx", "../components/coworker/useCoworkerSession.ts"].map((p) => code(read(p))).join("\n");
  assert.ok(!/updateSettings\(\{[^}]*coworkerPermissions/.test(all), "no path around the native confirmation");
});
