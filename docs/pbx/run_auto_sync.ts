// Run the IVR prompt auto-sync from inside app-api-1 using tsx.
//
//   docker cp run_auto_sync.ts app-api-1:/app/apps/api/src/run_auto_sync.ts
//   docker exec app-api-1 node /app/node_modules/.bin/tsx /app/apps/api/src/run_auto_sync.ts

import { PrismaClient } from "@prisma/client";
import { syncPromptsFromOmbutelMysql } from "./pbxOmbutelPromptSync";

async function main() {
  const db = new PrismaClient();
  try {
    const inst = await db.pbxInstance.findFirst({
      where: { isEnabled: true },
      orderBy: { createdAt: "asc" },
    });
    if (!inst) {
      console.error("no enabled PbxInstance found; aborting");
      process.exit(2);
    }
    console.log(
      JSON.stringify({ pbxInstanceId: inst.id, baseUrl: (inst as any).baseUrl ?? null }),
    );
    const result = await syncPromptsFromOmbutelMysql(
      db,
      inst.id,
      inst.ombuMysqlUrlEncrypted,
      { deactivateMissing: false },
    );
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.$disconnect();
  }
}

main().catch((e: any) => {
  console.error(e?.stack ?? String(e));
  process.exit(1);
});
