import type { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import type { TelephonyModule } from "../telephony";
import { normalizeCallForClient } from "../telephony/normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../telephony/normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../telephony/normalizers/normalizeQueueEvent";

export function registerTelephonyRoutes(
  router: Router,
  telephony: TelephonyModule,
): void {
  router.use((req, res, next) => {
    const token =
      extractBearerToken(req.headers.authorization) ??
      (req.query["token"] as string | undefined) ??
      "";
    try {
      res.locals["jwtPayload"] = jwt.verify(token, env.JWT_SECRET) as Record<
        string,
        unknown
      >;
      next();
    } catch {
      res.status(401).json({ error: "Unauthorized" });
    }
  });

  router.get("/telephony/health", (_req, res) => {
    res.json(telephony.healthService.getHealth());
  });

  router.get("/telephony/snapshot", (req, res) => {
    const tenantId = getTenantId(res);
    res.json(telephony.snapshotService.getSnapshot(tenantId));
  });

  router.get("/telephony/calls", (_req, res) => {
    const tenantId = getTenantId(res);
    let calls = telephony.callStore.getActive();
    if (tenantId !== null) {
      calls = calls.filter((c) => c.tenantId === tenantId);
    }
    res.json(calls.map(normalizeCallForClient));
  });

  router.get("/telephony/extensions", (_req, res) => {
    const tenantId = getTenantId(res);
    let exts = telephony.extStore.getAll();
    if (tenantId !== null) {
      exts = exts.filter((e) => e.tenantId === null || e.tenantId === tenantId);
    }
    res.json(exts.map(normalizeExtensionForClient));
  });

  router.get("/telephony/queues", (_req, res) => {
    const tenantId = getTenantId(res);
    let queues = telephony.queueStore.getAll();
    if (tenantId !== null) {
      queues = queues.filter((q) => q.tenantId === null || q.tenantId === tenantId);
    }
    res.json(queues.map(normalizeQueueForClient));
  });

  // ── Action endpoints ──────────────────────────────────────────────────────────

  router.post("/telephony/calls/originate", async (req: Request, res: Response) => {
    const { channel, exten, context, callerID, timeout, variables } = req.body as {
      channel?: unknown;
      exten?: unknown;
      context?: unknown;
      callerID?: unknown;
      timeout?: unknown;
      variables?: unknown;
    };

    if (typeof channel !== "string" || typeof exten !== "string") {
      res.status(400).json({ error: "channel and exten are required" });
      return;
    }

    try {
      const actionId = await telephony.telephonyService.originateCall({
        channel,
        exten,
        context: typeof context === "string" ? context : "from-internal",
        callerID: typeof callerID === "string" ? callerID : undefined,
        timeout: typeof timeout === "number" ? timeout : undefined,
        variables: isStringRecord(variables) ? variables : undefined,
      });
      res.json({ actionId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ error: msg });
    }
  });

  router.delete(
    "/telephony/calls/:channelId/hangup",
    async (req: Request, res: Response) => {
      const { channelId } = req.params;
      if (!channelId) {
        res.status(400).json({ error: "channelId required" });
        return;
      }
      try {
        const actionId = await telephony.telephonyService.hangupChannel(channelId);
        res.json({ actionId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(503).json({ error: msg });
      }
    },
  );

  router.post(
    "/telephony/calls/:channelId/transfer",
    async (req: Request, res: Response) => {
      const { channelId } = req.params;
      const { exten, context } = req.body as { exten?: unknown; context?: unknown };
      if (!channelId || typeof exten !== "string") {
        res.status(400).json({ error: "channelId and exten are required" });
        return;
      }
      try {
        const actionId = await telephony.telephonyService.redirectChannel({
          channel: channelId,
          exten,
          context: typeof context === "string" ? context : "from-internal",
        });
        res.json({ actionId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(503).json({ error: msg });
      }
    },
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function extractBearerToken(header?: string): string | null {
  if (!header) return null;
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function getTenantId(res: Response): string | null {
  const payload = res.locals["jwtPayload"] as Record<string, unknown> | undefined;
  if (!payload) return null;
  return typeof payload["tenantId"] === "string" ? payload["tenantId"] : null;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === "string")
  );
}
