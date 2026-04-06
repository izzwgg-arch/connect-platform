const { db } = require("/app/node_modules/.pnpm/@connect+db@0.1.0_@prisma+client@6.16.2_prisma@6.16.2__/node_modules/@connect/db/dist/index.js");
async function main() {
  await db.$executeRawUnsafe('ALTER TABLE "ConnectCdr" ADD COLUMN IF NOT EXISTS "fromName" TEXT');
  console.log("Column fromName added (or already existed)");
  await db.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
