import { db } from "@connect/db";
async function main() {
  const migrations = await db.$queryRaw<any[]>`
    SELECT migration_name, finished_at, applied_steps_count, logs
    FROM _prisma_migrations 
    WHERE migration_name LIKE '%user_role%' OR migration_name LIKE '%UserRole%'
    ORDER BY finished_at
  `;
  console.log("UserRole migrations:", JSON.stringify(migrations, null, 2));

  // Also check current state of the enum
  const enumCheck = await db.$queryRaw<any[]>`
    SELECT typname, typtype FROM pg_type WHERE typname = 'UserRole'
  `;
  console.log("UserRole in pg_type:", JSON.stringify(enumCheck));

  // Get all migration names to see if user_roles is there
  const allMigrations = await db.$queryRaw<any[]>`
    SELECT migration_name, finished_at IS NOT NULL as applied
    FROM _prisma_migrations 
    ORDER BY finished_at
  `;
  for (const m of allMigrations) {
    console.log(m.applied ? "✓" : "✗", m.migration_name);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
