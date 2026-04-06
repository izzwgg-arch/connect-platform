import { db } from "@connect/db";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

async function main() {
  // Check what ext 103 looks like in the DB
  const ext103 = await db.extension.findFirst({
    where: { extNumber: "103", tenant: { name: { contains: "plus" } } },
    include: { tenant: { select: { name: true } } }
  });
  console.log("=== Extension 103 DB state ===");
  console.log("id:", ext103?.id);
  console.log("pbxUserEmail:", ext103?.pbxUserEmail);
  console.log("ownerUserId:", ext103?.ownerUserId);
  console.log("tenantId:", ext103?.tenantId);

  if (!ext103) return;

  // Try to create the user manually
  if (ext103.pbxUserEmail && !ext103.ownerUserId) {
    console.log("\nAttempting to create user for", ext103.pbxUserEmail);
    try {
      const existing = await db.user.findUnique({ where: { email: ext103.pbxUserEmail } });
      console.log("Existing user:", existing ? `${existing.email} in tenant ${existing.tenantId}` : "none");
      
      if (!existing) {
        const tempPass = randomBytes(24).toString("base64url");
        const hash = await bcrypt.hash(tempPass, 10);
        const u = await db.user.create({
          data: { tenantId: ext103.tenantId, email: ext103.pbxUserEmail, passwordHash: hash, role: "USER" }
        });
        console.log("Created user:", u.id, u.email);
        await db.extension.update({ where: { id: ext103.id }, data: { ownerUserId: u.id } });
        console.log("Extension assigned to user");
      } else if (existing.tenantId === ext103.tenantId) {
        await db.extension.update({ where: { id: ext103.id }, data: { ownerUserId: existing.id } });
        console.log("Extension assigned to existing user");
      } else {
        console.log("User is in different tenant, skipping");
      }
    } catch(e: any) {
      console.log("ERROR:", e.message);
    }
  } else {
    console.log("\nSkip reason: pbxUserEmail=", ext103.pbxUserEmail, "ownerUserId=", ext103.ownerUserId);
  }

  // Verify
  const aplus = await db.tenant.findFirst({ where: { name: { contains: "plus" } } });
  if (aplus) {
    const users = await db.user.findMany({ where: { tenantId: aplus.id } });
    console.log("\nA plus center users now:", users.length);
    for (const u of users) console.log(" -", u.id, u.email);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
