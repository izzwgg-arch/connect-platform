/**
 * Find tenant by name (contains) and run PBX diagnostics for it.
 * Usage: pnpm exec tsx scripts/pbx-diagnose-by-tenant-name.ts "Connect Admin 1772999930"
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { execSync } from "child_process";
import { db } from "@connect/db";

function loadEnv(): void {
  const dir = resolve(process.cwd());
  for (const p of [resolve(dir, ".env"), resolve(dir, "../.env")]) {
    if (existsSync(p)) {
      const content = readFileSync(p, "utf8");
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "").trim();
        }
      }
      break;
    }
  }
}

async function main(): Promise<void> {
  const namePart = process.argv[2];
  if (!namePart) {
    console.error("Usage: pnpm exec tsx scripts/pbx-diagnose-by-tenant-name.ts \"<tenant name or part>\"");
    process.exit(2);
  }
  loadEnv();
  const tenant = await db.tenant.findFirst({
    where: { name: { contains: namePart, mode: "insensitive" } },
    select: { id: true, name: true }
  });
  if (!tenant) {
    console.error("No tenant found matching:", namePart);
    process.exit(1);
  }
  console.log("Tenant:", tenant.id, tenant.name);
  console.log("");
  execSync(`pnpm exec tsx scripts/run-pbx-diagnostics.ts ${tenant.id}`, {
    stdio: "inherit",
    cwd: resolve(process.cwd())
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
