/**
 * Source guards for the Coworker's hands on the portal side. The defect class
 * here is a CALLER that forgot to mount the card or that mounted it outside the
 * bubble — a unit test of the card's helpers passes straight through both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(__dirname, p), "utf8").replace(/\r\n/g, "\n");
const code = (s: string) => s.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");

test("FloatingAssistant mounts the task cards and the permissions view ONLY when docked, and polls only after a reply / on open", () => {
  const src = code(read("../components/FloatingAssistant.tsx"));
  assert.ok(/usePendingCoworkerTasks\(docked\)/.test(src), "the pending-task hook must be gated on `docked`");
  assert.ok(/\{docked && coworkerTasks\.map\(/.test(src), "cards render only in the docked popover");
  assert.ok(/docked && showCoworkerPerms/.test(src), "permissions view only in the docked popover");
  assert.ok(/void refreshCoworkerTasks\(\);/.test(src), "refresh after each assistant reply");
  assert.ok(!/setInterval\([^)]*refreshCoworkerTasks/.test(src), "never on a timer");
  assert.ok(/\$\{COWORKER_TASK_STYLES\}/.test(src), "the card styles must ship with the panel");
});

test("the card runs the task the APPROVE route returned and never composes one; the desktop bridge is the only executor", () => {
  const src = code(read("../components/CoworkerTaskCard.tsx"));
  assert.ok(/apiPost<[^>]*>\(`\/coworker\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/approve`/.test(src));
  assert.ok(/b\.runTask\(\{ id: approved\.id, task: approved\.task \}\)/.test(src), "runTask must take the approve response, not local state");
  assert.ok(!/runTask\(\{ id: task\.id, task: task\.task/.test(src));
  assert.ok(/\/coworker\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\/result`/.test(src), "the result is reported back");
  assert.ok(!/child_process|node:fs|window\.require|electron/.test(src), "the page touches no filesystem");
});

test("the four questions and the never-rows are on the screen", () => {
  const src = read("../components/CoworkerTaskCard.tsx");
  for (const label of ["<dt>What</dt>", "<dt>Where</dt>", "<dt>Why</dt>", "<dt>Undo</dt>"]) assert.ok(src.includes(label), label);
  assert.ok(src.includes("Delete anything"));
  assert.ok(src.includes("Run a program or a command"));
  assert.ok(/never: true/.test(src));
  assert.ok(src.includes('The "Never" rows are not settings'));
});

test("the desktop coworker page still renders the docked assistant inside AuthGate", () => {
  const src = read("../app/desktop/coworker/page.tsx");
  assert.ok(/<AuthGate>/.test(src) && /<FloatingAssistant docked \/>/.test(src));
});
