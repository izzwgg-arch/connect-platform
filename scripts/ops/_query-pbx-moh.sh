#!/usr/bin/env bash
set -uo pipefail
# Decrypts the ombu MySQL URL stored on the active PbxInstance and lists every
# MOH group + per-group file count, so we can see exactly what VitalPBX has vs
# what Connect has synced into PbxMohClass.
docker exec app-api-1 node -e '
(async () => {
  const { PrismaClient } = require("@connect/db");
  const { decryptJson } = require("@connect/security");
  const db = new PrismaClient();
  const inst = await db.pbxInstance.findFirst({ where: { isEnabled: true }, orderBy: { createdAt: "asc" } });
  if (!inst) { console.error("no enabled PbxInstance"); process.exit(1); }
  console.log("PBX:", inst.name, inst.baseUrl);
  if (!inst.ombuMysqlUrlEncrypted) { console.error("no ombuMysqlUrlEncrypted"); process.exit(1); }
  const { mysqlUrl, url } = decryptJson(inst.ombuMysqlUrlEncrypted);
  const u = mysqlUrl || url;
  if (!u) { console.error("decrypted payload missing mysqlUrl"); process.exit(1); }
  const mysql = require("mysql2/promise");
  const conn = await mysql.createConnection(u);

  console.log("\n=== ombu_music_groups (all) ===");
  const [groups] = await conn.query(
    "SELECT music_group_id, tenant_id, name, type, `default` AS is_default FROM ombu_music_groups ORDER BY tenant_id, music_group_id LIMIT 500",
  );
  for (const g of groups) {
    console.log(`  tenant_id=${g.tenant_id}  group_id=${g.music_group_id}  name="${g.name}"  type=${g.type}  default=${g.is_default}`);
  }
  console.log(`(total: ${groups.length})`);

  console.log("\n=== ombu_music_files per group (count) ===");
  const [files] = await conn.query(
    "SELECT music_group_id, COUNT(*) AS n FROM ombu_music_files GROUP BY music_group_id ORDER BY music_group_id",
  );
  for (const f of files) console.log(`  group_id=${f.music_group_id}  files=${f.n}`);

  console.log("\n=== ombu_tenants ===");
  const [tenants] = await conn.query("SELECT tenant_id, name, tenant_code FROM ombu_tenants ORDER BY tenant_id LIMIT 100").catch(() => [[], null]);
  for (const t of tenants) console.log(`  tenant_id=${t.tenant_id}  name="${t.name}"  code="${t.tenant_code}"`);

  await conn.end();
  await db.$disconnect();
})();
' 2>&1
