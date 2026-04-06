import { db } from "@connect/db";
import bcrypt from "bcryptjs";

const EMAIL = "jacobw@apluscenterinc.org";
const TEMP_PASSWORD = "Connect2026!Jacob";

async function main() {
  const passwordHash = await bcrypt.hash(TEMP_PASSWORD, 10);
  const updated = await db.user.update({
    where: { email: EMAIL },
    data: { passwordHash },
    select: { id: true, email: true, tenantId: true, role: true },
  });
  console.log("Password updated for:", updated.email);
  console.log("Tenant:", updated.tenantId);
  console.log("Role:", updated.role);
  console.log("\nTemporary login password:", TEMP_PASSWORD);
  console.log("(They should change this after first login)");
}
main().catch(console.error).finally(() => db.$disconnect());
