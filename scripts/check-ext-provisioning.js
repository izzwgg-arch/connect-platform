const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient();
db.pbxExtensionLink.findMany({
  where: { extension: { ownerUserId: { not: null } } },
  include: {
    extension: { select: { extNumber: true, ownerUserId: true, displayName: true } },
    tenant: { select: { name: true } },
  },
  take: 20,
}).then(async (rows) => {
  for (const l of rows) {
    const user = l.extension.ownerUserId
      ? await db.user.findUnique({ where: { id: l.extension.ownerUserId }, select: { email: true } })
      : null;
    console.log(JSON.stringify({
      ext: l.extension.extNumber,
      displayName: l.extension.displayName,
      sipUsername: l.pbxSipUsername,
      authUsername: l.pbxDeviceName,
      hasPw: !!l.sipPasswordEncrypted,
      tenantId: l.tenantId,
      tenantName: l.tenant?.name,
      userEmail: user?.email,
    }));
  }
}).finally(() => db.$disconnect());
