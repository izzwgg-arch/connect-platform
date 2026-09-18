import { buildApp } from "./app.js";
import { env } from "./env.js";
import { startSchedulers } from "./core/schedulers.js";

const app = await buildApp({ logger: true });
const e = env();
// "::" = dual-stack: WebKit (Safari) resolves localhost to ::1 first and reports an IPv4-only
// server as a failed "access control check" on every cross-origin call.
await app.listen({ port: e.PORT, host: "::" });
startSchedulers(app);
app.log.info(`Loopcom Community api listening on ${e.PORT} (${e.NODE_ENV})`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
