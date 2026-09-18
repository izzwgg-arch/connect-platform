/**
 * Control inventory check (brief §47): every `data-testid` in the web source
 * must be catalogued in docs/community/controls.json with its action and
 * expected result, and every catalogued control must still exist in source.
 * Orphans either way fail. Run: pnpm --filter @loopcom/community-api test:controls
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "../..");
const webDir = path.join(root, "apps/community-web");
const inventoryPath = path.join(root, "docs/community/controls.json");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Dynamic ids (`data-testid={`row-${id}`}`) are compared by their static
 * prefix; the inventory writes them as `row-<id>`. Both sides normalise to
 * the prefix so a templated control is still accounted for exactly once.
 */
function normalise(id: string): string {
  const cut = id.search(/[<$]/);
  const base = cut >= 0 ? id.slice(0, cut) : id;
  return base.replace(/-+$/, "").replace(/\s*\(.*\)$/, "").trim();
}

const inSource = new Map<string, string[]>();
for (const file of walk(webDir)) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/data-testid=(?:\{)?["'`]([^"'`]*?)(?:\$\{|["'`])/g)) {
    const id = normalise(m[1]);
    if (!id) continue;
    if (!inSource.has(id)) inSource.set(id, []);
    inSource.get(id)!.push(path.relative(root, file));
  }
  // testId={`prefix-${x}`} / testId="literal" props on Chip/Menu/Button wrappers
  for (const m of src.matchAll(/testId=(?:\{)?["'`]([^"'`]*?)(?:\$\{|["'`])/g)) {
    const id = normalise(m[1]);
    if (!id) continue;
    if (!inSource.has(id)) inSource.set(id, []);
    inSource.get(id)!.push(path.relative(root, file));
  }
}

type Control = { screen: string; component: string; control: string; action: string; expected: string; permissions?: string; api?: string; testId: string };
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as { screens: Array<{ screen: string; controls: Control[] }> | Control[] };
const catalogued = new Map<string, Control>();
const rows: Control[] = Array.isArray(inventory.screens)
  ? inventory.screens.flatMap((s: any) => (Array.isArray(s.controls) ? s.controls.map((c: any) => ({ screen: s.screen, ...c })) : [s]))
  : [];
for (const c of rows) {
  if (!c.testId) continue;
  for (const part of String(c.testId).split(",")) {
    const id = normalise(part);
    if (id) catalogued.set(id, c);
  }
}

const missingFromInventory = [...inSource.keys()].filter((id) => !catalogued.has(id)).sort();
const missingFromSource = [...catalogued.keys()].filter((id) => !inSource.has(id)).sort();
const incomplete = rows.filter((c) => !c.action || !c.expected).map((c) => c.testId);

console.log(`controls in source: ${inSource.size} · catalogued: ${catalogued.size}`);
if (missingFromInventory.length) console.log(`\n✖ ${missingFromInventory.length} data-testid(s) in source but NOT in controls.json:\n  ${missingFromInventory.join("\n  ")}`);
if (missingFromSource.length) console.log(`\n✖ ${missingFromSource.length} catalogued control(s) no longer in source:\n  ${missingFromSource.join("\n  ")}`);
if (incomplete.length) console.log(`\n✖ ${incomplete.length} catalogued control(s) missing action/expected:\n  ${incomplete.join("\n  ")}`);
const ok = !missingFromInventory.length && !missingFromSource.length && !incomplete.length;
console.log(ok ? "\n✔ control inventory complete" : "");
process.exit(ok ? 0 : 1);
