const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
db.tenant.findMany({
  select: { id: true, name: true, sipWsUrl: true, sipDomain: true, webrtcEnabled: true, webrtcRouteViaSbc: true }
})
  .then((r) => console.log(JSON.stringify(r, null, 2)))
  .catch((e) => console.error(e))
  .finally(() => db.$disconnect());
