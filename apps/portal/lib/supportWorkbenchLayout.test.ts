/**
 * The Workbench IDE must be told its height.
 *
 * ⛔⛔ Izzy opened it in the Windows app on day one and the screen was
 * "gigantic". The IDE was ported from a mockup where it sat inside a
 * fixed-height frame; in ordinary page flow it had NO height, so every
 * `flex:1` / `min-height:0` inside resolved against CONTENT height — the file
 * tree drew all 222 entries, the editor the whole file, the terminal under
 * that — and nothing scrolled internally.
 *
 * ⛔ This is a SOURCE guard on purpose. The defect is a MISSING rule, so
 * nothing throws, nothing is red, and no unit test of a component can see it.
 * Reads are CRLF-normalised (Izzy's global core.autocrlf=true).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cssPath = join(__dirname, "..", "app", "(platform)", "admin", "support", "workbenchIde.css");
const css = readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n");

/** The `.ide-root { ... }` block, comments stripped so prose can't satisfy a check. */
function ideRootBlock(): string {
  const start = css.indexOf(".ide-root {");
  assert.ok(start >= 0, ".ide-root block not found");
  const end = css.indexOf("\n}", start);
  assert.ok(end > start, ".ide-root block is unterminated");
  return css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the IDE root carries a definite height, or the screen grows to fit its content", () => {
  const block = ideRootBlock();
  assert.match(block, /(^|[;{\s])height\s*:/m, ".ide-root must set a height");
  assert.match(block, /min-height\s*:/, ".ide-root needs a floor for short windows");
});

test("the height is definite — max-height alone does not bound a flex column", () => {
  const block = ideRootBlock();
  const heights = block.match(/(?:^|[;{\s])(max-)?height\s*:/gm) ?? [];
  assert.ok(
    heights.some((h) => !h.includes("max-")),
    "a bare `height` is required; `max-height` alone leaves the inner panes stretching",
  );
});

test("the cap matches what the sibling views on this screen already use", () => {
  const desk = readFileSync(join(__dirname, "..", "app", "(platform)", "admin", "support", "supportDesk.css"), "utf8")
    .replace(/\r\n/g, "\n");
  // Whatever the shared offset is, the IDE must use the SAME one — five views
  // on one screen that disagree about their height read as a broken page.
  const deskCap = desk.match(/calc\(100vh - (\d+)px\)/);
  assert.ok(deskCap, "supportDesk.css no longer caps its views — re-derive this guard");
  assert.ok(
    ideRootBlock().includes(`calc(100vh - ${deskCap[1]}px)`),
    `the IDE should use calc(100vh - ${deskCap[1]}px), matching the other views`,
  );
});

test("the panes inside the body are allowed to shrink, so they scroll instead of overflowing", () => {
  // Grid/flex children default to min-height:auto, which lets a long child push
  // straight past a bounded parent — the bound then does nothing at all.
  assert.match(
    css.replace(/\/\*[\s\S]*?\*\//g, ""),
    /\.ide-body\s*>\s*\*\s*{[^}]*min-height\s*:\s*0/,
    "`.ide-body > *` needs min-height:0",
  );
});
