import { PrismaClient } from "/app/node_modules/@prisma/client/index.js";
const db = new PrismaClient();
try {
  const n = await db.connectCdr.count({ where: { recordingStatus: "pending" } });
  console.log("PENDING COUNT:", n);
  const fields = Object.keys(db.connectCdr.fields || {});
  console.log("FIELDS:", fields.join(", "));
} catch(e) {
  console.error("ERR:", e.message);
} finally {
  await db.$disconnect();
}
