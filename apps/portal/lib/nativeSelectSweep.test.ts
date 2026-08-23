/**
 * Native-<select> sweep guard (2026-08-23, Izzy's platform-wide mandate):
 * every dropdown in the portal — present AND future — must be the modern
 * Connect-themed ConnectSelect / ConnectMultiSelect
 * (components/ConnectSelect.tsx), never a native <select>.
 *
 * This test walks the portal source and fails on any `<select` in executable
 * TSX. It reads SOURCE on purpose: a behavioural test of any one screen
 * cannot see a stray native dropdown added to another screen next month.
 *
 * Comment handling: only comment-shaped LINES are dropped (trimmed line
 * starting with //, *, /* or {/*). A full block-comment stripper is
 * deliberately NOT used — this repo has been burned by strippers opening a
 * fake comment at a regex literal and swallowing real code, which for a
 * negative assertion like this one would produce a false PASS.
 */
import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PORTAL_ROOT = join(__dirname, "..");
const SCAN_DIRS = ["app", "components", "lib", "navigation", "hooks", "services"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build"]);

function readNormalised(p: string): string {
  return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

function walkTsx(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTsx(full, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("{/*")
  );
}

test("no native <select> anywhere in the portal — dropdowns are ConnectSelect", () => {
  const offenders: string[] = [];
  for (const scanDir of SCAN_DIRS) {
    for (const file of walkTsx(join(PORTAL_ROOT, scanDir))) {
      const lines = readNormalised(file).split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (/<select[\s>/]/.test(line) || /<select$/.test(line.trimEnd())) {
          offenders.push(`${relative(PORTAL_ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Native <select> found — use ConnectSelect / ConnectMultiSelect (components/ConnectSelect.tsx) instead:\n${offenders.join("\n")}`,
  );
});

test("ConnectSelect exports both the single and multi dropdown", () => {
  const src = readNormalised(join(PORTAL_ROOT, "components", "ConnectSelect.tsx"));
  assert.ok(src.includes("export function ConnectSelect("), "ConnectSelect export missing");
  assert.ok(src.includes("export function ConnectMultiSelect("), "ConnectMultiSelect export missing");
  // The hidden-input bridge is what lets FormData-read forms (Cardknox,
  // billing config forms) use ConnectSelect — losing it silently breaks them.
  assert.ok(src.includes('type="hidden"'), "hidden-input name bridge missing from ConnectSelect");
});
