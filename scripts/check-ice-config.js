const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const tenants = await db.tenant.findMany({
    where: { pbxTenantId: { not: null } },
    select: { id: true, name: true, sipDomain: true, sipWsUrl: true, iceServers: true, webrtcEnabled: true },
  });
  console.log("=== PBX-linked Tenants ===");
  for (const t of tenants) {
    console.log(JSON.stringify(t, null, 2));
  }
  await db.$disconnect();
})();
