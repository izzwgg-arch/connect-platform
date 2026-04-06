const { db } = require("/app/apps/api/node_modules/@connect/db");
db.$queryRawUnsafe('SELECT "fromName" FROM "ConnectCdr" LIMIT 1')
  .then(r => { console.log("Column exists, rows:", r.length); return db.$disconnect(); })
  .catch(e => { console.error("Error:", e.message); process.exit(1); });
