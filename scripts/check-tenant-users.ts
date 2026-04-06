import { db } from "@connect/db";
async function main() {
  const tenant = await db.tenant.findFirst({ where: { name: { contains: "plus" } } });
  console.log("Tenant:", tenant?.id, tenant?.name);
  if (!tenant) return;
  
  const users = await db.user.findMany({ where: { tenantId: tenant.id } });
  console.log("Users count:", users.length);
  for (const u of users) {
    console.log(" -", u.id, u.email, u.role);
  }

  // Also check what the tenant-users endpoint would return
  console.log("\nChecking admin users (role ADMIN or SUPER_ADMIN):");
  const admins = await db.user.findMany({ where: { tenantId: tenant.id, role: { in: ["ADMIN", "SUPER_ADMIN", "USER"] } } });
  for (const u of admins) console.log(" -", u.email, u.role);
}
main().catch(console.error).finally(() => db.$disconnect());
