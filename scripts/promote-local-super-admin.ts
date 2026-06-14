import { db } from "@connect/db";
import { resolveLocalDevEmail } from "@connect/shared";

async function main() {
  const email = resolveLocalDevEmail();
  const user = await db.user.update({
    where: { email },
    data: { role: "SUPER_ADMIN" },
  });
  console.log(`Promoted ${user.email} to SUPER_ADMIN`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
