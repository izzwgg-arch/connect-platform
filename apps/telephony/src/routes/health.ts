import type { Router } from "express";
import type { TelephonyModule } from "../telephony";

export function registerHealthRoutes(router: Router, telephony: TelephonyModule): void {
  router.get("/health", (_req, res) => {
    const health = telephony.healthService.getHealth();
    const statusCode = health.status === "down" ? 503 : 200;
    res.status(statusCode).json(health);
  });
}
