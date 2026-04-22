// Test using the exact same Prisma client that @connect/db uses
const prismaPath = "/app/node_modules/.pnpm/@prisma+client@6.19.2_prisma@6.19.2_typescript@5.9.3__typescript@5.9.3/node_modules/@prisma/client/default.js";
const { PrismaClient } = require(prismaPath);
const db = new PrismaClient();
Promise.all([
  db.connectCdr.count({ where: { recordingStatus: "pending" } }),
  db.callRecording.count(),
])
  .then(([pending, recordings]) => {
    console.log("PENDING:", pending, "RECORDINGS:", recordings);
    return db.$disconnect();
  })
  .catch(e => { console.error("ERR:", e.message); return db.$disconnect(); });
