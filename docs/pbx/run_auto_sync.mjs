// Run the prompt auto-sync from inside the app-api-1 container.
//   docker exec app-api-1 node /app/apps/api/run_auto_sync.mjs
import { PrismaClient } from "@prisma/client";
import { syncPromptsFromOmbutelMysql } from "./dist/pbxOmbutelPromptSync.js";

const db = new PrismaClient();
try {
  const inst = await db.pbxInstance.findFirst({
    where: { isEnabled: true },
    orderBy: { createdAt: "asc" },
  });
  if (!inst) {
    console.error("no PbxInstance with isEnabled=true; aborting");
    process.exit(2);
  }
  console.log(JSON.stringify({ pbxInstanceId: inst.id, baseUrl: inst.baseUrl ?? null }));
  const result = await syncPromptsFromOmbutelMysql(
    db,
    inst.id,
    inst.ombuMysqlUrlEncrypted,
    { deactivateMissing: false },
  );
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e?.stack ?? e);
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
