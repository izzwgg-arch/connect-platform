import express from "express";
import { registerHealthRoutes } from "./routes/health";
import { registerTelephonyRoutes } from "./routes/telephony";
import type { TelephonyModule } from "./telephony";

export function createApp(telephony: TelephonyModule) {
  const app = express();

  app.use(express.json());

  app.get("/", (_req, res) => {
    res.json({ service: "connect-telephony", status: "ok" });
  });

  const router = express.Router();
  registerHealthRoutes(router, telephony);
  registerTelephonyRoutes(router, telephony);

  app.use(router);

  return app;
}
