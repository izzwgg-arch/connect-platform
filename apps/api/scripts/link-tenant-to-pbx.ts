/**
 * Link a tenant to an enabled PBX instance (by tenant name or id, and instance baseUrl contains).
 * Usage: pnpm exec tsx scripts/link-tenant-to-pbx.ts "Connect Admin 1772999830" "m.connectcomunications.com"
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
  const nameOrId = process.argv[2];
  const urlPart = process.argv[3] || "m.connectcomunications.com";
  if (!nameOrId) {
    console.error("Usage: pnpm exec tsx scripts/link-tenant-to-pbx.ts \"<tenant name or id>\" [instanceBaseUrlContains]");
    process.exit(2);
  }
  loadEnv();

  const tenant = nameOrId.length >= 20 && nameOrId.startsWith("cmm")
    ? await db.tenant.findUnique({ where: { id: nameOrId }, select: { id: true, name: true } })
    : await db.tenant.findFirst({
        where: { name: { contains: nameOrId, mode: "insensitive" } },
        select: { id: true, name: true }
      });
  if (!tenant) {
    console.error("No tenant found:", nameOrId);
    process.exit(1);
  }

  const instance = await db.pbxInstance.findFirst({
    where: { isEnabled: true, baseUrl: { contains: urlPart, mode: "insensitive" } },
    select: { id: true, name: true, baseUrl: true }
  });
  if (!instance) {
    console.error("No enabled PBX instance found with baseUrl containing:", urlPart);
    process.exit(1);
  }

  const existing = await db.tenantPbxLink.findUnique({ where: { tenantId: tenant.id } });
  if (existing) {
    console.log("Tenant already has a PBX link. Updating to this instance.");
    await db.tenantPbxLink.update({
      where: { tenantId: tenant.id },
      data: { pbxInstanceId: instance.id }
    });
  } else {
    await db.tenantPbxLink.create({
      data: { tenantId: tenant.id, pbxInstanceId: instance.id }
    });
  }
  console.log("Linked tenant", tenant.id, tenant.name, "to", instance.name, instance.baseUrl);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
