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
    const isInternalRoute = req.path.startsWith("/telephony/internal/");
    if ((isInternalRoute && isInternalRouteAuthorized(req)) || hasValidInternalSecret(req)) {
      res.locals["jwtPayload"] = { tenantId: null, scope: "internal" };
      next();
      return;
    }
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

  // Diagnostic endpoint: full unfiltered call store state — no tenant filtering.
  // Returns every call in the store (any state), raw AMI data, and what each
  // WS client would see. Requires valid JWT (any role).
  router.get("/telephony/diag", (_req, res) => {
    const allCalls = telephony.callStore.getAll();
    const activeCalls = telephony.callStore.getActive();
    const diag = telephony.callStore.getDiagnostics();
    const pbxMap = telephony.pbxTenantMapCache?.getEntries?.() ?? [];

    const callDetail = allCalls.map((c) => ({
      id: c.id,
      linkedId: c.linkedId,
      state: c.state,
      tenantId: c.tenantId,
      tenantName: c.tenantName,
      direction: c.direction,
      from: c.from,
      to: c.to,
      channels: c.channels,
      startedAt: c.startedAt,
      answeredAt: c.answeredAt,
      endedAt: c.endedAt,
      isActive: activeCalls.some((a) => a.id === c.id),
      activeFilterReasons: (() => {
        const reasons: string[] = [];
        if (c.state === "hungup") reasons.push("state=hungup");
        const { isLocalOnlyCall, hasValidChannel } = require("../telephony/normalizers/normalizeCallEvent") as typeof import("../telephony/normalizers/normalizeCallEvent");
        if (isLocalOnlyCall(c)) reasons.push("local_only");
        if (!hasValidChannel(c)) reasons.push("no_valid_channel");
        return reasons;
      })(),
    }));

    res.json({
      timestamp: new Date().toISOString(),
      totalCallsInStore: allCalls.length,
      activeCallCount: activeCalls.length,
      unresolvedTenantCount: activeCalls.filter((c) => !c.tenantId).length,
      storeStats: {
        rawChannelCount: diag.rawChannelCount,
        hungupRetainedCount: diag.hungupRetainedCount,
      },
      calls: callDetail,
      pbxMapEntryCount: pbxMap.length,
      pbxMapLinkedCount: pbxMap.filter((e: { connectTenantId: string | null }) => e.connectTenantId).length,
    });
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

  router.post("/telephony/internal/mobile-invites/requeue", async (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { linkedId, exten, context } = req.body as {
      linkedId?: unknown;
      exten?: unknown;
      context?: unknown;
    };

    if (typeof linkedId !== "string" || !linkedId) {
      res.status(400).json({ error: "linkedId is required" });
      return;
    }

    try {
      const result = await telephony.telephonyService.requeueLiveCallToDialplan({
        linkedId,
        fallbackExten: typeof exten === "string" ? exten : undefined,
        fallbackContext: typeof context === "string" ? context : undefined,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ error: msg });
    }
  });

  router.get("/telephony/internal/mobile-invites/status/:linkedId", (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const linkedId = String(req.params["linkedId"] || "").trim();
    if (!linkedId) {
      res.status(400).json({ error: "linkedId is required" });
      return;
    }

    const call = telephony.callStore.getById(linkedId);
    if (!call) {
      res.json({
        ok: true,
        linkedId,
        exists: false,
        state: null,
        answeredAt: null,
        channels: [],
      });
      return;
    }

    res.json({
      ok: true,
      linkedId,
      exists: true,
      state: call.state,
      answeredAt: call.answeredAt,
      channels: [...call.channels],
    });
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

  /**
   * POST /telephony/calls/stale-hangup-for-extension
   *
   * Called by the portal ~10 s after the user presses hangup if the call still appears active
   * in the telephony WebSocket. Finds any live call matching the extension (and optionally tenant)
   * and force-evicts it from the store + sends AMI Hangup for each channel.
   *
   * This is the portal's last-resort safeguard: if JsSIP sent BYE but the PBX never delivered
   * the AMI Hangup event, this clears the orphaned row.
   */
  router.post(
    "/telephony/calls/stale-hangup-for-extension",
    async (req: Request, res: Response) => {
      const tenantId = getTenantId(res);
      const { extension, hangupAt } = req.body as { extension?: unknown; hangupAt?: unknown };

      if (typeof extension !== "string" || !extension) {
        res.status(400).json({ error: "extension is required" });
        return;
      }

      const hangupTs = typeof hangupAt === "string" ? new Date(hangupAt).getTime() : 0;

      const activeCalls = telephony.callStore.getActive().filter((c) => {
        if (tenantId && c.tenantId && c.tenantId !== tenantId) return false;
        // Match if either `from` or `to` contains the extension
        const matchesExt =
          (c.from && (c.from === extension || c.from.endsWith(`/${extension}`))) ||
          (c.to && (c.to === extension || c.to.endsWith(`/${extension}`)));
        if (!matchesExt) return false;
        // Only evict if the call started before or around the stated hangup time
        if (hangupTs > 0 && c.startedAt) {
          const startedMs = new Date(c.startedAt).getTime();
          // Must have started at least 2 s before the hangup timestamp
          if (startedMs > hangupTs - 2_000) return false;
        }
        return true;
      });

      if (activeCalls.length === 0) {
        res.json({ cleared: 0, message: "No matching active calls found (already gone)" });
        return;
      }

      const results: Array<{ callId: string; channels: string[]; hangupSent: boolean }> = [];

      for (const call of activeCalls) {
        const evicted = telephony.callStore.forceEvictZombie(
          call.id,
          `stale-report from portal extension=${extension}`,
        );

        let hangupSent = false;
        const targets = evicted.uniqueIds.length > 0 ? evicted.uniqueIds : evicted.channels;
        for (const target of targets) {
          try {
            await telephony.telephonyService.hangupChannel(target);
            hangupSent = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.locals["log"]?.warn?.({ callId: call.id, target, err: msg }, "stale-hangup: AMI error");
          }
        }

        results.push({ callId: call.id, channels: evicted.channels, hangupSent });
      }

      res.json({ cleared: results.length, calls: results });
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

function hasValidInternalSecret(req: Request): boolean {
  const configured = (env.CDR_INGEST_SECRET || "").trim();
  const incoming = String(req.headers["x-cdr-secret"] || "").trim();
  if (!configured || !incoming) return false;
  return incoming === configured;
}

function isInternalRouteAuthorized(req: Request): boolean {
  const configured = (env.CDR_INGEST_SECRET || "").trim();
  if (!configured) return true;
  return hasValidInternalSecret(req);
}
