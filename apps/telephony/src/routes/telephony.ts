import type { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import type { TelephonyModule } from "../telephony";
import { normalizeCallForClient } from "../telephony/normalizers/normalizeCallEvent";
import { normalizeExtensionForClient } from "../telephony/normalizers/normalizeExtensionEvent";
import { normalizeQueueForClient } from "../telephony/normalizers/normalizeQueueEvent";
import { selectPlaybackChannelName } from "./telephonyPlaybackHelpers";
import { classifyVoicemailDropLegs } from "./voicemailDropLegs";
import { parseDndPublishRequest } from "./dndPublish";
import { parseWakeCanaryPublishRequest, buildWakeCanaryKeyWrites } from "./wakeCanaryPublish";
import {
  parseWakeDialPublishRequest,
  transformDialValue,
  discoverDialKeyFamily,
  decideFollowMeRingTime,
  DIAL_DISCOVERY_CLI,
} from "./wakeDialPublish";
import { looksDivertedToVoicemail } from "../telephony/services/MobilePushNotifier";

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
    const allExtensions = telephony.extStore.getAll();
    const diag = telephony.callStore.getDiagnostics();
    const pbxMap = telephony.pbxTenantMapCache?.getEntries?.() ?? [];
    const pbxTenantMapStats = telephony.pbxTenantMapCache?.getStats?.() ?? null;

    const callDetail = allCalls.map((c) => ({
      id: c.id,
      linkedId: c.linkedId,
      state: c.state,
      tenantId: c.tenantId,
      tenantSlug: c.tenantSlug,
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
      pbxTenantMapStats,
      calls: callDetail,
      blf: allExtensions.map((ext) => {
        const callsForExt = activeCalls.filter((call) => call.extensions.includes(ext.extension));
        const ringing = callsForExt.filter((call) => call.state === "ringing" || call.state === "dialing");
        const onCall = callsForExt.filter((call) => call.state === "up" || call.state === "held");
        const registered = ext.status === "idle" || ext.status === "inuse" || ext.status === "busy" || ext.status === "ringing" || ext.status === "onhold";
        const finalStatus =
          ringing.length > 0 ? "ringing" :
          onCall.length > 0 ? "on_call" :
          registered ? "available" :
          "offline";
        return {
          extension: ext.extension,
          tenantId: ext.tenantId,
          registrationStatus: ext.status,
          registered,
          activeRingingChannels: ringing.flatMap((call) => call.channels),
          activeBridgedOrUpChannels: onCall.flatMap((call) => call.channels),
          finalStatus,
          lastEventTimestamp: ext.updatedAt,
          reason:
            ringing.length > 0 ? "ringing_call_present" :
            onCall.length > 0 ? "active_up_or_held_call_present" :
            registered ? `registered_status_${ext.status}` :
            `offline_status_${ext.status}`,
          callIds: callsForExt.map((call) => call.id),
        };
      }),
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

    const { linkedId, exten, context, trigger } = req.body as {
      linkedId?: unknown;
      exten?: unknown;
      context?: unknown;
      trigger?: unknown;
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
        trigger: typeof trigger === "string" ? trigger : undefined,
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
        extensionAnsweredAt: null,
        voicemail: false,
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
      // Authoritative "a real tenant extension actually answered" timestamp.
      // Null for inbound-trunk early media / ringback (which still sets
      // answeredAt), IVR-only journeys, and voicemail. This is what lets the
      // mobile distinguish a genuine "answered on another device" from the
      // ring-group ringback that previously caused false teardowns.
      extensionAnsweredAt: call.extensionAnsweredAt,
      // Heuristic voicemail-divert flag (channel/dcontext name match). The
      // VoiceMail() app answers the channel so answeredAt alone can't tell
      // voicemail from a human pickup — this disambiguates it.
      voicemail: looksDivertedToVoicemail(call),
      channels: [...call.channels],
    });
  });

  router.post("/telephony/internal/calls/play-prompt", async (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { linkedId, tenantId, fileBaseName, targetLeg } = req.body as {
      linkedId?: unknown;
      tenantId?: unknown;
      fileBaseName?: unknown;
      targetLeg?: unknown;
    };
    const callId = typeof linkedId === "string" ? linkedId.trim() : "";
    const requestedTenantId = typeof tenantId === "string" ? tenantId.trim() : "";
    const baseName = typeof fileBaseName === "string" ? fileBaseName.trim() : "";
    const leg = targetLeg === "agent" ? "agent" : "external";

    if (!callId) {
      res.status(400).json({ error: "linkedId_required" });
      return;
    }
    if (!requestedTenantId) {
      res.status(400).json({ error: "tenantId_required" });
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(baseName)) {
      res.status(400).json({ error: "invalid_file_base_name" });
      return;
    }

    const call = telephony.callStore.getById(callId);
    if (!call || call.state === "hungup") {
      res.status(404).json({ error: "no_active_call" });
      return;
    }
    if (call.tenantId !== requestedTenantId) {
      res.status(403).json({ error: "tenant_mismatch" });
      return;
    }
    if (!telephony.callStore.getActive().some((active) => active.id === call.id)) {
      res.status(409).json({ error: "call_not_bridged" });
      return;
    }
    if (!telephony.ari._isConnected) {
      res.status(503).json({ error: "ari_not_connected" });
      return;
    }

    try {
      const ariChannels = await telephony.ariActions.getChannels();
      const targetName = selectPlaybackChannelName(call.channels, leg);
      if (!targetName) {
        res.status(409).json({ error: "no_playable_channel" });
        return;
      }
      const target = ariChannels.find((channel) => channel.name === targetName || channel.name.startsWith(`${targetName};`));
      if (!target?.id) {
        res.status(409).json({ error: "ari_channel_not_found", channel: targetName });
        return;
      }
      const playbackId = `crm-vm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const playback = await telephony.ariActions.playSoundOnChannel(
        target.id,
        `sound:custom/${baseName}`,
        playbackId,
      );
      res.json({
        ok: true,
        linkedId: call.id,
        channelId: target.id,
        channelName: target.name,
        playbackId: playback?.id || playbackId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ error: "pbx_playback_failed", detail: msg });
    }
  });

  // ── CRM Voicemail Drop (AMI → [connect-vm-drop] dialplan; no ARI media) ─────
  // Redirects the CUSTOMER/PSTN leg into the additive [connect-vm-drop] context
  // (installed by scripts/pbx/install-connect-vm-drop-dialplan.sh) to play the
  // pushed recording, then hangs up the AGENT leg so the dialer frees instantly.
  //
  // HARD SAFETY: never issues the Redirect unless DIALPLAN_EXISTS(connect-vm-drop)
  // is confirmed on the live channel — redirecting into a missing context would
  // drop the live customer call.
  //
  // Auth: x-cdr-secret (same as play-prompt). Returns quickly (fire-and-forget):
  // playback completion is observed later via the customer-leg Hangup event.
  router.post("/telephony/internal/calls/voicemail-drop", async (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { linkedId, tenantId, fileBaseName, strategy, waitSeconds, agentEndpoint, agentExtension } = req.body as {
      linkedId?: unknown;
      tenantId?: unknown;
      fileBaseName?: unknown;
      strategy?: unknown;
      waitSeconds?: unknown;
      agentEndpoint?: unknown;
      agentExtension?: unknown;
    };
    const callId = typeof linkedId === "string" ? linkedId.trim() : "";
    const requestedTenantId = typeof tenantId === "string" ? tenantId.trim() : "";
    const baseName = typeof fileBaseName === "string" ? fileBaseName.trim() : "";
    const wait = strategy === "waitsilence" ? "waitsilence" : strategy === "amd" ? "amd" : "fixed";
    const waitSecs =
      typeof waitSeconds === "number" && Number.isFinite(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 30
        ? Math.round(waitSeconds)
        : null;
    const agentHint = typeof agentEndpoint === "string" && agentEndpoint.trim() ? agentEndpoint.trim() : null;
    const agentExt = typeof agentExtension === "string" && agentExtension.trim() ? agentExtension.trim() : "";

    // A precise linkedId is preferred, but the WebRTC dialer can't always map its
    // SIP session to the AMI/ARI live-call id. When the caller supplies the agent
    // extension we can resolve the bridged call server-side instead — this is what
    // makes Voicemail Drop reliable from the floating dialer.
    if (!callId && !agentExt) {
      res.status(400).json({ error: "linkedId_or_agent_extension_required" });
      return;
    }
    if (!requestedTenantId) {
      res.status(400).json({ error: "tenantId_required" });
      return;
    }
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(baseName)) {
      res.status(400).json({ error: "invalid_file_base_name" });
      return;
    }

    let call = callId ? telephony.callStore.getById(callId) : undefined;
    if ((!call || call.state === "hungup") && agentExt) {
      // Resolve among bridged/active calls for this tenant whose extension set
      // includes the agent. Prefer a call that classifies to a real customer leg.
      const candidates = telephony.callStore
        .getActive()
        .filter((c) => c.tenantId === requestedTenantId && (c.extensions ?? []).includes(agentExt));
      call =
        candidates.find((c) => classifyVoicemailDropLegs(c.channels, agentHint).customerLeg != null) ??
        candidates[0];
    }
    if (!call || call.state === "hungup") {
      res.status(404).json({ error: "no_active_call" });
      return;
    }
    if (call.tenantId !== requestedTenantId) {
      res.status(403).json({ error: "tenant_mismatch" });
      return;
    }
    if (!telephony.callStore.getActive().some((active) => active.id === call.id)) {
      res.status(409).json({ error: "call_not_bridged" });
      return;
    }
    if (!telephony.ami._isConnected) {
      res.status(503).json({ error: "ami_not_connected" });
      return;
    }

    const { customerLeg, agentLeg } = classifyVoicemailDropLegs(call.channels, agentHint);
    if (!customerLeg) {
      res.status(409).json({ error: "no_customer_leg" });
      return;
    }

    // HARD GUARD: confirm the dialplan context is installed on the live channel
    // before redirecting. DIALPLAN_EXISTS returns "1" when present.
    try {
      const probe = await telephony.ami.getVar(customerLeg, "DIALPLAN_EXISTS(connect-vm-drop,s,1)", 2_500);
      if (!probe.ok || probe.value.trim() !== "1") {
        res.status(409).json({ error: "vm_drop_context_missing" });
        return;
      }
    } catch {
      res.status(503).json({ error: "ami_probe_failed" });
      return;
    }

    try {
      telephony.ami.sendAction("Setvar", { Channel: customerLeg, Variable: "VMDROP_FILE", Value: baseName });
      telephony.ami.sendAction("Setvar", { Channel: customerLeg, Variable: "VMDROP_STRATEGY", Value: wait });
      if (waitSecs !== null) {
        telephony.ami.sendAction("Setvar", { Channel: customerLeg, Variable: "VMDROP_WAIT", Value: String(waitSecs) });
      }
      await telephony.telephonyService.redirectChannel({
        channel: customerLeg,
        exten: "s",
        context: "connect-vm-drop",
      });
      // Free the agent immediately. Best-effort: the redirect already tore down
      // the bridge; an explicit Hangup releases the agent's softphone UI now.
      if (agentLeg && agentLeg !== customerLeg) {
        try {
          await telephony.telephonyService.hangupChannel(agentLeg);
        } catch (err) {
          res.locals["log"]?.warn?.(
            { callId: call.id, agentLeg, err: err instanceof Error ? err.message : String(err) },
            "voicemail-drop: agent leg hangup failed (non-fatal)",
          );
        }
      }
      res.json({ ok: true, linkedId: call.id, customerLeg, agentLeg: agentLeg ?? null, strategy: wait });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({ error: "vm_drop_failed", detail: msg });
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
  //   • connect/pbx_tenant_map/<id>      — reverse lookup used by the tenant
  //                                         MOH enforcement dialplan
  //                                         (`extensions__65_connect_tenant_moh.conf`).
  //                                         <id> must be a 1–10 digit numeric
  //                                         VitalPBX tenant id. The values
  //                                         themselves (slug, moh_class) are
  //                                         already tenant-derived; the family
  //                                         scope is global because the
  //                                         dialplan resolver does not know
  //                                         the canonical Connect slug at the
  //                                         time it reads the key.
  router.post("/telephony/internal/ivr-publish", async (req: Request, res: Response) => {
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
    const accepted: Array<{ family: string; key: string; value: string }> = [];
    for (const entry of keys) {
      if (
        typeof entry !== "object" || entry === null ||
        typeof (entry as any).family !== "string" ||
        typeof (entry as any).key !== "string" ||
        typeof (entry as any).value !== "string"
      ) continue;
      const { family, key, value } = entry as { family: string; key: string; value: string };
      // Allowed families:
      //  - connect/t_<tenantSlug>* — tenant-scoped routing/IVR/MOH/wake config
      //  - connect/didmap/<e164>   — per-DID overrides (only when didE164 supplied)
      //  - connect/system          — system-wide config used by every tenant's
      //                              wake-then-dial wrapper. Allowing this family
      //                              from any tenantSlug is intentional: the keys
      //                              under it (wake_api_url, wake_api_secret,
      //                              wake_wait_secs) are global runtime
      //                              configuration that every tenant publish needs
      //                              available before the dialplan can run a
      //                              push-wake. No per-tenant data goes here.
      //  - connect/pbx_tenant_map/<id> — reverse lookup published by the MOH
      //                              publish path so the tenant MOH enforcement
      //                              dialplan can recover the canonical Connect
      //                              slug from a numeric VitalPBX tenant id on
      //                              outbound/internal/bridge legs. Strictly
      //                              numeric <id>; the slug + moh_class values
      //                              are tenant-derived.
      const tenantScoped = family.startsWith(`connect/t_${tenantSlug}`);
      const didScoped = didFamilyPrefixes !== null && didFamilyPrefixes.has(family);
      const systemScoped = family === "connect/system";
      const tenantMapScoped = /^connect\/pbx_tenant_map\/\d{1,10}$/.test(family);
      if (!tenantScoped && !didScoped && !systemScoped && !tenantMapScoped) {
        res.status(400).json({ error: "family_scope_mismatch", family });
        return;
      }
      accepted.push({ family, key, value });
    }

    // ⛔ AWAIT every write. This used to be fire-and-forget sendAction() +
    // an immediate {ok:true}: Connect answered "published" before Asterisk had
    // applied a single key, so a call right after a publish could still hear
    // the previous menu, and a dropped write was never noticed by anyone. The
    // owner's word for that is "I published and it didn't take effect".
    // Bounded concurrency keeps a 400+ key publish quick without flooding the
    // AMI socket.
    const failures: Array<{ family: string; key: string; error: string }> = [];
    // 64: measured ~320ms per batch round-trip against this PBX, so a 471-key
    // publish lands in ~3s instead of ~10s. Awaiting writes made publishes
    // honest but slower; this keeps them honest AND fast.
    const CONCURRENCY = 64;
    for (let i = 0; i < accepted.length; i += CONCURRENCY) {
      const batch = accepted.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (e) => {
          try {
            const r = await telephony.ami.dbPut(e.family, e.key, e.value);
            return r.ok ? null : { ...e, error: r.error };
          } catch (err: any) {
            return { ...e, error: String(err?.message ?? err) };
          }
        }),
      );
      for (const r of results) {
        if (r) failures.push({ family: r.family, key: r.key, error: r.error });
        else written++;
      }
    }

    if (failures.length > 0) {
      // Partial writes are a FAILED publish. Reporting success here is how a
      // half-applied menu goes live and nobody finds out.
      res.status(502).json({
        ok: false,
        error: "astdb_write_failed",
        written,
        failed: failures.length,
        sample: failures.slice(0, 5),
      });
      return;
    }
    res.json({ ok: true, written });
  });

  // ── App-reported mobile DND publish ──────────────────────────────────────
  // Narrowly-scoped internal route: writes ONLY the two Connect-owned DND
  // AstDB families consumed by [connect-wake-core]'s DND short-circuit
  // (scripts/pbx/install-connect-wake-dialplan.sh). Deliberately NOT folded
  // into /telephony/internal/ivr-publish's generic family allowlist above —
  // this route accepts no caller-supplied family/key strings at all. It only
  // accepts numeric tenant-id and extension components, validated by strict
  // regex, and assembles the AstDB key itself — there is no way to smuggle an
  // arbitrary family/key through it, and no tenant-slug family-prefix check is
  // needed because the key space is closed (connect/dnd + connect/dnd_ts only).
  //
  // Auth: x-cdr-secret (same shared secret as ivr-publish / CDR ingest). The
  // caller (Connect API's POST /mobile/dnd-status) is responsible for
  // resolving pbxTenantId/extension from the authenticated mobile user's OWN
  // extension ownership records — this route trusts whatever tenant/ext it is
  // given, exactly like ivr-publish trusts its caller's tenantSlug.
  //
  // Body: { pbxTenantId: string (1-10 digits), extension: string (1-10 digits),
  //         dnd: "0" | "1", ts: string (unix epoch seconds, digits only) }
  // Resp: { ok: true, written: 2, key: "T<pbxTenantId>_<extension>" }
  router.post("/telephony/internal/dnd-publish", (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = parseDndPublishRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (!telephony.ami._isConnected) {
      res.status(503).json({ error: "ami_not_connected" });
      return;
    }
    telephony.ami.sendAction("DBPut", { Family: "connect/dnd", Key: parsed.key, Val: parsed.dnd });
    telephony.ami.sendAction("DBPut", { Family: "connect/dnd_ts", Key: parsed.key, Val: parsed.ts });
    res.json({ ok: true, written: 2, key: parsed.key });
  });

  // ── Mobile wake-canary publish ───────────────────────────────────────────
  // Narrowly-scoped internal route (same closed-key-space model as dnd-publish):
  // writes ONLY the four Connect-owned wake_canary AstDB families that
  // scripts/pbx/wake-canary-reconcile.mjs owns and that [connect-wake-core] /
  // the T<id>_cos-all overlay read. It accepts NO caller-supplied family/key —
  // only numeric pbxTenantId + extension, validated by strict regex, with the
  // AstDB key assembled server-side (see wakeCanaryPublish.ts). This is the
  // in-lane "Connect normal channel" (AMI DBPut/DBDel) the autonomous wake
  // auto-enroll worker publishes through; it can never touch any other PBX key
  // space and performs no dialplan/config mutation.
  //
  // Auth: x-cdr-secret (same shared secret as ivr-publish / dnd-publish / CDR).
  // Body: { pbxTenantId: string(1-10 digits), extension: string(1-10 digits),
  //         enable: "0" | "1", ts: string(unix epoch seconds, digits only) }
  // Resp: { ok: true, written: number, key: "T<pbxTenantId>_<extension>" }
  router.post("/telephony/internal/wake-canary-publish", (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = parseWakeCanaryPublishRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (!telephony.ami._isConnected) {
      res.status(503).json({ error: "ami_not_connected" });
      return;
    }
    let written = 0;
    for (const w of buildWakeCanaryKeyWrites(parsed)) {
      if (w.op === "put") {
        telephony.ami.sendAction("DBPut", { Family: w.family, Key: w.key, Val: w.value });
      } else {
        telephony.ami.sendAction("DBDel", { Family: w.family, Key: w.key });
      }
      written++;
    }
    res.json({ ok: true, written, key: parsed.key });
  });

  // ── Mobile wake-dial publish ─────────────────────────────────────────────
  // Second half of wake-and-wait enrollment (see wakeDialPublish.ts). Rewrites
  // ONLY the extension's mobile leg in its AstDB `dial` string so native
  // VitalPBX call paths route through [connect-mobile-wake-dial]:
  //   PJSIP/T<t>_<e>_1  <->  Local/T<t>_<e>_1@connect-mobile-wake-dial/n
  // The tenant's AstDB family hash is discovered per request from the
  // read-only CLI `database showkey dial` (constant string, AMI Command
  // action); the current value is read back after the write to verify it
  // landed. Fail-closed: an ambiguous or absent dial key, or an unrecognized
  // dial shape, publishes nothing.
  //
  // Auth: x-cdr-secret. Body: { pbxTenantId, extension: digit strings,
  // enable: "0" | "1" }. Resp: { ok, changed, key, before, after } or a typed
  // error reason the auto-enroll worker treats as a skip, not a failure.
  /**
   * Raise an extension's follow-me ring time so the wake hold can actually
   * finish. BEST EFFORT by design — the dial-string rewrite is the primary
   * function of enrollment, and a ring-time failure must never fail or undo
   * it: an extension routed through the wake engine with a 15 s ring is still
   * far better than one not routed through it at all.
   *
   * All the raise-only / never-invent safety rules live in the pure
   * `decideFollowMeRingTime()` so they are testable without an AMI.
   */
  async function normalizeFollowMeRingTime(
    family: string,
    enable: "0" | "1",
  ): Promise<Record<string, unknown>> {
    try {
      const ringFamily = `${family}/followme`;
      const curRing = await telephony.ami.dbGet(ringFamily, "ringtime", 3_000);
      const decision = decideFollowMeRingTime(curRing.ok ? curRing.value : null, enable);
      if (!decision.change) {
        return { changed: false, reason: decision.reason, current: decision.current };
      }
      telephony.ami.sendAction("DBPut", {
        Family: ringFamily,
        Key: "ringtime",
        Val: String(decision.to),
      });
      // DBPut is fire-and-forget — read back, same as the dial write does.
      const verifyRing = await telephony.ami.dbGet(ringFamily, "ringtime", 3_000);
      const landed = verifyRing.ok && String(verifyRing.value).trim() === String(decision.to);
      return {
        changed: landed,
        from: decision.from,
        to: decision.to,
        verified: landed,
        observed: verifyRing.ok ? verifyRing.value : null,
      };
    } catch (err) {
      // Swallowed deliberately — see the note above.
      return {
        changed: false,
        reason: "ami_error",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  router.post("/telephony/internal/wake-dial-publish", async (req: Request, res: Response) => {
    if (!isInternalRouteAuthorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const parsed = parseWakeDialPublishRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    if (!telephony.ami._isConnected) {
      res.status(503).json({ error: "ami_not_connected" });
      return;
    }
    try {
      const show = await telephony.ami.command(DIAL_DISCOVERY_CLI, 8_000);
      if (!show.ok) {
        res.status(502).json({ error: "discovery_failed", detail: show.error });
        return;
      }
      const found = discoverDialKeyFamily(show.output, parsed.extension, parsed.mobileEndpoint);
      if (!found.ok) {
        res.status(404).json({
          error: found.error,
          key: `T${parsed.pbxTenantId}_${parsed.extension}`,
        });
        return;
      }
      const family = found.family;
      const cur = await telephony.ami.dbGet(family, "dial", 3_000);
      if (!cur.ok) {
        res.status(404).json({ error: "dial_key_missing", key: `T${parsed.pbxTenantId}_${parsed.extension}` });
        return;
      }
      const transformed = transformDialValue(cur.value, parsed.mobileEndpoint, parsed.enable);
      if (!transformed.ok) {
        res.status(409).json({
          error: transformed.error,
          key: `T${parsed.pbxTenantId}_${parsed.extension}`,
          before: cur.value,
        });
        return;
      }
      if (!transformed.changed) {
        // ⛔ STILL normalise the ring time on this path. Every already-enrolled
        // extension lands here on every auto-enroll cycle — if the ring-time
        // step only ran on the "changed" branch, the 12 extensions enrolled
        // before this shipped would NEVER be repaired, and the fix would only
        // ever reach devices enrolled from now on. That is the difference
        // between "works for everybody" and "works for future signups".
        const ringTimeUnchangedDial = await normalizeFollowMeRingTime(family, parsed.enable);
        if (ringTimeUnchangedDial.changed) {
          console.log(JSON.stringify({
            msg: "wake-dial-publish",
            key: `T${parsed.pbxTenantId}_${parsed.extension}`,
            enable: parsed.enable,
            dialChanged: false,
            ringTime: ringTimeUnchangedDial,
          }));
        }
        res.json({
          ok: true,
          changed: false,
          key: `T${parsed.pbxTenantId}_${parsed.extension}`,
          before: cur.value,
          after: cur.value,
          ringTime: ringTimeUnchangedDial,
        });
        return;
      }
      telephony.ami.sendAction("DBPut", { Family: family, Key: "dial", Val: transformed.value });
      // Read back to verify the write landed (DBPut is fire-and-forget).
      const verify = await telephony.ami.dbGet(family, "dial", 3_000);
      const landed = verify.ok && verify.value === transformed.value;
      if (!landed) {
        res.status(502).json({
          error: "verify_failed",
          key: `T${parsed.pbxTenantId}_${parsed.extension}`,
          before: cur.value,
          expected: transformed.value,
          observed: verify.ok ? verify.value : null,
        });
        return;
      }
      const ringTime = await normalizeFollowMeRingTime(family, parsed.enable);

      console.log(JSON.stringify({
        msg: "wake-dial-publish",
        key: `T${parsed.pbxTenantId}_${parsed.extension}`,
        enable: parsed.enable,
        before: cur.value,
        after: transformed.value,
        ringTime,
      }));
      res.json({
        ok: true,
        changed: true,
        key: `T${parsed.pbxTenantId}_${parsed.extension}`,
        before: cur.value,
        after: transformed.value,
        ringTime,
      });
    } catch (err) {
      res.status(502).json({ error: "ami_error", detail: err instanceof Error ? err.message : String(err) });
    }
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
    // Accept BOTH didmap spellings. Publishes write connect/didmap/<+e164> and
    // connect/didmap/<digits>; this read path only ever built the +e164 form,
    // so a caller verifying the digits family (the one the dialplan reads) got
    // family_scope_mismatch, every key came back empty, and the reconciler
    // concluded the number's menu had "drifted" on EVERY cycle — repairing
    // forever and racing real publishes (2026-08-06).
    let didFamilies: Set<string> | null = null;
    if (didE164 !== undefined && didE164 !== null && didE164 !== "") {
      if (typeof didE164 !== "string" || !/^\+?\d{7,20}$/.test(didE164)) {
        res.status(400).json({ error: "invalid_did_e164" });
        return;
      }
      const digits = didE164.replace(/\D/g, "");
      didFamilies = new Set([`connect/didmap/${didE164}`, `connect/didmap/${digits}`]);
    }
    if (
      typeof family !== "string" ||
      !(family.startsWith(`connect/t_${tenantSlug}`) || (didFamilies !== null && didFamilies.has(family)))
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
