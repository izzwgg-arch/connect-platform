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

// TelephonyService wires raw AMI events → state stores.
// It is the only place where AMI frames are interpreted and state is mutated.

export class TelephonyService {
  private readonly resolver: TenantResolver;

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
    const typed = mapAmiFrame(frame);
    if (!typed) return;

    if (env.ENABLE_TELEPHONY_DEBUG) {
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
        this.calls.upsertFromNewchannel({
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
          peerStatus: typed.contactStatus === "Reachable" ? "Registered" : "Unreachable",
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
    }
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
  }): Promise<{ actionId: string; channel: string; exten: string; context: string }> {
    const call = this.calls.getById(params.linkedId);
    if (!call || call.state === "hungup") {
      throw new Error(`active call not found for linkedId=${params.linkedId}`);
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
    return { actionId, channel, exten, context };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Use linkedId when non-empty; else uniqueid so we never key calls by "". */
function effectiveLinkedId(linkedid: string, uniqueid: string): string {
  const id = (linkedid ?? "").trim();
  return id.length > 0 ? id : uniqueid;
}
