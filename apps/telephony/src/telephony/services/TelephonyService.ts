import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { AmiClient } from "../ami/AmiClient";
import type { AriClient } from "../ari/AriClient";
import { mapAmiFrame } from "../ami/AmiEventMapper";
import type { CallStateStore } from "../state/CallStateStore";
import { isHelperChannel } from "../normalizers/normalizeCallEvent";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import { TenantResolver } from "../state/TenantResolver";
import type { AmiFrame } from "../ami/AmiTypes";
import { inferLiveCallDirection } from "../inferLiveCallDirection";

const log = childLogger("TelephonyService");
const HOLD_DIAGNOSTIC_EVENTS = new Set([
  "Hold",
  "MusicOnHoldStart",
  "MusicOnHoldStop",
  "BridgeEnter",
  "BridgeLeave",
  "Newstate",
  "DialBegin",
  "DialEnd",
]);

// TelephonyService wires raw AMI events → state stores.
// It is the only place where AMI frames are interpreted and state is mutated.

export class TelephonyService {
  private readonly resolver: TenantResolver;
  private readonly outboundMohCache = new Map<string, { value: string; expiresAt: number }>();
  private readonly outboundMohApplied = new Map<string, string>();
  private readonly outboundMohByLinkedId = new Map<string, { tenantId: string; tenantSlug: string; mohClass: string }>();

  constructor(
    private readonly ami: AmiClient,
    private readonly ari: AriClient,
    private readonly calls: CallStateStore,
    private readonly extensions: ExtensionStateStore,
    private readonly queues: QueueStateStore,
    resolverConfig?: ConstructorParameters<typeof TenantResolver>[0],
  ) {
    this.resolver = new TenantResolver(resolverConfig ?? {});
    this.bindAmi();
    this.bindAri();
  }

  getResolver(): TenantResolver {
    return this.resolver;
  }

  private bindAmi(): void {
    // Must register an 'error' handler or Node.js will throw it as uncaught.
    // AMI errors (auth failures, network drops) trigger the internal reconnect
    // loop in AmiClient — the service keeps running and retries with backoff.
    this.ami.on("error", (err) => {
      log.warn({ err: err.message }, "AMI error — will retry with backoff");
    });

    this.ami.on("event", (frame: AmiFrame) => {
      try {
        this.handleAmiFrame(frame);
      } catch (err) {
        log.error({ err, event: frame["Event"] }, "Error processing AMI event");
      }
    });

    this.ami.on("connected", () => {
      log.info("AMI connected — telephony service active");
      // Bootstrap: request all currently active channels so reconnects don't miss ongoing calls.
      // 500ms delay lets AMI finish its initial burst of FullyBooted/status events first.
      setTimeout(() => this.bootstrapActiveChannels(), 500);
      setTimeout(() => this.bootstrapExtensionPresence(), 1000);
      // Re-run extension presence at 6s and 18s after connect.
      // When the telephony and API containers restart together the PbxTenantMapCache
      // HTTP request to the API may fail on the first attempt (API not ready yet).
      // The first bootstrap at 1s would then store all extension states with
      // tenantId=null, making BLF invisible to non-admin users.  The re-runs below
      // fire after the map cache has had time to load, ensuring correct tenantId
      // resolution even when the API was slow or temporarily unavailable.
      setTimeout(() => { if (this.ami._isConnected) this.bootstrapExtensionPresence(); }, 6_000);
      setTimeout(() => { if (this.ami._isConnected) this.bootstrapExtensionPresence(); }, 18_000);
    });

    this.ami.on("disconnected", (reason) => {
      log.warn({ reason }, "AMI disconnected — clearing call state to avoid ghosts");
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ reason }, "live_call: disconnect_clearAll_triggered");
      }
      this.calls.clearAll();
    });
  }

  private bootstrapActiveChannels(): void {
    try {
      this.ami.sendAction("CoreShowChannels");
      log.info("AMI bootstrap: CoreShowChannels sent — seeding active channels");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "AMI bootstrap: CoreShowChannels failed (service may be starting)");
    }
  }

  private bootstrapExtensionPresence(): void {
    this.refreshExtensionPresence();
  }

  /** Publicly callable: re-sends ExtensionStateList + PJSIPShowContacts to the PBX
   *  so the extension store is re-populated with current tenantId-resolved states.
   *  Safe to call at any time (no-op when AMI is not connected). */
  refreshExtensionPresence(): void {
    if (!this.ami._isConnected) return;
    try {
      this.ami.sendAction("ExtensionStateList");
      this.ami.sendAction("PJSIPShowContacts");
      log.info("AMI: ExtensionStateList/PJSIPShowContacts sent — refreshing BLF/presence state");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "AMI: BLF presence refresh failed");
    }
  }

  private bindAri(): void {
    // Must register an 'error' handler or Node.js will throw it as uncaught.
    this.ari.on("error", (err) => {
      log.warn({ err: err.message }, "ARI REST error — service continues on AMI only");
    });

    // REST health probe events (replaces WebSocket connect/disconnect events).
    this.ari.on("rest:healthy", () => {
      log.info("ARI REST probe healthy");
    });

    this.ari.on("rest:unhealthy", (err) => {
      log.warn({ err: err.message }, "ARI REST probe unhealthy — call-control actions may fail");
    });
  }

  private handleAmiFrame(frame: AmiFrame): void {
    this.handleHoldDiagnosticFrame(frame).catch((err) => {
      log.warn(
        {
          err: err?.message,
          event: frame["Event"],
          linkedId: frame["Linkedid"] || frame["LinkedID"],
          channel: frame["Channel"],
        },
        "hold_moh_diag: failed",
      );
    });

    // Intercept VarSet events that carry the recording filename set by the PBX
    // dialplan (VitalPBX sets both __REC_FILENAME and MIXMONITOR_FILENAME around
    // the MixMonitor() invocation). The final path (with tenant-hash directory)
    // is the one we want to keep — CallStateStore.setRecordingPath prefers the
    // longer variant when multiple fire.
    if (frame["Event"] === "VarSet") {
      const variable = frame["Variable"] ?? "";
      if (variable === "MIXMONITOR_FILENAME" || variable === "__REC_FILENAME") {
        const linkedid = frame["Linkedid"] || frame["LinkedID"] || frame["Uniqueid"] || "";
        const value = (frame["Value"] ?? "").trim();
        log.info(
          { variable, linkedid, uniqueid: frame["Uniqueid"], channel: frame["Channel"], path: value },
          "recording: mixmonitor_varset",
        );
        if (linkedid && value) {
          this.calls.setRecordingPath(linkedid, value);
        }
      }
    }

    const typed = mapAmiFrame(frame);
    if (!typed) return;

    if (env.ENABLE_TELEPHONY_DEBUG || env.ENABLE_BLF_DEBUG) {
      log.debug(
        { event: typed.event, linkedid: (typed as { linkedid?: string }).linkedid, uniqueid: (typed as { uniqueid?: string }).uniqueid },
        "live_call: event_received",
      );
    }

    switch (typed.event) {
      // CoreShowChannel arrives in response to our CoreShowChannels bootstrap action.
      // Treat it exactly like Newchannel to seed the call store with pre-existing calls.
      case "CoreShowChannel":
      case "Newchannel": {
        const linkedId = effectiveLinkedId(typed.linkedid, typed.uniqueid);
        const isHelper = isHelperChannel(typed.channel);
        const linkedIdEmpty = !(typed.linkedid ?? "").trim();
        if (linkedIdEmpty && isHelper) {
          log.debug({ channel: typed.channel }, "PIPE: helper_channel_skipped (no linkedid)");
          break;
        }
        const tres = this.resolver.resolveDetails({
          channel: typed.channel,
          context: typed.context,
          callerIdNum: typed.callerIDNum,
          exten: typed.exten,
          toNumber: typed.exten,
          fromNumber: typed.callerIDNum,
        });
        // Always log at info so we can trace every call even without debug mode
        log.info(
          {
            event: typed.event,
            linkedId,
            channel: typed.channel,
            context: typed.context,
            exten: typed.exten,
            callerIDNum: typed.callerIDNum,
            tenantId: tres.tenantId,
            tenantName: tres.tenantName,
            pbxCode: tres.pbxTenantCode,
          },
          tres.tenantId != null
            ? "PIPE[1/6]: channel_received tenant_resolved"
            : "PIPE[1/6]: channel_received tenant_UNRESOLVED",
        );
        const direction = inferLiveCallDirection(typed.context, typed.exten, typed.callerIDNum);
        const call = this.calls.upsertFromNewchannel({
          linkedId,
          uniqueid: typed.uniqueid,
          channel: typed.channel,
          channelState: typed.channelState,
          callerIDNum: typed.callerIDNum,
          callerIDName: typed.callerIDName,
          connectedLineNum: typed.connectedLineNum,
          connectedLineName: typed.connectedLineName,
          context: typed.context,
          exten: typed.exten,
          tenantId: tres.tenantId,
          tenantName: tres.tenantName ?? null,
          pbxVitalTenantId: tres.pbxVitalTenantId,
          pbxTenantCode: tres.pbxTenantCode,
          direction,
        });
        this.applyCachedOutboundMohToChannel(linkedId, typed.channel, call.extensions[0] ?? typed.callerIDNum);
        break;
      }

      case "Newstate": {
        const linkedId = effectiveLinkedId(typed.linkedid, typed.uniqueid);
        this.calls.updateChannelState({
          linkedId,
          uniqueid: typed.uniqueid,
          channelState: typed.channelState,
          connectedLineNum: typed.connectedLineNum,
        });
        break;
      }

      case "DialBegin": {
        const dialLinkedId = effectiveLinkedId(typed.linkedid, typed.uniqueid);
        this.calls.onDialBegin({
          linkedId: dialLinkedId,
          callerIDNum: typed.callerIDNum,
          destination: typed.destination,
        });
        this.applyOutboundMohOnDialBegin(typed).catch((err) => {
          log.warn(
            {
              err: err?.message,
              linkedId: dialLinkedId,
              channel: typed.channel,
              destination: typed.destination,
            },
            "outbound_moh: apply failed",
          );
        });
        log.debug(
          { linkedId: dialLinkedId, dest: typed.destination },
          "DialBegin",
        );
        break;
      }

      case "DialEnd": {
        log.debug(
          { linkedId: typed.linkedid, status: typed.dialStatus },
          "DialEnd",
        );
        break;
      }

      case "BridgeEnter": {
        const bridgeLinkedId = effectiveLinkedId(typed.linkedid, typed.uniqueid);
        this.calls.onBridgeEnter({
          linkedId: bridgeLinkedId,
          uniqueid: typed.uniqueid,
          bridgeId: typed.bridgeUniqueid,
          bridgeNumChannels: typed.bridgeNumChannels,
        });
        log.debug(
          { linkedId: bridgeLinkedId, bridge: typed.bridgeUniqueid },
          "BridgeEnter",
        );
        break;
      }

      case "BridgeLeave": {
        this.calls.onBridgeLeave({
          linkedId: effectiveLinkedId(typed.linkedid, typed.uniqueid),
          bridgeId: typed.bridgeUniqueid,
        });
        break;
      }

      case "Hangup": {
        const hangupLinkedId = effectiveLinkedId(typed.linkedid, typed.uniqueid);
        this.calls.onHangup({
          linkedId: hangupLinkedId,
          uniqueid: typed.uniqueid,
          channel: typed.channel,
          cause: typed.cause,
        });
        log.debug(
          {
            linkedId: hangupLinkedId,
            channel: typed.channel,
            cause: `${typed.cause} ${typed.causeTxt}`,
          },
          "Hangup",
        );
        break;
      }

      case "Cdr": {
        this.calls.onCdr({
          linkedId: effectiveLinkedId(typed.linkedid, typed.uniqueid),
          duration: typed.duration,
          billableSeconds: typed.billableSeconds,
          disposition: typed.disposition,
          source: typed.source,
          destination: typed.destination,
          dcontext: typed.dcontext,
          accountCode: typed.accountCode,
          channel: typed.channel,
        });
        break;
      }

      case "QueueCallerJoin": {
        const tenantId = this.resolver.resolve({
          channel: typed.channel,
          callerIdNum: typed.callerIDNum,
        });
        this.calls.onQueueJoin({
          linkedId: effectiveLinkedId(typed.linkedid, typed.uniqueid),
          queue: typed.queue,
        });
        this.queues.onCallerJoin({ queue: typed.queue, tenantId });
        log.debug({ queue: typed.queue, linkedId: typed.linkedid }, "QueueCallerJoin");
        break;
      }

      case "QueueCallerLeave": {
        const tenantId = this.resolver.resolve({ channel: typed.channel });
        this.queues.onCallerLeave({ queue: typed.queue, tenantId });
        break;
      }

      case "QueueMemberStatus": {
        const tenantId = this.resolver.resolve({ channel: typed.interface });
        this.queues.onMemberStatus({
          queue: typed.queue,
          memberName: typed.memberName,
          interface: typed.interface,
          status: typed.status,
          paused: typed.paused,
          pausedReason: typed.pausedReason,
          callsTaken: typed.callsTaken,
          lastCall: typed.lastCall,
          tenantId,
        });
        break;
      }

      case "QueueMemberPaused": {
        this.queues.onMemberPaused({
          queue: typed.queue,
          interface: typed.interface,
          paused: typed.paused,
          pausedReason: typed.pausedReason,
        });
        break;
      }

      case "ExtensionStatus": {
        const tenantId = this.resolver.resolve({
          exten: typed.exten,
          context: typed.context,
        });
        this.extensions.onExtensionStatus({
          exten: typed.exten,
          context: typed.context,
          hint: typed.hint,
          status: typed.status,
          statusText: typed.statusText,
          tenantId,
        });
        break;
      }

      case "DeviceStateChange": {
        const tenantId = this.resolver.resolve({ channel: typed.device });
        this.extensions.onDeviceStateChange({
          device: typed.device,
          state: typed.state,
          tenantId,
        });
        break;
      }

      case "PeerStatus": {
        const tenantId = this.resolver.resolve({ channel: typed.peer });
        this.extensions.onPeerStatus({
          peer: typed.peer,
          peerStatus: typed.peerStatus,
          tenantId,
        });
        break;
      }

      case "ContactStatus": {
        const tenantId = this.resolver.resolve({ channel: typed.aor });
        this.extensions.onPeerStatus({
          peer: `PJSIP/${typed.aor}`,
          peerStatus: contactStatusToPeerStatus(typed.contactStatus),
          tenantId,
        });
        break;
      }

      case "AttendedTransfer": {
        // Merge the transferee leg into the originator's linkedId
        if (
          typed.origTransfererLinkedid &&
          typed.transfereeLinkedid &&
          typed.origTransfererLinkedid !== typed.transfereeLinkedid
        ) {
          this.calls.onTransfer({
            survivingLinkedId: typed.origTransfererLinkedid,
            obsoleteLinkedId: typed.transfereeLinkedid,
          });
        }
        log.info(
          { result: typed.result },
          "AttendedTransfer",
        );
        break;
      }

      case "BlindTransfer": {
        log.info(
          { from: typed.transfererLinkedid, result: typed.result },
          "BlindTransfer",
        );
        break;
      }

      case "MessageWaiting": {
        // New voicemail deposited: trigger near-realtime sync for this mailbox.
        // Only fire when at least one new (unheard) message arrived to avoid
        // unnecessary API calls on "mailbox read" notifications.
        const newCount = parseInt(typed.new, 10) || 0;
        if (newCount > 0) {
          const atIdx = typed.mailbox.indexOf("@");
          const mailbox = atIdx >= 0 ? typed.mailbox.slice(0, atIdx) : typed.mailbox;
          const context = atIdx >= 0 ? typed.mailbox.slice(atIdx + 1) : "default";
          if (mailbox) {
            log.info({ mailbox, context, new: typed.new }, "MessageWaiting: triggering voicemail sync");
            this.notifyVoicemail(mailbox, context).catch((err: Error) => {
              log.warn({ err: err?.message, mailbox }, "voicemail notify failed (non-fatal)");
            });
          }
        }
        break;
      }
    }
  }

  /** POST to the API voicemail-notify endpoint so the API can immediately ingest
   *  new voicemail records for the given mailbox without waiting for the next
   *  worker poll cycle (~5 min). Uses the same CDR ingest URL + secret. */
  private async notifyVoicemail(mailbox: string, context: string): Promise<void> {
    const baseUrl = env.CDR_INGEST_URL?.replace(/\/internal\/cdr-ingest$/, "");
    if (!baseUrl) return; // CDR_INGEST_URL not configured — skip silently
    const url = `${baseUrl}/internal/voicemail-notify`;
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.CDR_INGEST_SECRET ? { "x-cdr-secret": env.CDR_INGEST_SECRET } : {}),
      },
      body: JSON.stringify({ mailbox, context }),
      signal: AbortSignal.timeout(5000),
    });
  }

  // Originate a call via AMI (no dialplan modification needed)
  async originateCall(params: {
    channel: string;
    exten: string;
    context: string;
    priority?: string;
    callerID?: string;
    timeout?: number;
    variables?: Record<string, string>;
  }): Promise<string> {
    const fields: Record<string, string> = {
      Channel: params.channel,
      Exten: params.exten,
      Context: params.context,
      Priority: params.priority ?? "1",
      Timeout: String((params.timeout ?? 30) * 1000),
    };
    if (params.callerID) fields["CallerID"] = params.callerID;
    if (params.variables) {
      for (const [k, v] of Object.entries(params.variables)) {
        fields[`Variable`] = `${k}=${v}`;
      }
    }
    const actionId = this.ami.sendAction("Originate", fields);
    log.info({ channel: params.channel, exten: params.exten }, "AMI Originate sent");
    return actionId;
  }

  private async applyOutboundMohOnDialBegin(event: {
    channel: string;
    destination: string;
    callerIDNum: string;
    dialString: string;
    linkedid: string;
  }): Promise<void> {
    if (!this.isExtensionOriginatedOutbound(event)) return;

    const resolved = this.resolver.resolveDetails({
      channel: event.channel,
      callerIdNum: event.callerIDNum,
      toNumber: event.dialString || event.destination,
      fromNumber: event.callerIDNum,
    });
    if (!resolved.tenantId || !resolved.tenantName) {
      log.debug(
        {
          channel: event.channel,
          callerIDNum: event.callerIDNum,
          destination: event.destination,
          tenantId: resolved.tenantId,
        },
        "outbound_moh: tenant unresolved or unnamed",
      );
      return;
    }

    const tenantSlug = toConnectAstDbSlug(resolved.tenantName);
    const mohClass = await this.getTenantMohClass(tenantSlug);
    if (!mohClass) {
      log.debug({ tenantSlug, tenantId: resolved.tenantId }, "outbound_moh: no tenant MOH class");
      return;
    }

    this.outboundMohByLinkedId.set(event.linkedid, {
      tenantId: resolved.tenantId,
      tenantSlug,
      mohClass,
    });
    if (this.outboundMohByLinkedId.size > 2_000) this.outboundMohByLinkedId.clear();

    const call = this.calls.getById(event.linkedid);
    const channels = uniqueStrings([event.channel, event.destination, ...(call?.channels ?? [])]);
    for (const channel of channels) {
      this.setChannelMusicClass(channel, mohClass, {
        tenantId: resolved.tenantId,
        tenantSlug,
        callerIDNum: event.callerIDNum,
        linkedId: event.linkedid,
      });
    }
  }

  private async handleHoldDiagnosticFrame(frame: AmiFrame): Promise<void> {
    const eventName = frame["Event"] ?? "";
    if (!HOLD_DIAGNOSTIC_EVENTS.has(eventName)) return;

    const channel = frame["Channel"] ?? frame["DestChannel"] ?? "";
    const uniqueid = frame["Uniqueid"] ?? frame["UniqueID"] ?? "";
    const linkedId = effectiveLinkedId(frame["Linkedid"] || frame["LinkedID"] || uniqueid, uniqueid);
    const call = this.calls.getById(linkedId) ?? (uniqueid ? this.calls.getByChannelId(uniqueid) : undefined);
    const resolved = this.resolveTenantForAmiFrame(frame, call);

    let mohClass = "";
    let appliedChannels: string[] = [];
    if (
      (eventName === "Hold" || eventName === "MusicOnHoldStart") &&
      resolved.tenantId &&
      resolved.tenantSlug
    ) {
      mohClass = await this.getTenantMohClass(resolved.tenantSlug);
      if (mohClass) {
        const channels = uniqueStrings([channel, ...(call?.channels ?? [])]);
        for (const ch of channels) {
          this.setChannelMusicClass(ch, mohClass, {
            tenantId: resolved.tenantId,
            tenantSlug: resolved.tenantSlug,
            callerIDNum: frame["CallerIDNum"] ?? call?.from ?? "",
            linkedId,
          });
        }
        appliedChannels = channels;
        this.outboundMohByLinkedId.set(linkedId, {
          tenantId: resolved.tenantId,
          tenantSlug: resolved.tenantSlug,
          mohClass,
        });
      }
    }

    const channelMusicClass = channel
      ? await this.ami.getVar(channel, "CHANNEL(musicclass)", 800)
          .then((r) => (r.ok ? r.value : ""))
          .catch(() => "")
      : "";

    log.info(
      {
        event: eventName,
        channel,
        bridgedChannel: frame["BridgedChannel"] ?? frame["DestChannel"] ?? "",
        bridgeUniqueid: frame["BridgeUniqueid"] ?? frame["BridgeUniqueId"] ?? "",
        bridgeType: frame["BridgeType"] ?? "",
        linkedId,
        uniqueid,
        callerIDNum: frame["CallerIDNum"] ?? call?.from ?? "",
        connectedLineNum: frame["ConnectedLineNum"] ?? call?.connectedLine ?? "",
        tenantId: resolved.tenantId,
        tenantName: resolved.tenantName,
        tenantSlug: resolved.tenantSlug,
        extension: resolved.extension,
        channelMusicClass,
        eventMohClass: frame["Class"] ?? frame["MusicClass"] ?? frame["MOHClass"] ?? "",
        appliedMohClass: mohClass,
        appliedChannels,
        context: frame["Context"] ?? "",
        exten: frame["Exten"] ?? "",
        application: frame["Application"] ?? "",
        appData: frame["AppData"] ?? "",
        channelRole: classifyPbxChannel(channel),
      },
      "hold_moh_diag",
    );
  }

  private resolveTenantForAmiFrame(
    frame: AmiFrame,
    call: ReturnType<CallStateStore["getById"]> | undefined,
  ): { tenantId: string | null; tenantName: string | null; tenantSlug: string | null; extension: string | null } {
    const channel = frame["Channel"] ?? frame["DestChannel"] ?? "";
    const extension = normalizeExtensionCandidate(frame["CallerIDNum"])
      ?? normalizeExtensionCandidate(frame["Exten"])
      ?? normalizeExtensionFromPbxChannel(channel)
      ?? call?.extensions[0]
      ?? null;

    if (call?.tenantId && call.tenantName) {
      return {
        tenantId: call.tenantId,
        tenantName: call.tenantName,
        tenantSlug: toConnectAstDbSlug(call.tenantName),
        extension,
      };
    }

    const resolved = this.resolver.resolveDetails({
      channel,
      context: frame["Context"],
      callerIdNum: frame["CallerIDNum"],
      exten: frame["Exten"],
      toNumber: frame["ConnectedLineNum"] || frame["Exten"],
      fromNumber: frame["CallerIDNum"],
    });
    return {
      tenantId: resolved.tenantId,
      tenantName: resolved.tenantName,
      tenantSlug: resolved.tenantName ? toConnectAstDbSlug(resolved.tenantName) : null,
      extension,
    };
  }

  private applyCachedOutboundMohToChannel(linkedId: string, channel: string, callerIDNum: string): void {
    const cached = this.outboundMohByLinkedId.get(linkedId);
    if (!cached) return;
    this.setChannelMusicClass(channel, cached.mohClass, {
      tenantId: cached.tenantId,
      tenantSlug: cached.tenantSlug,
      callerIDNum,
      linkedId,
    });
  }

  private isExtensionOriginatedOutbound(event: {
    channel: string;
    destination: string;
    callerIDNum: string;
    dialString: string;
  }): boolean {
    const caller = (event.callerIDNum || "").replace(/\D/g, "");
    const called = `${event.dialString || ""} ${event.destination || ""}`.replace(/\D/g, "");
    const channelLooksLikeTenantExtension = /^PJSIP\/T\d+_\d+/i.test(event.channel || "");
    const callerLooksLikeExtension = caller.length >= 2 && caller.length <= 6;
    const calledLooksExternal = called.length >= 7;
    return (channelLooksLikeTenantExtension || callerLooksLikeExtension) && calledLooksExternal;
  }

  private async getTenantMohClass(tenantSlug: string): Promise<string> {
    const now = Date.now();
    const cached = this.outboundMohCache.get(tenantSlug);
    if (cached && cached.expiresAt > now) return cached.value;

    const family = `connect/t_${tenantSlug}`;
    let value = "";
    const runtime = await this.ami.dbGet(family, "moh_class", 1_000).catch(() => ({ ok: false as const }));
    if (runtime.ok) value = runtime.value.trim();
    if (!value) {
      const legacy = await this.ami.dbGet(family, "active_moh_class", 1_000).catch(() => ({ ok: false as const }));
      if (legacy.ok) value = legacy.value.trim();
    }

    this.outboundMohCache.set(tenantSlug, { value, expiresAt: now + 30_000 });
    return value;
  }

  private setChannelMusicClass(
    channel: string,
    mohClass: string,
    context: { tenantId: string; tenantSlug: string; callerIDNum: string; linkedId: string },
  ): void {
    if (!channel || !mohClass) return;
    if (this.outboundMohApplied.get(channel) === mohClass) return;
    this.outboundMohApplied.set(channel, mohClass);
    if (this.outboundMohApplied.size > 2_000) this.outboundMohApplied.clear();

    this.ami.sendAction("Setvar", {
      Channel: channel,
      Variable: "CHANNEL(musicclass)",
      Value: mohClass,
    });
    log.info(
      {
        ...context,
        channel,
        mohClass,
      },
      "outbound_moh: channel musicclass applied",
    );
  }

  // Hangup a channel by Uniqueid (not linkedId) via AMI
  async hangupChannel(uniqueid: string): Promise<string> {
    const actionId = this.ami.sendAction("Hangup", {
      Channel: uniqueid,
      Cause: "16",
    });
    log.info({ uniqueid }, "AMI Hangup sent");
    return actionId;
  }

  // Redirect (blind transfer) a channel via AMI
  async redirectChannel(params: {
    channel: string;
    exten: string;
    context: string;
    priority?: string;
  }): Promise<string> {
    const actionId = this.ami.sendAction("Redirect", {
      Channel: params.channel,
      Exten: params.exten,
      Context: params.context,
      Priority: params.priority ?? "1",
    });
    log.info({ channel: params.channel, dest: params.exten }, "AMI Redirect sent");
    return actionId;
  }

  async requeueLiveCallToDialplan(params: {
    linkedId: string;
    fallbackExten?: string;
    fallbackContext?: string;
  }): Promise<{
    actionId: string | null;
    channel: string | null;
    exten: string | null;
    context: string | null;
    skipped: boolean;
    skipReason?: string;
  }> {
    const call = this.calls.getById(params.linkedId);
    if (!call || call.state === "hungup") {
      throw new Error(`active call not found for linkedId=${params.linkedId}`);
    }

    // CRITICAL: If the call is already answered (Asterisk has bridged the legs
    // because the called party sent SIP 200 OK), an AMI Redirect at this point
    // would TEAR DOWN the working bridge and re-enter the dialplan from
    // (lastContext, lastExten, 1) — which for inbound DID→IVR→ext is the DID
    // number inside T<id>_cos-all, i.e. an outbound dial back through the
    // trunk that loops the caller right back into the IVR they came from.
    //
    // The mobile app's `/respond` POST only signals "user tapped Answer" for
    // bookkeeping. The actual call is established by the SIP 200 OK from the
    // mobile's PJSIP/WebRTC endpoint; no AMI action is required to bridge it.
    //
    // The requeue is only meaningful while the trunk caller leg is parked or
    // still in the IVR/Local-channel pre-answer phase. Once the call is up,
    // skipping is the correct, safe behavior.
    //
    // See: Connect 2 incident 2026-05-04 — external IVR→mobile calls
    //      reproduced "answer then bounce back to IVR".
    if (call.state === "up" || call.answeredAt) {
      log.info(
        {
          linkedId: params.linkedId,
          state: call.state,
          answeredAt: call.answeredAt,
          channels: call.channels,
        },
        "mobile invite requeue skipped — call already bridged",
      );
      return {
        actionId: null,
        channel: null,
        exten: null,
        context: null,
        skipped: true,
        skipReason: "call_already_bridged",
      };
    }

    const channel = call.channels.find((name) => !isHelperChannel(name));
    if (!channel) {
      throw new Error(`no redirectable channel found for linkedId=${params.linkedId}`);
    }

    const context =
      (typeof call.metadata["lastContext"] === "string" && call.metadata["lastContext"]) ||
      params.fallbackContext ||
      "";
    const exten =
      (typeof call.metadata["lastExten"] === "string" && call.metadata["lastExten"]) ||
      params.fallbackExten ||
      "";

    if (!context || !exten) {
      throw new Error(`missing dialplan target for linkedId=${params.linkedId}`);
    }

    const actionId = await this.redirectChannel({
      channel,
      exten,
      context,
    });
    log.info({ linkedId: params.linkedId, channel, exten, context, actionId }, "AMI mobile invite requeue sent");
    return { actionId, channel, exten, context, skipped: false };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Use linkedId when non-empty; else uniqueid so we never key calls by "". */
function effectiveLinkedId(linkedid: string, uniqueid: string): string {
  const id = (linkedid ?? "").trim();
  return id.length > 0 ? id : uniqueid;
}

function toConnectAstDbSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = (value || "").trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeExtensionCandidate(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 2 && digits.length <= 6 ? digits : null;
}

function normalizeExtensionFromPbxChannel(channel: string): string | null {
  const match = /^PJSIP\/T\d+_(\d{2,6})(?:[-/@]|$)/i.exec(channel || "");
  return match?.[1] ?? null;
}

function classifyPbxChannel(channel: string): string {
  if (/^PJSIP\/T\d+_\d+/i.test(channel)) return "tenant-extension-leg";
  if (/^PJSIP\/\d+_/i.test(channel)) return "trunk-leg";
  if (/^Local\//i.test(channel)) return "local-channel";
  if (/parking/i.test(channel)) return "parking";
  if (/^Message\//i.test(channel)) return "message-helper";
  return channel ? "other" : "unknown";
}

function contactStatusToPeerStatus(contactStatus: string): string {
  const status = String(contactStatus || "").trim().toLowerCase();
  if (status === "removed" || status === "deleted") return "Unregistered";
  if (status === "unreachable") return "Unreachable";
  // PJSIP contacts can be registered without an active qualify measurement.
  // Treat contact-present states as online so BLF does not show Offline just
  // because qualify is disabled, delayed, or not yet measured after restart.
  if (
    status === "reachable" ||
    status === "nonqualified" ||
    status === "non-qualified" ||
    status === "unknown" ||
    status === "created" ||
    status === "available"
  ) {
    return "Registered";
  }
  return "unknown";
}
