const { db } = require("/app/apps/api/node_modules/@connect/db");
db.$executeRawUnsafe('ALTER TABLE "ConnectCdr" ADD COLUMN IF NOT EXISTS "fromName" TEXT')
  .then(() => { console.log("done"); return db.$disconnect(); })
  .catch(e => { console.error(e.message); process.exit(1); });
