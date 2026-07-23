import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const USER_EMAIL = "imwog@gmail.com";
const SIP_DOMAIN = "m.connectcomunications.com";

// A few sample desk extensions. The first one is assigned to the logged-in user
// so the WebRTC softphone reports "extension assigned" / browser-ready.
const EXTENSIONS = [
  { extNumber: "1001", displayName: "Front Desk", assignToUser: true },
  { extNumber: "1002", displayName: "Sales" },
  { extNumber: "1003", displayName: "Support" },
];

try {
  const user = await db.user.findFirst({
    where: { email: USER_EMAIL },
    select: { id: true, tenantId: true },
  });
  if (!user) throw new Error(`User ${USER_EMAIL} not found — seed the tenant/user first.`);
  const tenantId = user.tenantId;

  await db.tenant.update({
    where: { id: tenantId },
    data: { webrtcEnabled: true, sipDomain: SIP_DOMAIN },
  });
  console.log(`Tenant ${tenantId}: WebRTC enabled, sipDomain=${SIP_DOMAIN}`);

  for (const ext of EXTENSIONS) {
    const extension = await db.extension.upsert({
      where: { tenantId_extNumber: { tenantId, extNumber: ext.extNumber } },
      create: {
        tenantId,
        extNumber: ext.extNumber,
        displayName: ext.displayName,
        status: "ACTIVE",
        billable: true,
        ownerUserId: ext.assignToUser ? user.id : null,
        pbxUserEmail: ext.assignToUser ? USER_EMAIL : null,
      },
      update: {
        displayName: ext.displayName,
        status: "ACTIVE",
        billable: true,
        ...(ext.assignToUser ? { ownerUserId: user.id, pbxUserEmail: USER_EMAIL } : {}),
      },
    });

    await db.pbxExtensionLink.upsert({
      where: { extensionId: extension.id },
      create: {
        tenantId,
        extensionId: extension.id,
        pbxExtensionId: ext.extNumber,
        pbxSipUsername: ext.extNumber,
        webrtcEnabled: true,
        isSuspended: false,
        provisionStatus: "PENDING",
      },
      update: {
        pbxExtensionId: ext.extNumber,
        pbxSipUsername: ext.extNumber,
        webrtcEnabled: true,
        isSuspended: false,
      },
    });

    console.log(`  Extension ${ext.extNumber} (${ext.displayName})${ext.assignToUser ? " → assigned to " + USER_EMAIL : ""}`);
  }

  console.log("PBX local seed complete.");
} finally {
  await db.$disconnect();
}
