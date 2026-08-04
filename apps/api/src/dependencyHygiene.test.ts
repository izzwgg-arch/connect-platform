/**
 * Every package the API imports must be one the API declares.
 *
 * This exists because of a real, outage-shaped near-miss: `pbx/teamBuilder.ts`
 * imported `FormData` from `undici`, which apps/api has never depended on. It
 * was harmless for as long as nothing in the running server reached that file.
 * The moment a route registered it, the container died on boot with
 * `Cannot find module 'undici'`. Blue/green refused to cut over, so customers
 * never saw it — but the deploy was dead and the cause was invisible until
 * someone read the rollout log.
 *
 * Two things that do NOT catch this, and why the check is shaped the way it is:
 *
 *   • `tsc --noEmit` resolves TYPES. A type can come from a transitively
 *     installed package the runtime resolver will never find.
 *   • `require.resolve` from this directory resolves `undici` just fine on a
 *     developer machine, because the local pnpm store hoists it. The container
 *     has a stricter layout. So "can I resolve it here?" is the wrong question;
 *     "did we declare it?" is the right one.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const SRC = __dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));

const DECLARED = new Set([
  ...Object.keys(PKG.dependencies ?? {}),
  ...Object.keys(PKG.devDependencies ?? {}),
  ...Object.keys(PKG.peerDependencies ?? {}),
  ...Object.keys(PKG.optionalDependencies ?? {}),
]);

const BUILTIN = new Set(builtinModules);

/**
 * Imports that predate this check and work today only because a workspace
 * dependency happens to install them. They carry exactly the same latent risk
 * as `undici` did, but they are load-bearing in the running server right now,
 * so fixing them is its own change with its own deploy. Listed rather than
 * ignored so the debt is visible and the list can only shrink.
 */
const GRANDFATHERED = new Set([
  "@prisma/client", // arrives via @connect/db
]);

function packageOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      // Test files are skipped: they import vitest and friends, which the
      // container never loads.
      out.push(full);
    }
  }
  return out;
}

/**
 * Anchored to real import syntax. An earlier, looser version matched any
 * `from "…"` anywhere and flagged prose inside template literals — a check that
 * cries wolf gets deleted, so it has to be exact.
 *
 * Covers: `import x from "p"`, `import "p"`, `export … from "p"`,
 * `await import("p")`, `require("p")`. Dynamic imports count — a lazy import
 * fails just as hard, only later, which is precisely how the undici bug hid.
 */
const PATTERNS = [
  /^\s*import\s+[^"'\n]*from\s*["']([^"']+)["']/gm,
  /^\s*import\s*["']([^"']+)["']/gm,
  /^\s*export\s+[^"'\n]*from\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

describe("the API only imports packages it declares", () => {
  const files = walk(SRC);

  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("has no import of an undeclared package", () => {
    const offenders: string[] = [];

    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      const specs = new Set<string>();
      for (const re of PATTERNS) {
        for (const m of text.matchAll(re)) specs.add(m[1]);
      }
      for (const spec of specs) {
        if (!spec || spec.startsWith(".") || spec.startsWith("/")) continue;
        if (spec.startsWith("node:") || BUILTIN.has(spec)) continue;
        const pkg = packageOf(spec);
        if (DECLARED.has(pkg) || GRANDFATHERED.has(pkg)) continue;
        offenders.push(`${path.relative(SRC, file)} imports "${spec}"`);
      }
    }

    // Named in full rather than counted: the point is that the fix is obvious
    // from the failure message without re-running anything.
    expect(
      offenders,
      `These packages are imported but not declared in apps/api/package.json.\n` +
        `The container will die on boot with "Cannot find module".\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
