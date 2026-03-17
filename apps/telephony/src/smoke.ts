// Smoke test: connects to the running telephony service and prints status.
// Usage: pnpm --filter @connect/telephony smoke
//        or: PORT=3003 tsx src/smoke.ts

const port = Number(process.env.PORT ?? 3003);
const base = `http://127.0.0.1:${port}`;

async function run() {
  console.log(`\nConnectComms Telephony Smoke Test → ${base}\n`);

  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    console.log("── Health ──────────────────────────────────");
    console.log(`  Status      : ${health.status}`);
    console.log(`  AMI connected : ${health.ami?.connected}`);
    console.log(`  ARI connected : ${health.ari?.connected}`);
    console.log(`  Active calls  : ${health.activeCalls}`);
    console.log(`  Extensions    : ${health.activeExtensions}`);
    console.log(`  Queues        : ${health.activeQueues}`);
    console.log(`  Uptime        : ${health.uptimeSec}s`);
  } catch (err) {
    console.error("  FAILED to reach health endpoint:", (err as Error).message);
  }

  try {
    const calls = await fetch(`${base}/telephony/calls`).then((r) => {
      if (r.status === 401) return { _authRequired: true };
      return r.json();
    });
    if ((calls as { _authRequired?: boolean })._authRequired) {
      console.log("\n── Calls ───────────────────────────────────");
      console.log("  (JWT required — set TELEPHONY_TEST_TOKEN to query calls)");
    } else {
      const arr = calls as unknown[];
      console.log("\n── Active calls ────────────────────────────");
      console.log(`  Count: ${arr.length}`);
    }
  } catch (err) {
    console.error("  FAILED to query calls:", (err as Error).message);
  }

  console.log();
}

run();
