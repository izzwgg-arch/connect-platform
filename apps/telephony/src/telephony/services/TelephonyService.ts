import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { AmiClient } from "../ami/AmiClient";
import type { AriClient } from "../ari/AriClient";
import { mapAmiFrame } from "../ami/AmiEventMapper";
import type { CallStateStore } from "../state/CallStateStore";
import { isExtensionLegChannel } from "../state/CallStateStore";
import { AorContactRegistry } from "../state/AorContactRegistry";
import { isHelperChannel } from "../normalizers/normalizeCallEvent";
import type { ExtensionStateStore } from "../state/ExtensionStateStore";
import type { QueueStateStore } from "../state/QueueStateStore";
import { TenantResolver } from "../state/TenantResolver";
import type { AmiFrame } from "../ami/AmiTypes";
import { inferLiveCallDirection } from "../inferLiveCallDirection";
import {
  RegistrationStatusNotifier,
  normalizeContactStatus,
  normalizePeerStatus,
} from "./RegistrationStatusNotifier";

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
  /** Cleared on AMI disconnect to avoid stacked bootstraps across reconnect churn. */
  private amiBootstrapTimers: NodeJS.Timeout[] = [];
  /** Forwards pjsip endpoint registration state to the API for per-device tracking. */
  private readonly regNotifier = new RegistrationStatusNotifier();
  /**
   * Minimal per-AOR contact registry fed by the ContactStatus AMI stream — the
   * only state the Mode-B cold-answer requeue needs to detect a contact that
   * (re)registered AFTER the stale extension leg was dialed. Public readonly so
   * the requeue-gate tests can seed contact observations directly.
   */
  readonly contactRegistry = new AorContactRegistry();

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
      this.clearAmiBootstrapTimers();
      log.info(
        {
          msg: "pbx_resubscribe_start",
          subsystem: "AMI_BOOTSTRAP",
          actions: ["CoreShowChannels", "ExtensionStateList", "PJSIPShowContacts"],
        },
        "pbx_resubscribe_start",
      );
      // Bootstrap: request all currently active channels so reconnects don't miss ongoing calls.
      // 500ms delay lets AMI finish its initial burst of FullyBooted/status events first.
      this.amiBootstrapTimers.push(
        setTimeout(() => {
          this.bootstrapActiveChannels();
        }, 500),
      );
      this.amiBootstrapTimers.push(
        setTimeout(() => {
          this.bootstrapExtensionPresence();
        }, 1000),
      );
      this.amiBootstrapTimers.push(
        setTimeout(() => {
          if (this.ami._isConnected) {
            log.info({ msg: "pbx_resubscribe_success", subsystem: "AMI_BOOTSTRAP" }, "pbx_resubscribe_success");
          }
        }, 1_500),
      );
      // Re-run extension presence at 6s and 18s after connect.
      // When the telephony and API containers restart together the PbxTenantMapCache
      // HTTP request to the API may fail on the first attempt (API not ready yet).
      // The first bootstrap at 1s would then store all extension states with
      // tenantId=null, making BLF invisible to non-admin users.  The re-runs below
      // fire after the map cache has had time to load, ensuring correct tenantId
      // resolution even when the API was slow or temporarily unavailable.
      this.amiBootstrapTimers.push(
        setTimeout(() => {
          if (this.ami._isConnected) this.bootstrapExtensionPresence();
        }, 6_000),
      );
      this.amiBootstrapTimers.push(
        setTimeout(() => {
          if (this.ami._isConnected) this.bootstrapExtensionPresence();
        }, 18_000),
      );
    });

    this.ami.on("disconnected", (reason) => {
      this.clearAmiBootstrapTimers();
      log.warn({ reason }, "AMI disconnected — clearing call state to avoid ghosts");
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ reason }, "live_call: disconnect_clearAll_triggered");
      }
      this.calls.clearAll();
    });
  }

  private clearAmiBootstrapTimers(): void {
    for (const t of this.amiBootstrapTimers) {
      clearTimeout(t);
    }
    this.amiBootstrapTimers = [];
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
      log.info(
        {
          msg: "pbx_resubscribe_success",
          subsystem: "ARI_REST",
          note: "REST call-control + bridged poller path usable again",
        },
        "pbx_resubscribe_success",
      );
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
            tenantSlug: tres.tenantSlug,
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
          tenantSlug: tres.tenantSlug,
          tenantName: tres.tenantName ?? null,
          pbxVitalTenantId: tres.pbxVitalTenantId,
          pbxTenantCode: tres.pbxTenantCode,
          direction,
        });
        this.applyCachedOutboundMohToChannel(linkedId, typed.channel, call.extensions[0] ?? typed.callerIDNum);
        break;
      }

      case "NewCallerid": {
        this.calls.onNewCallerid({
          linkedId: effectiveLinkedId(typed.linkedid, typed.uniqueid),
          uniqueid: typed.uniqueid,
          callerIDName: typed.callerIDName,
        });
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
          channel: typed.channel,
          context: typed.context,
          exten: typed.exten,
          dialString: typed.dialString,
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
          uniqueid: typed.uniqueid,
          duration: typed.duration,
          billableSeconds: typed.billableSeconds,
          disposition: typed.disposition,
          source: typed.source,
          destination: typed.destination,
          dcontext: typed.dcontext,
          accountCode: typed.accountCode,
          channel: typed.channel,
          destChannel: typed.destChannel,
          lastApplication: typed.lastApplication,
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
        // Forward per-endpoint registration state to the API. PeerStatus.peer
        // is "PJSIP/T25_101_1" — strip the tech prefix to get the endpoint.
        this.regNotifier.notify({
          endpoint: String(typed.peer || "").replace(/^PJSIP\//i, ""),
          normalizedStatus: normalizePeerStatus(typed.peerStatus),
          rawStatus: typed.peerStatus,
          tenantId,
          source: "ami_peerstatus",
        });
        break;
      }

      case "ContactStatus": {
        const tenantId = this.resolver.resolve({ channel: typed.aor });
        // MODE-B (2026-06-29): persist the AOR→contact registration time so the
        // cold-answer requeue can tell a freshly re-registered contact from the
        // (stale) contact(s) the leg was dialed to. Read-only bookkeeping.
        this.contactRegistry.record(typed.aor, typed.uri, typed.contactStatus, Date.now());
        this.extensions.onPeerStatus({
          peer: `PJSIP/${typed.aor}`,
          peerStatus: contactStatusToPeerStatus(typed.contactStatus),
          tenantId,
        });
        // Authoritative per-device signal: the AOR (e.g. "T25_101_1") maps 1:1
        // to a single mobile/WebRTC device endpoint.
        this.regNotifier.notify({
          endpoint: String(typed.aor || ""),
          normalizedStatus: normalizeContactStatus(typed.contactStatus),
          rawStatus: typed.contactStatus,
          contactUri: typed.uri,
          userAgent: typed.userAgent,
          roundtripUsec: typed.roundtripUsec,
          tenantId,
          source: "ami_contactstatus",
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
            this.notifyVoicemail(mailbox, context, newCount).catch((err: Error) => {
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
  private async notifyVoicemail(mailbox: string, context: string, newCount: number): Promise<void> {
    const baseUrl = env.CDR_INGEST_URL?.replace(/\/internal\/cdr-ingest$/, "");
    if (!baseUrl) return; // CDR_INGEST_URL not configured — skip silently
    const url = `${baseUrl}/internal/voicemail-notify`;
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.CDR_INGEST_SECRET ? { "x-cdr-secret": env.CDR_INGEST_SECRET } : {}),
      },
      body: JSON.stringify({ mailbox, context, newCount }),
      signal: AbortSignal.timeout(12_000),
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
    /**
     * Why the API asked for this requeue (e.g. `device_register_complete` /
     * `invite_accept`). Currently accepted for forward-compatibility and
     * logging only — the gate intentionally does NOT branch on it (a
     * trigger-keyed bypass broke Android; see the note in the gate below).
     */
    trigger?: string;
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

    // CRITICAL: If a tenant-extension leg has already answered (Asterisk has
    // bridged the trunk leg with the extension's PJSIP/WebRTC endpoint that
    // sent SIP 200 OK), an AMI Redirect at this point would TEAR DOWN the
    // working bridge and re-enter the dialplan from (lastContext, lastExten, 1)
    // — which for inbound DID→IVR→ext is the DID number inside T<id>_cos-all,
    // i.e. an outbound dial back through the trunk that loops the caller right
    // back into the IVR they came from.
    //
    // The mobile app's `/respond` POST only signals "user tapped Answer" for
    // bookkeeping. The actual call is established by the SIP 200 OK from the
    // mobile's PJSIP/WebRTC endpoint; no AMI action is required to bridge it.
    //
    // We MUST gate on `extensionAnsweredAt` (set only when an extension leg
    // goes Up), NOT `state === "up"` or `answeredAt`. Both of those are tripped
    // by the inbound trunk leg's IVR `Answer()` to play a greeting — which
    // happens 5–30 seconds before the extension is even rung in DID→IVR→ext
    // flows. Using the looser gate previously caused mobile cold-start answer
    // attempts to be silently dropped: the mobile sees "user tapped Answer"
    // but no SIP INVITE ever arrives because the requeue refused to redirect
    // the trunk leg into the extension's hunt group.
    //
    // See: Connect 2 incident 2026-05-04 — external IVR→mobile calls
    //      reproduced "answer then bounce back to IVR" (old over-eager gate),
    //      then "answer but never connects" (gate refused legitimate requeue
    //      because trunk leg's IVR Answer() looked like an extension answer).
    if (call.extensionAnsweredAt) {
      log.info(
        {
          linkedId: params.linkedId,
          state: call.state,
          answeredAt: call.answeredAt,
          extensionAnsweredAt: call.extensionAnsweredAt,
          channels: call.channels,
        },
        "mobile invite requeue skipped — extension already answered",
      );
      return {
        actionId: null,
        channel: null,
        exten: null,
        context: null,
        skipped: true,
        skipReason: "extension_already_answered",
      };
    }

    // CRITICAL: If an extension leg is ALREADY LIVE on this call (a real
    // `PJSIP/T<id>_<exten>...` channel is currently ringing or up), the original
    // Dial() already delivered a SIP INVITE to the device — it is ringing right
    // now. Issuing the requeue Redirect here would re-execute the trunk leg's
    // Dial() from the top, which TEARS DOWN the in-flight ring and (for ring
    // groups) re-enters the group at priority 1 — an endless "rings ~1s then
    // restarts" loop that never reaches voicemail.
    //
    // The requeue exists ONLY for the genuine mobile cold-start case: the app
    // was asleep/unregistered when the group dialed, so `PJSIP/T<id>_<exten>_1`
    // had no contact and NO extension-leg channel was ever created. In that case
    // `call.channels` holds no extension leg and this gate passes, so the wake →
    // register → requeue path still re-rings the now-awake app exactly as before.
    //
    // `call.channels` is pruned on Hangup (CallStateStore.onHangup), so a match
    // here means the leg is live RIGHT NOW — not a stale prior attempt.
    //
    // Proven root cause (RSBK ext 102, linkedId 1782424010.136659, 2026-06-25):
    // live AMI trace + telephony logs showed `PJSIP/T34_102_1` DialBegin/ringing
    // at 069423, then "AMI mobile invite requeue sent" Redirect to
    // T34_ext-ringgroups,801 at 069817 → DialEnd CANCEL → ring group restarted →
    // loop. The device never rejected and the caller never hung up; the requeue
    // Redirect was the sole trigger.
    // ANDROID-SAFE cold-answer carve-out (2026-06-28).
    //
    // The two gates below ("extension leg already ringing/live" and "extension
    // leg already delivered") exist to stop the ring-group voicemail loop: an
    // AMI Redirect over a genuinely-ringing device tears down its live INVITE
    // and (for ring groups) restarts the group forever. They must NOT change for
    // any call where a real device responded, or for any ring-group/queue dial.
    //
    // But they ALSO silently broke the legitimate mobile cold-answer case for
    // iOS: when the user swipe-kills the app, its WebRTC contact lingers as a
    // half-open WebSocket. The next call's Dial() sends an INVITE to that DEAD
    // contact, creating a `PJSIP/T<id>_<exten>` leg that rings into the void for
    // the full no-answer timeout. The leg never returns 180/200/486, but it sits
    // on `call.channels` (and flips `extensionLegSeen`), so when the rewoken app
    // registers a FRESH contact and asks for a requeue, both gates fire and the
    // fresh contact never receives an INVITE → "answer, no audio, never
    // connects". Proven live: linkedId 1782671680.142801 (ext 101, 2026-06-28),
    // single leg PJSIP/T21_101_1-00013cde, requeue skipped twice
    // ("extension_leg_already_live"), DialEnd no-answer after 21s.
    //
    // We allow the requeue to proceed ONLY when BOTH hold:
    //   (a) the requeue target is a DIRECT extension dial (`*local-dialing*`),
    //       never a ring group / queue — so a Redirect re-runs a single Dial(),
    //       which cannot enter the ring-group restart-at-priority-1 loop; and
    //   (b) NO extension leg on this call ever returned a SIP response
    //       (`extensionLegResponded` unset) — i.e. there is no real, reachable
    //       device to disturb; every leg is a dead/zombie contact.
    // A genuinely-ringing device (Android FGS, desk phone, any responsive
    // endpoint) sets `extensionLegResponded` the instant it returns 180, so it
    // stays fully protected and Android behaviour is unchanged.
    const trunkDialContextForGate =
      typeof call.metadata["trunkDialContext"] === "string"
        ? call.metadata["trunkDialContext"]
        : null;
    // NOTE (2026-06-28): a "cold-answer requeue bypass" keyed on the requeue
    // trigger (`device_register_complete`) was tried here and REVERTED — Android
    // re-registers on its wake push, which also fires `device_register_complete`,
    // so the bypass Redirected the trunk while the Android extension leg was
    // still ringing → re-dial → straight to voicemail while the app re-rang
    // (confirmed live: linkedId 1782677604.143074, leg PJSIP/T21_101_1-00013d78
    // state=ringing). The trigger ALONE cannot distinguish a zombie contact from
    // a normally-waking device — which is why the Mode-B bypass below requires
    // `invite_accept` PLUS positive evidence of a fresh, not-yet-dialed contact
    // (never the bare `device_register_complete` re-register).
    // MODE-B COLD-ANSWER RE-DELIVERY (2026-06-29): the two skips below
    // ("extension leg already ringing/live" and "...already delivered") were
    // installed 2026-06-25 (131aef94) to stop the RSBK ring-group voicemail
    // loop. They are correct for a genuinely-ringing device and for ring groups,
    // but they ALSO broke the production Android killed/swiped-away ANSWER:
    // when the app is swipe-killed, its WebRTC contact lingers; the next call's
    // Dial() forks an INVITE to that stale contact, creating a
    // `PJSIP/T<id>_<exten>` leg. The rewoken app then registers a BRAND-NEW
    // contact (JsSIP rotates the Contact URI every register) AFTER the dial, the
    // user taps Answer (`invite_accept`), but the stale leg trips
    // `extension_leg_already_live`, so the requeue is skipped and the fresh
    // contact never receives an INVITE → voicemail. The stale contact stays
    // `Reachable` and an earlier attempt keyed on `extensionLegResponded` also
    // fails (the zombie returns 180). PROVEN live: prod APK call
    // 1782764578.146922 (ext 110 / AOR T2_110_1, IVR-5 route): leg forked to
    // {8hkh5htv, i26sm07d}; fresh contact 165frhpi registered 13s after the
    // dial; requeue skipped `extension_leg_already_live`.
    //
    // We bypass the two skips ONLY when ALL of these hold — which keeps the RSBK
    // loop, queues, IVRs, desk phones AND live Android fully protected:
    //   (1) trigger is `invite_accept` (the user actually tapped Answer) — a
    //       bare `device_register_complete` (Android's wake re-register) can
    //       NEVER bypass, the exact mistake reverted on 2026-06-28.
    //   (2) call has not been answered yet (enforced by the `extensionAnsweredAt`
    //       gate above — a bridged/answered extension is never disturbed).
    //   (3) the re-delivery target is a DIRECT extension dial position
    //       (`*local-dialing*`, captured as `extLegDialContext`/`extLegDialExten`
    //       on the extension leg's own DialBegin) — NEVER a ring-group / queue /
    //       IVR context, so the Redirect re-runs a single Dial() and cannot
    //       re-enter a group at priority 1 (the RSBK loop is impossible).
    //   (4)+(5) a contact for this AOR registered AFTER the leg was dialed
    //       (`extLegDialedAt`) and is NOT one of the contacts the leg was dialed
    //       to (`extLegDialedContacts`). A live device that did not (re)register,
    //       or only re-qualified the SAME dialed contact, yields no fresh contact
    //       → no bypass → it stays protected by `extension_leg_already_live`.
    //   (6) a safe direct-extension redirect target exists (guaranteed by (3);
    //       re-checked by the `missing_safe_redirect_target` gate — never a
    //       `trk-*-in,<DID>` / last_newchannel fallback).
    //   (7) one-shot: a Mode-B redirect has not already been performed for this
    //       linkedId (`modeBRedirectPerformed`) — we never redirect twice.
    const extLegDialContext =
      typeof call.metadata["extLegDialContext"] === "string"
        ? call.metadata["extLegDialContext"]
        : null;
    const extLegDialExten =
      typeof call.metadata["extLegDialExten"] === "string"
        ? call.metadata["extLegDialExten"]
        : null;
    const extLegDialedAt =
      typeof call.metadata["extLegDialedAt"] === "number"
        ? (call.metadata["extLegDialedAt"] as number)
        : null;
    const extLegAor =
      typeof call.metadata["extLegAor"] === "string"
        ? (call.metadata["extLegAor"] as string)
        : null;
    const extLegDialedContacts = Array.isArray(call.metadata["extLegDialedContacts"])
      ? (call.metadata["extLegDialedContacts"] as string[])
      : [];
    const modeBAlreadyRedirected = call.metadata["modeBRedirectPerformed"] === true;

    const isInviteAccept = params.trigger === "invite_accept"; // (1)
    const isDirectExtTarget =
      !!extLegDialContext && !!extLegDialExten && /local-dialing/i.test(extLegDialContext); // (3)
    let freshContactUri =
      isInviteAccept && isDirectExtTarget && extLegAor && extLegDialedAt != null
        ? this.contactRegistry.freshContactNotDialed(
            extLegAor,
            extLegDialedAt,
            extLegDialedContacts,
          )
        : null; // (4)+(5)
    // STABLE-INSTANCE COLD-ANSWER WAIT (2026-07-13). With the iOS stable
    // +sip.instance (build 16) the rewoken app still rotates its Contact URI on
    // every REGISTER, but the VoIP-wake → WSS → REGISTER round-trip frequently
    // lands a few seconds AFTER the user taps Answer, so freshContactNotDialed()
    // is transiently null at this instant and the call strands on the dead
    // pre-wake leg via `extension_leg_already_live` → voicemail (PROVEN live:
    // linkedId 1783970133.244286, 2026-07-13 — invite_accept at +5s, no fresh
    // contact yet, requeue skipped, hangup at +12s). When the user has actually
    // tapped Answer (invite_accept) on a DIRECT extension dial that has NOT
    // answered, briefly wait for that late registration before giving up.
    //
    // This is Android- and ring-group-safe: Android answers the INVITE with SIP
    // 200 (tripping `extensionAnsweredAt` — the loop bails immediately and the
    // post-wait re-check below forces modeBReDeliver=false), ring groups/queues
    // are excluded by `isDirectExtTarget`, and a genuine fresh, not-yet-dialed
    // contact is still required — so the RSBK ring-group loop stays impossible.
    // The app waits up to MOBILE_SIP_ANSWER_POST_ACCEPT_EXTRA_MS (16 s) for the
    // requeued INVITE, so this bounded wait is well within its answer budget.
    if (
      isInviteAccept &&
      isDirectExtTarget &&
      !modeBAlreadyRedirected &&
      !!extLegAor &&
      extLegDialedAt != null &&
      extLegDialedContacts.length > 0 &&
      !freshContactUri
    ) {
      const MODE_B_FRESH_CONTACT_WAIT_MS = 8000;
      const MODE_B_FRESH_CONTACT_POLL_MS = 350;
      const waitDeadline = Date.now() + MODE_B_FRESH_CONTACT_WAIT_MS;
      log.info(
        { linkedId: params.linkedId, extLegAor, waitMs: MODE_B_FRESH_CONTACT_WAIT_MS },
        "mode-b: awaiting late cold-answer registration (no fresh contact yet)",
      );
      while (!freshContactUri && Date.now() < waitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, MODE_B_FRESH_CONTACT_POLL_MS));
        const liveCall = this.calls.getById(params.linkedId);
        // Never disturb a call that ended or answered (e.g. Android SIP 200)
        // while we were waiting.
        if (!liveCall || liveCall.state === "hungup" || liveCall.extensionAnsweredAt) {
          break;
        }
        freshContactUri = this.contactRegistry.freshContactNotDialed(
          extLegAor,
          extLegDialedAt,
          extLegDialedContacts,
        );
        if (freshContactUri) {
          log.info(
            {
              linkedId: params.linkedId,
              extLegAor,
              freshContactUri,
              waitedMs: MODE_B_FRESH_CONTACT_WAIT_MS - (waitDeadline - Date.now()),
            },
            "mode-b: fresh contact resolved after wait (stable-instance cold answer)",
          );
        }
      }
    }
    // Re-confirm the call is still unanswered after any wait — a call that
    // answered (Android SIP 200) or hung up while we waited must never be
    // redirected.
    const postWaitCall = this.calls.getById(params.linkedId);
    const stillUnanswered =
      !!postWaitCall && postWaitCall.state !== "hungup" && !postWaitCall.extensionAnsweredAt;
    const modeBReDeliver =
      isInviteAccept &&
      isDirectExtTarget &&
      !!freshContactUri &&
      !modeBAlreadyRedirected &&
      stillUnanswered; // (1)(3)(4)(5)(7) + still-unanswered

    // DIAGNOSTIC ONLY (2026-06-29): emit the full Mode-B evaluation for every
    // invite_accept requeue so a failed killed-answer test proves exactly which
    // predicate term left `modeBReDeliver` false. No behavior change — this log
    // is placed before the early-return gates and reads only existing values.
    if (isInviteAccept) {
      let modeBReason: string | undefined;
      if (!modeBReDeliver) {
        if (!isInviteAccept) modeBReason = "not_invite_accept";
        else if (!isDirectExtTarget) modeBReason = "not_direct_extension";
        else if (modeBAlreadyRedirected) modeBReason = "already_redirected";
        else if (!extLegAor) modeBReason = "missing_aor";
        else if (extLegDialedAt == null) modeBReason = "missing_dialed_at";
        else if (extLegDialedContacts.length === 0) modeBReason = "no_dialed_contacts";
        else if (!freshContactUri) modeBReason = "no_fresh_contact";
      }
      log.info(
        {
          linkedId: params.linkedId,
          trigger: params.trigger,
          callState: call.state,
          extLegAor,
          extLegDialedAt,
          extLegDialContext,
          extLegDialExten,
          extLegDialedContacts,
          modeBAlreadyRedirected,
          isInviteAccept,
          isDirectExtTarget,
          freshContactUri,
          registryContacts: extLegAor ? this.contactRegistry.snapshot(extLegAor) : [],
          freshContactNotDialed:
            extLegAor && extLegDialedAt != null
              ? this.contactRegistry.freshContactNotDialed(
                  extLegAor,
                  extLegDialedAt,
                  extLegDialedContacts,
                )
              : null,
          modeBReDeliver,
          modeBReason,
        },
        "mode-b diag: invite_accept requeue evaluation",
      );
    }

    const liveExtensionLeg = call.channels.find((ch) => isExtensionLegChannel(ch));
    if (liveExtensionLeg && !modeBReDeliver) {
      log.info(
        {
          linkedId: params.linkedId,
          state: call.state,
          liveExtensionLeg,
          channels: call.channels,
          trunkDialContext: trunkDialContextForGate,
        },
        "mobile invite requeue skipped — extension leg already ringing/live",
      );
      return {
        actionId: null,
        channel: null,
        exten: null,
        context: null,
        skipped: true,
        skipReason: "extension_leg_already_live",
      };
    }

    // CRITICAL (DND / fast-decline race): the live-leg gate above only catches
    // an extension leg that is STILL on `call.channels` at this instant. A leg
    // that received the INVITE and immediately answered with a final response —
    // most importantly SIP 486 Busy Here from a mobile/WebRTC endpoint in Do Not
    // Disturb — is torn down within ~100ms (CallStateStore.onHangup prunes it
    // from `call.channels`). The requeue then fires ~700ms later, sees no live
    // leg, redirects the trunk back to the ring group at priority 1, and the
    // group re-dials → "rings ~1s then loops, never reaches voicemail".
    //
    // `metadata.extensionLegSeen` is a DURABLE flag set the moment any
    // `PJSIP/T<id>_<exten>...` leg is dialed/created (DialBegin/Newchannel/
    // Newstate/BridgeEnter) and is NEVER cleared on hangup. If it is set, the
    // app already RECEIVED this call (rang, declined, or hung up) — re-injecting
    // it into the dialplan only loops. The genuine cold-start case the requeue
    // exists for never creates an extension leg (app asleep, no contact), so the
    // flag stays unset and the wake → register → requeue path is untouched.
    //
    // Proven root cause (RSBK ext 102, linkedId 1782427691.136899, 2026-06-25):
    // ring-group DialEnd at 21.207 (app 486, ~100ms) → "AMI mobile invite requeue
    // sent" Redirect to T34_ext-ringgroups,801 at 21.864 → group restarted → loop.
    if (call.metadata["extensionLegSeen"] === true && !modeBReDeliver) {
      log.info(
        {
          linkedId: params.linkedId,
          state: call.state,
          channels: call.channels,
          extensionLegSeen: true,
          trunkDialContext: trunkDialContextForGate,
        },
        "mobile invite requeue skipped — extension leg already delivered (rang/declined/hung up)",
      );
      return {
        actionId: null,
        channel: null,
        exten: null,
        context: null,
        skipped: true,
        skipReason: "extension_leg_already_delivered",
      };
    }

    // Prefer the trunk leg as the redirect channel — that's the leg the
    // dialplan needs to re-execute Dial() against. Fall back to the first
    // non-helper channel only if no trunk-recorded channel is known.
    const trunkDialChannel =
      typeof call.metadata["trunkDialChannel"] === "string"
        ? call.metadata["trunkDialChannel"]
        : null;
    const channel =
      (trunkDialChannel && call.channels.includes(trunkDialChannel) && trunkDialChannel) ||
      call.channels.find((name) => !isHelperChannel(name));
    if (!channel) {
      throw new Error(`no redirectable channel found for linkedId=${params.linkedId}`);
    }

    // Prefer the trunk leg's Dial() position (captured by DialBegin) over
    // the most-recent Newchannel context/exten — extension-leg Newchannel
    // events overwrite `lastContext`/`lastExten` with the extension's COS
    // context (e.g. `T2_cos-all`) and/or the DID number, which makes the
    // requeue Redirect loop the trunk leg back to the inbound IVR (or, with
    // the extension's COS context, dial the original caller-ID through the
    // outbound trunk — a dial loop). The trunk's recorded Dial position is
    // the only reliable place to redirect to.
    //
    // See: Connect 2 incident 2026-05-04 — call cmorz309305kkkb4c78to2yh5
    //      reproduced "AMI mobile invite requeue sent" → existing extension
    //      dial torn down → outbound dial-back via trunk → mobile never
    //      received a fresh INVITE → user got "session_not_found_timeout".
    const trunkContext =
      typeof call.metadata["trunkDialContext"] === "string"
        ? call.metadata["trunkDialContext"]
        : null;
    const trunkExten =
      typeof call.metadata["trunkDialExten"] === "string"
        ? call.metadata["trunkDialExten"]
        : null;
    const lastContext =
      typeof call.metadata["lastContext"] === "string"
        ? call.metadata["lastContext"]
        : null;
    const lastExten =
      typeof call.metadata["lastExten"] === "string"
        ? call.metadata["lastExten"]
        : null;
    // SAFE TARGET ONLY (2026-06-29): the redirect target must be the TRUNK leg's
    // recorded Dial() position (captured on DialBegin into a real extension/group
    // context). The previous `lastContext`/`lastExten` (and caller fallback) chain
    // could resolve to the inbound entry context + DID — e.g. `trk-37-in,<DID>` —
    // which re-runs the whole inbound DID route (IVR → ext), looping the caller to
    // voicemail even though the device is now registered. If we do not KNOW the
    // safe trunk Dial position, we must NOT redirect at all.
    // Proven live post-revert: linkedId 1782742495.143999
    // (trigger=device_register_complete, path=zero_contact_coldstart) redirected to
    // trk-37-in,8457823064 because trunkContext/trunkExten were null.
    // For the Mode-B cold-answer re-delivery, redirect to the tenant's
    // self-contained COS-all extension-dial context (`T<pbx>_cos-all,<ext>`) —
    // NOT the extension leg's own `sub-local-dialing` Dial position. PROVEN
    // (prod call 1782771886.148150, 2026-06-29): redirecting the trunk straight
    // into `sub-local-dialing,<ext>` lands with `TENANT`/`CALL_DESTINATION`
    // unset (those are populated upstream in `T<pbx>_cos-all-init`), so
    // `DIAL_STRING` is empty → the routine jumps past `Dial()` to `post-dial` →
    // `Hangup`. The call cancels the stale leg and drops instead of re-forking
    // to the fresh contact. `T<pbx>_cos-all,<ext>` (the IVR direct-dial Goto
    // target) is self-contained: its `s` extension runs sub-set-call-vars →
    // sub-local-dialing → `Dial()`, so it (re)dials the LIVE AOR — every current
    // contact, including the freshly registered one — while skipping the IVR
    // menu, the DID/trunk route, and ring groups. The pbx code is taken from the
    // captured AOR (`T2_110_1` → `T2`); `modeBReDeliver` already guaranteed a
    // direct-extension target, and a null pbx code falls through to the
    // `missing_safe_redirect_target` guard below (never a DID/last_newchannel).
    const modeBPbxCode = /^(T\d+)_/i.exec(extLegAor ?? "")?.[1] ?? null;
    const modeBContext = modeBPbxCode ? `${modeBPbxCode}_cos-all` : null;
    const context = modeBReDeliver ? modeBContext : trunkContext;
    const exten = modeBReDeliver ? extLegDialExten : trunkExten;
    const targetSource = modeBReDeliver
      ? "tenant_cos_all_cold_answer"
      : "trunk_dial_position";

    if (!context || !exten) {
      log.info(
        {
          linkedId: params.linkedId,
          trigger: params.trigger ?? null,
          trunkContext,
          trunkExten,
          lastContext,
          lastExten,
          fallbackContext: params.fallbackContext ?? null,
          fallbackExten: params.fallbackExten ?? null,
        },
        "mobile invite requeue skipped — no safe trunk Dial position (refusing last_newchannel/DID fallback)",
      );
      return {
        actionId: null,
        channel: null,
        exten: null,
        context: null,
        skipped: true,
        skipReason: "missing_safe_redirect_target",
      };
    }

    const actionId = await this.redirectChannel({
      channel,
      exten,
      context,
    });
    // ONE-SHOT (condition 7): mark the Mode-B bypass as performed so a duplicate
    // requeue for the same call (e.g. a retry) can never Redirect a second time —
    // it falls straight back to `extension_leg_already_live`.
    if (modeBReDeliver) {
      call.metadata["modeBRedirectPerformed"] = true;
    }
    log.info(
      {
        linkedId: params.linkedId,
        channel,
        exten,
        context,
        actionId,
        targetSource,
        modeBReDeliver,
        modeBFreshContact: modeBReDeliver ? freshContactUri : undefined,
        trunkContext,
        trunkExten,
        lastContext,
        lastExten,
      },
      "AMI mobile invite requeue sent",
    );
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
