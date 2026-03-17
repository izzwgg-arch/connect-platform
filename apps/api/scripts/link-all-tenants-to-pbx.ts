/**
 * Link every tenant that has no PBX link to a single enabled PBX instance.
 * Usage: pnpm exec tsx scripts/link-all-tenants-to-pbx.ts [instanceBaseUrlContains]
 * Default instance: m.connectcomunications.com
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
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
  const urlPart = process.argv[2] || "m.connectcomunications.com";
  loadEnv();

  const instance = await db.pbxInstance.findFirst({
    where: { isEnabled: true, baseUrl: { contains: urlPart, mode: "insensitive" } },
    select: { id: true, name: true, baseUrl: true }
  });
  if (!instance) {
    console.error("No enabled PBX instance found with baseUrl containing:", urlPart);
    process.exit(1);
  }

  const linkedTenantIds = new Set(
    (await db.tenantPbxLink.findMany({ select: { tenantId: true } })).map((r) => r.tenantId)
  );
  const allTenants = await db.tenant.findMany({ select: { id: true, name: true } });
  const unlinked = allTenants.filter((t) => !linkedTenantIds.has(t.id));

  if (unlinked.length === 0) {
    console.log("All tenants already have a PBX link.");
    return;
  }

  console.log("Linking", unlinked.length, "tenant(s) to", instance.name, instance.baseUrl);
  for (const tenant of unlinked) {
    await db.tenantPbxLink.create({
      data: { tenantId: tenant.id, pbxInstanceId: instance.id }
    });
    console.log("  ", tenant.id, tenant.name);
  }
  console.log("Done. Linked", unlinked.length, "tenants.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
