/**
 * Print last voicemail spool reconcile summary from Redis (same key the worker updates).
 *
 *   cd /app/apps/worker && pnpm exec tsx src/scripts/voicemail-reconcile-last.ts
 */
import IORedis from "ioredis";
import { REDIS_SUMMARY_KEY } from "../voicemailSpoolReconcileCycle";

async function main(): Promise<void> {
  const redis = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", { maxRetriesPerRequest: null });
  try {
    const raw = await redis.get(REDIS_SUMMARY_KEY);
    if (!raw) {
      console.log(JSON.stringify({ ok: false, error: "no_summary_in_redis", key: REDIS_SUMMARY_KEY }));
      return;
    }
    console.log(raw);
  } finally {
    await redis.quit();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
