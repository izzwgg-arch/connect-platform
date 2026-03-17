// ── Entry point ────────────────────────────────────────────────────────────────
// Load env first — fails fast on bad config before anything else imports it.
import { env } from "./config/env";
import { logger } from "./logging/logger";

process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — shutting down");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled promise rejection — shutting down");
  process.exit(1);
});

import http from "http";
import { createApp } from "./app";
import { createTelephonyModule } from "./telephony";

async function main() {
  logger.info(
    {
      node: process.version,
      env: env.NODE_ENV,
      port: env.PORT,
      pbxHost: env.PBX_HOST,
      amiPort: env.AMI_PORT,
      ariBase: env.ARI_BASE_URL,
    },
    "ConnectComms telephony service starting",
  );

  // Confirm loaded credentials (username only — never log password)
  logger.info(
    {
      host: env.PBX_HOST,
      port: env.AMI_PORT,
      username: env.AMI_USERNAME,
    },
    "AMI config loaded",
  );
  logger.info(
    {
      baseUrl: env.ARI_BASE_URL,
      username: env.ARI_USERNAME,
      appName: env.ARI_APP_NAME,
    },
    "ARI config loaded",
  );

  const server = http.createServer();
  const telephony = createTelephonyModule(server);
  const app = createApp(telephony);

  server.on("request", app);

  telephony.start();

  await new Promise<void>((resolve, reject) => {
    server.listen(env.PORT, "0.0.0.0", () => resolve());
    server.once("error", reject);
  });

  logger.info(
    {
      port: env.PORT,
      wsPath: env.TELEPHONY_WS_PATH,
    },
    "Telephony service ready",
  );

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutdown signal received");
    telephony.stop();
    server.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
    // Force exit after 10 s if server.close stalls
    setTimeout(() => {
      logger.warn("Graceful shutdown timeout — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal error during startup");
  process.exit(1);
});
