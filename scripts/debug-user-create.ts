import { db } from "@connect/db";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";

async function main() {
  // Check ext 103 in A plus center
  const aplusTenant = await db.tenant.findFirst({ where: { name: { contains: "plus" } } });
  console.log("A plus center tenant:", aplusTenant?.id);
  if (!aplusTenant) return;

  const ext103 = await db.extension.findFirst({
    where: { tenantId: aplusTenant.id, extNumber: "103" },
    include: { ownerUser: { select: { id: true, email: true } } },
  });
  console.log("Ext 103:", ext103?.id, "ownerUserId:", ext103?.ownerUserId, "pbxUserEmail:", ext103?.pbxUserEmail);

  if (!ext103) { console.log("Not found"); return; }

  // Try creating a user
  if (!ext103.pbxUserEmail) {
    console.log("No pbxUserEmail on ext 103 — this is why auto-create skips it");
    return;
  }

  const existing = await db.user.findUnique({ where: { email: ext103.pbxUserEmail } });
  console.log("Existing user for", ext103.pbxUserEmail, ":", existing?.id ?? "none");

  if (!existing) {
    const tempPassword = randomBytes(24).toString("base64url");
    const passwordHash = await bcrypt.hash(tempPassword, 10);
    try {
      const newUser = await db.user.create({
        data: { tenantId: aplusTenant.id, email: ext103.pbxUserEmail, passwordHash, role: "USER" },
      });
      console.log("Created user:", newUser.id, newUser.email);

      // Assign to extension
      await db.extension.update({ where: { id: ext103.id }, data: { ownerUserId: newUser.id } });
      console.log("Assigned ext 103 to", newUser.email);
    } catch (e: any) {
      console.log("Create failed:", e.message);
    }
  } else if (existing.tenantId === aplusTenant.id) {
    console.log("User already in correct tenant, assigning...");
    await db.extension.update({ where: { id: ext103.id }, data: { ownerUserId: existing.id } });
    console.log("Assigned ext 103 to", existing.email);
  } else {
    console.log("User exists in a DIFFERENT tenant:", existing.tenantId, "— skipping");
  }

  // Also show all A plus center extensions and their pbxUserEmail
  const allExts = await db.extension.findMany({
    where: { tenantId: aplusTenant.id },
    select: { extNumber: true, pbxUserEmail: true, ownerUserId: true }
  });
  console.log("\nAll A plus center extensions:");
  for (const e of allExts) {
    console.log(`  ${e.extNumber} | pbxUserEmail: ${e.pbxUserEmail} | ownerUserId: ${e.ownerUserId}`);
  }
}
main().catch(console.error).finally(() => db.$disconnect());
