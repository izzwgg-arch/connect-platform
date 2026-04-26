// Runs the same Prisma `where` the new /voice/moh/pbx-classes endpoint builds
// for a tenant-scoped request, so we can confirm the admin-PBX-tenant
// (system) classes are now appended for every tenant.
(async () => {
  const dbMod = require("@connect/db");
  const PC = dbMod.PrismaClient || dbMod.default?.PrismaClient || dbMod.default;
  const db = typeof PC === "function" ? new PC() : dbMod.db || dbMod.prisma;
  if (!db) { console.error("cannot construct prisma client"); process.exit(1); }

  const systemClassOr = [
    { pbxTenantId: "1" },
    { tenantSlug: "vitalpbx" },
    { isDefault: true },
  ];

  async function runForSlug(slug) {
    const tenantOr = [
      { tenantSlug: slug },
      { tenantId: null, tenantSlug: null },
    ];
    const rows = await db.pbxMohClass.findMany({
      where: { OR: [...tenantOr, ...systemClassOr], isActive: true },
      orderBy: [{ tenantSlug: "asc" }, { name: "asc" }],
      select: { mohClassName: true, tenantSlug: true, pbxTenantId: true, fileCount: true, isDefault: true },
    });
    console.log(`\n--- tenant vpbx:${slug} (${rows.length} row${rows.length === 1 ? "" : "s"}) ---`);
    for (const r of rows) {
      console.log(`  ${r.mohClassName.padEnd(12)}  tenantSlug=${String(r.tenantSlug ?? "-").padEnd(16)}  pbxTenantId=${String(r.pbxTenantId ?? "-").padEnd(4)}  files=${r.fileCount}  default=${r.isDefault}`);
    }
  }

  for (const slug of ["a_plus_center", "gesheft", "secro_selution", "vitalpbx", "trimpro"]) {
    await runForSlug(slug);
  }

  console.log("\n--- includeAll=1 (super-admin view) ---");
  const all = await db.pbxMohClass.findMany({
    where: { isActive: true },
    orderBy: [{ tenantSlug: "asc" }, { name: "asc" }],
    select: { mohClassName: true, tenantSlug: true, pbxTenantId: true, fileCount: true, isDefault: true },
  });
  for (const r of all) {
    console.log(`  ${r.mohClassName.padEnd(12)}  tenantSlug=${String(r.tenantSlug ?? "-").padEnd(16)}  pbxTenantId=${String(r.pbxTenantId ?? "-").padEnd(4)}  files=${r.fileCount}`);
  }

  await db.$disconnect();
})();
