const { db } = require("@connect/db");
async function main() {
  await db.$executeRawUnsafe('ALTER TABLE "ConnectCdr" ADD COLUMN IF NOT EXISTS "fromName" TEXT');
  console.log("Column fromName added (or already existed)");
  await db.$disconnect();
}
main().catch(e => { console.error(e.message); process.exit(1); });
