/**
 * One-off: set isEnabled = true for PBX instances that are currently disabled.
 * Usage: pnpm exec tsx scripts/enable-pbx-instances.ts
 * Run from apps/api with DATABASE_URL and optional CREDENTIALS_MASTER_KEY.
 */
import { db } from "@connect/db";

async function main(): Promise<void> {
  const disabled = await db.pbxInstance.findMany({
    where: { isEnabled: false },
    select: { id: true, name: true, baseUrl: true }
  });
  if (disabled.length === 0) {
    console.log("No disabled PBX instances found.");
    return;
  }
  console.log("Enabling", disabled.length, "PBX instance(s):");
  for (const inst of disabled) {
    console.log(" ", inst.id, inst.name, inst.baseUrl);
  }
  const result = await db.pbxInstance.updateMany({
    where: { isEnabled: false },
    data: { isEnabled: true }
  });
  console.log("Updated count:", result.count);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
