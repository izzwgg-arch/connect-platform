const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
(async () => {
  const links = await db.pbxExtensionLink.findMany({
    where: { extension: { ownerUserId: { not: null } } },
    include: {
      extension: { select: { id: true, extNumber: true, ownerUserId: true, displayName: true, pbxUserEmail: true } },
    },
    take: 20,
  });
  for (const link of links) {
    const user = link.extension.ownerUserId
      ? await db.user.findUnique({ where: { id: link.extension.ownerUserId }, select: { email: true, tenantId: true } })
      : null;
    console.log(JSON.stringify({
      ext: link.extension.extNumber,
      sipUser: link.pbxSipUsername,
      deviceName: link.pbxDeviceName,
      hasSipPw: !!link.sipPasswordEncrypted,
      userId: link.extension.ownerUserId,
      userEmail: user?.email,
      tenantId: user?.tenantId || link.tenantId,
    }));
  }
  await db.$disconnect();
})();
