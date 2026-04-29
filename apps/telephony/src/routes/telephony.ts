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
      extensions: c.extensions,
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

  // ── IVR AstDB publish ─────────────────────────────────────────────────────
  // Writes tenant-scoped runtime routing keys to Asterisk AstDB via AMI DBPut.
  // Called by the Connect API (and worker) on every IVR publish or rollback.
  // Auth: x-cdr-secret (same shared secret as CDR ingest).
  // Body:
  //   { tenantSlug: string,
  //     keys: Array<{ family: string, key: string, value: string }>,
  //     didE164?: string }    // optional: also permits connect/didmap/<e164>/*
  //
  // Families allowed in `keys`:
  //   • connect/t_<tenantSlug>           — tenant-scoped IVR/MOH/hold state
  //   • connect/didmap/<didE164>         — per-DID routing overrides (only
  //                                         when didE164 is supplied). Both
  //                                         +E.164 and raw-digits aliases are
  //                                         allowed for PBX dialplan lookups.
  router.post("/telephony/internal/ivr-publish", (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { tenantSlug, keys, didE164 } = req.body as {
      tenantSlug?: unknown; keys?: unknown; didE164?: unknown;
    };
    if (typeof tenantSlug !== "string" || !/^[a-z0-9_]+$/.test(tenantSlug)) {
      res.status(400).json({ error: "invalid_slug" });
      return;
    }
    if (!Array.isArray(keys) || keys.length === 0) {
      res.status(400).json({ error: "keys must be a non-empty array" });
      return;
    }
    // didE164, if provided, must be strict E.164 digits (optionally with + prefix).
    // This prevents the caller from smuggling a "../"-style family injection.
    let didFamilyPrefixes: Set<string> | null = null;
    if (didE164 !== undefined && didE164 !== null && didE164 !== "") {
      if (typeof didE164 !== "string" || !/^\+?\d{7,20}$/.test(didE164)) {
        res.status(400).json({ error: "invalid_did_e164" });
        return;
      }
      const didDigits = didE164.replace(/\D/g, "");
      didFamilyPrefixes = new Set([`connect/didmap/${didE164}`, `connect/didmap/${didDigits}`]);
    }
    if (!telephony.ami._isConnected) {
      res.status(503).json({ error: "ami_not_connected" });
      return;
    }
    let written = 0;
    for (const entry of keys) {
      if (
        typeof entry !== "object" || entry === null ||
        typeof (entry as any).family !== "string" ||
        typeof (entry as any).key !== "string" ||
        typeof (entry as any).value !== "string"
      ) continue;
      const { family, key, value } = entry as { family: string; key: string; value: string };
      // Tenant-scoped family OR the specific didmap family for this e164.
      const tenantScoped = family.startsWith(`connect/t_${tenantSlug}`);
      const didScoped = didFamilyPrefixes !== null && didFamilyPrefixes.has(family);
      if (!tenantScoped && !didScoped) {
        res.status(400).json({ error: "family_scope_mismatch", family });
        return;
      }
      telephony.ami.sendAction("DBPut", { Family: family, Key: key, Val: value });
      written++;
    }
    res.json({ ok: true, written });
  });

  // ── IVR AstDB snapshot read ───────────────────────────────────────────────
  // Reads tenant-scoped AstDB keys so the Connect API can snapshot the
  // pre-publish state and enable real rollback. Uses AMI `DBGet` per key
  // (cheap, in-memory in Asterisk). Missing keys are returned with value="".
  //
  // Auth: x-cdr-secret (same shared secret as CDR ingest / ivr-publish).
  // Body: { tenantSlug: string, family: string, keys: string[] }
  // Resp: { ok: true, snapshot: Array<{ family, key, value }> }
  //
  // Tenant isolation: the `family` must start with `connect/t_${tenantSlug}`,
  // identical to the ivr-publish guard. No cross-tenant reads are possible.
  router.post("/telephony/internal/astdb-read-family", async (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const { tenantSlug, family, keys, didE164 } = req.body as {
      tenantSlug?: unknown; family?: unknown; keys?: unknown; didE164?: unknown;
    };
    if (typeof tenantSlug !== "string" || !/^[a-z0-9_]+$/.test(tenantSlug)) {
      res.status(400).json({ error: "invalid_slug" });
      return;
    }
    // Accept either a tenant family (connect/t_<slug>*) or the specific
    // didmap family (connect/didmap/<e164>) when didE164 is supplied.
    let didFamily: string | null = null;
    if (didE164 !== undefined && didE164 !== null && didE164 !== "") {
      if (typeof didE164 !== "string" || !/^\+?\d{7,20}$/.test(didE164)) {
        res.status(400).json({ error: "invalid_did_e164" });
        return;
      }
      didFamily = `connect/didmap/${didE164}`;
    }
    if (
      typeof family !== "string" ||
      !(family.startsWith(`connect/t_${tenantSlug}`) || (didFamily !== null && family === didFamily))
    ) {
      res.status(400).json({ error: "family_scope_mismatch" });
      return;
    }
    if (!Array.isArray(keys) || keys.length === 0 || keys.length > 32) {
      res.status(400).json({ error: "keys must be a 1..32 array" });
      return;
    }
    if (!telephony.ami._isConnected) {
      res.status(503).json({ error: "ami_not_connected" });
      return;
    }
    const snapshot: Array<{ family: string; key: string; value: string }> = [];
    for (const k of keys) {
      if (typeof k !== "string" || k.length === 0 || k.length > 64) {
        res.status(400).json({ error: "invalid_key", key: k });
        return;
      }
      try {
        const result = await telephony.ami.dbGet(family, k, 2_000);
        // Missing keys (result.ok === false) are snapshotted as "" so that
        // rollback restores them to "no destination" — the custom context
        // interprets an empty value as "fall through to default-fallback-ivr",
        // which is the safe, correct pre-existing behavior.
        snapshot.push({ family, key: k, value: result.ok ? result.value : "" });
      } catch {
        // Timeout or disconnect: record the key as absent rather than failing
        // the whole snapshot. The caller logs partial snapshots via the
        // IvrPublishRecord so an operator can see what happened.
        snapshot.push({ family, key: k, value: "" });
      }
    }
    res.json({ ok: true, snapshot });
  });

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
