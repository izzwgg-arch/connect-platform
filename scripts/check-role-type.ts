import { db } from "@connect/db";
async function main() {
  // Check the column type using raw SQL
  const result = await db.$queryRaw<any[]>`
    SELECT column_name, data_type, udt_name 
    FROM information_schema.columns 
    WHERE table_name = 'User' AND column_name = 'role'
  `;
  console.log("User.role column:", JSON.stringify(result));

  // Also check if UserRole enum exists in Postgres
  const enums = await db.$queryRaw<any[]>`
    SELECT typname FROM pg_type WHERE typname = 'UserRole'
  `;
  console.log("UserRole enum in pg_type:", JSON.stringify(enums));

  // Try raw insert to see the actual column type behavior
  try {
    const count = await db.$queryRaw<any[]>`
      SELECT COUNT(*) FROM "User" LIMIT 1
    `;
    console.log("Raw count:", JSON.stringify(count));
  } catch(e: any) { console.log("Raw query error:", e.message); }

  // Try creating user with raw SQL to bypass enum
  const tenantId = "cmnlgnumi0000p9g6l7t1t0z7"; // A plus center
  try {
    const exists = await db.$queryRaw<any[]>`
      SELECT id FROM "User" WHERE email = 'test-jacobw@apluscenterinc.org' LIMIT 1
    `;
    if (exists.length === 0) {
      const id = "test_" + Date.now();
      await db.$executeRaw`
        INSERT INTO "User" (id, "tenantId", email, "passwordHash", role, "createdAt")
        VALUES (${id}, ${tenantId}, 'test-jacobw@apluscenterinc.org', 'testhash', 'USER', NOW())
      `;
      console.log("Raw INSERT succeeded with id:", id);
      // Clean up
      await db.$executeRaw`DELETE FROM "User" WHERE email = 'test-jacobw@apluscenterinc.org'`;
      console.log("Cleaned up test user");
    }
  } catch(e: any) {
    console.log("Raw INSERT error:", e.message);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
