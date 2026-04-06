import { db } from "@connect/db";
async function main() {
  // What tenants exist and how many users each has?
  const tenants = await db.tenant.findMany({ orderBy: { name: "asc" } });
  console.log("All tenants and user counts:");
  for (const t of tenants) {
    const count = await db.user.count({ where: { tenantId: t.id } });
    console.log(`  ${t.name} (${t.id}): ${count} users`);
  }

  // Check tenant-users endpoint logic: what does it do for tenantId = A plus center?
  const aplusTenant = await db.tenant.findFirst({ where: { name: { contains: "plus" } } });
  if (aplusTenant) {
    console.log("\nDirect query for A plus center users:");
    const users = await db.user.findMany({
      where: { tenantId: aplusTenant.id },
      select: { id: true, email: true, role: true }
    });
    console.log("Count:", users.length);
    for (const u of users) console.log(" -", u.email, u.role);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
