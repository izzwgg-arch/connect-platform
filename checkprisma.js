const prismaPath = "/app/node_modules/.pnpm/@prisma+client@6.19.2_prisma@6.19.2_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client";
const { PrismaClient } = require(prismaPath);
const db = new PrismaClient();
db.connectCdr.count({ where: { recordingStatus: "pending" } })
  .then(n => { console.log("PENDING COUNT:", n); return db.$disconnect(); })
  .catch(e => { console.error("ERR:", e.message); return db.$disconnect(); });
