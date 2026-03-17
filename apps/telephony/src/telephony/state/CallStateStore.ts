import { EventEmitter } from "events";
import type { NormalizedCall, CallState, CallDirection } from "../types";

// Emitted events:
//   'callUpsert'   (call: NormalizedCall) — call was created or updated
//   'callRemove'   (callId: string)       — call was permanently removed
export declare interface CallStateStore {
  on(event: "callUpsert", listener: (call: NormalizedCall) => void): this;
  on(event: "callRemove", listener: (callId: string) => void): this;
}

// How long (ms) to keep a hung-up call in the store before evicting it.
// Downstream consumers can read it during this window.
const HANGUP_RETAIN_MS = 30_000;

export class CallStateStore extends EventEmitter {
  // Primary map: linkedId → NormalizedCall
  private calls = new Map<string, NormalizedCall>();

  // Secondary index: Asterisk Uniqueid (channel uniqueid) → linkedId
  private channelIndex = new Map<string, string>();

  // Pending eviction timers
  private evictTimers = new Map<string, NodeJS.Timeout>();

  // ── Read ────────────────────────────────────────────────────────────────────

  getAll(): NormalizedCall[] {
    return [...this.calls.values()];
  }

  getActive(): NormalizedCall[] {
    return [...this.calls.values()].filter((c) => c.state !== "hungup");
  }

  getById(callId: string): NormalizedCall | undefined {
    return this.calls.get(callId);
  }

  getByChannelId(uniqueid: string): NormalizedCall | undefined {
    const linkedId = this.channelIndex.get(uniqueid);
    return linkedId ? this.calls.get(linkedId) : undefined;
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  // Called on Newchannel — registers a new channel and creates/updates the call.
  upsertFromNewchannel(params: {
    linkedId: string;
    uniqueid: string;
    channel: string;
    channelState: string;
    callerIDNum: string;
    callerIDName: string;
    connectedLineNum: string;
    connectedLineName: string;
    context: string;
    exten: string;
    tenantId: string | null;
    direction: CallDirection;
  }): NormalizedCall {
    this.channelIndex.set(params.uniqueid, params.linkedId);

    let call = this.calls.get(params.linkedId);
    if (!call) {
      call = this.createEmpty(params.linkedId, params.tenantId, params.direction);
      call.from = params.callerIDNum || null;
      call.to = params.exten || null;
    }

    if (!call.channels.includes(params.channel)) {
      call.channels.push(params.channel);
    }
    if (!call.extensions.includes(params.channel)) {
      const ext = extractExtension(params.channel);
      if (ext && !call.extensions.includes(ext)) call.extensions.push(ext);
    }

    call.state = channelStateToCallState(params.channelState);
    call.connectedLine = params.connectedLineNum || call.connectedLine;

    if (params.direction !== "unknown") call.direction = params.direction;

    this.calls.set(params.linkedId, call);
    this.emit("callUpsert", { ...call });
    return call;
  }

  // Called on Newstate
  updateChannelState(params: {
    linkedId: string;
    uniqueid: string;
    channelState: string;
    connectedLineNum: string;
  }): void {
    this.channelIndex.set(params.uniqueid, params.linkedId);
    const call = this.calls.get(params.linkedId);
    if (!call || call.state === "hungup") return;

    const newState = channelStateToCallState(params.channelState);
    if (shouldUpgradeState(call.state, newState)) {
      call.state = newState;
    }
    if (params.connectedLineNum && !call.connectedLine) {
      call.connectedLine = params.connectedLineNum;
    }

    this.emit("callUpsert", { ...call });
  }

  // Called on DialBegin — mark outbound/dialing
  onDialBegin(params: {
    linkedId: string;
    callerIDNum: string;
    destination: string;
  }): void {
    const call = this.calls.get(params.linkedId);
    if (!call || call.state === "hungup") return;

    if (call.direction === "unknown") {
      // The originating channel is placing an outbound dial
      call.direction = isInternalExtension(params.destination) ? "internal" : "outbound";
    }
    if (call.state === "unknown" || call.state === "ringing") {
      call.state = "dialing";
    }

    this.emit("callUpsert", { ...call });
  }

  // Called on BridgeEnter — two+ channels in a bridge = call is answered
  onBridgeEnter(params: {
    linkedId: string;
    uniqueid: string;
    bridgeId: string;
    bridgeNumChannels: string;
  }): void {
    this.channelIndex.set(params.uniqueid, params.linkedId);
    const call = this.calls.get(params.linkedId);
    if (!call || call.state === "hungup") return;

    if (!call.bridgeIds.includes(params.bridgeId)) {
      call.bridgeIds.push(params.bridgeId);
    }

    // When two or more channels join the same bridge the call is considered answered
    if (parseInt(params.bridgeNumChannels, 10) >= 2) {
      if (call.state !== "up") {
        call.state = "up";
        call.answeredAt = new Date().toISOString();
      }
    }

    this.emit("callUpsert", { ...call });
  }

  // Called on BridgeLeave
  onBridgeLeave(params: { linkedId: string; bridgeId: string }): void {
    const call = this.calls.get(params.linkedId);
    if (!call) return;

    call.bridgeIds = call.bridgeIds.filter((id) => id !== params.bridgeId);
    this.emit("callUpsert", { ...call });
  }

  // Called on Hangup
  onHangup(params: {
    linkedId: string;
    uniqueid: string;
    channel: string;
    cause: string;
  }): void {
    this.channelIndex.delete(params.uniqueid);

    const call = this.calls.get(params.linkedId);
    if (!call) return;

    call.channels = call.channels.filter((ch) => ch !== params.channel);

    // Only mark call ended when all channels are gone
    if (call.channels.length === 0) {
      if (call.state !== "hungup") {
        call.state = "hungup";
        call.endedAt = new Date().toISOString();
        if (call.answeredAt) {
          const startMs = new Date(call.startedAt).getTime();
          const endMs = new Date(call.endedAt).getTime();
          call.durationSec = Math.round((endMs - startMs) / 1000);
        }
        call.metadata["hangupCause"] = params.cause;
      }
      this.emit("callUpsert", { ...call });
      this.scheduleEvict(call.id);
    } else {
      this.emit("callUpsert", { ...call });
    }
  }

  // Called on CDR — update billing seconds
  onCdr(params: {
    linkedId: string;
    duration: string;
    billableSeconds: string;
    disposition: string;
  }): void {
    const call = this.calls.get(params.linkedId);
    if (!call) return;

    const dur = parseInt(params.duration, 10);
    const bill = parseInt(params.billableSeconds, 10);
    if (!isNaN(dur) && dur > call.durationSec) call.durationSec = dur;
    if (!isNaN(bill) && bill > call.billableSec) call.billableSec = bill;
    call.metadata["cdrDisposition"] = params.disposition;

    this.emit("callUpsert", { ...call });
  }

  // Called on QueueCallerJoin
  onQueueJoin(params: { linkedId: string; queue: string }): void {
    const call = this.calls.get(params.linkedId);
    if (!call) return;
    call.queueId = params.queue;
    this.emit("callUpsert", { ...call });
  }

  // Called on transfer events — re-link channels under the surviving linkedId
  onTransfer(params: {
    survivingLinkedId: string;
    obsoleteLinkedId: string;
  }): void {
    const obsolete = this.calls.get(params.obsoleteLinkedId);
    const surviving = this.calls.get(params.survivingLinkedId);
    if (!obsolete || !surviving) return;

    // Merge channels and bridges from the obsolete leg into the surviving call
    for (const ch of obsolete.channels) {
      if (!surviving.channels.includes(ch)) surviving.channels.push(ch);
    }
    for (const br of obsolete.bridgeIds) {
      if (!surviving.bridgeIds.includes(br)) surviving.bridgeIds.push(br);
    }

    // Re-point the channel index
    for (const [uid, lid] of this.channelIndex) {
      if (lid === params.obsoleteLinkedId) {
        this.channelIndex.set(uid, params.survivingLinkedId);
      }
    }

    this.calls.delete(params.obsoleteLinkedId);
    this.emit("callRemove", params.obsoleteLinkedId);
    this.emit("callUpsert", { ...surviving });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  private createEmpty(
    linkedId: string,
    tenantId: string | null,
    direction: CallDirection,
  ): NormalizedCall {
    return {
      id: linkedId,
      linkedId,
      tenantId,
      direction,
      state: "unknown",
      from: null,
      to: null,
      connectedLine: null,
      channels: [],
      bridgeIds: [],
      extensions: [],
      queueId: null,
      trunk: null,
      startedAt: new Date().toISOString(),
      answeredAt: null,
      endedAt: null,
      durationSec: 0,
      billableSec: 0,
      metadata: {},
    };
  }

  private scheduleEvict(callId: string): void {
    const existing = this.evictTimers.get(callId);
    if (existing) clearTimeout(existing);

    const t = setTimeout(() => {
      this.calls.delete(callId);
      this.evictTimers.delete(callId);
      this.emit("callRemove", callId);
    }, HANGUP_RETAIN_MS);

    if (t.unref) t.unref();
    this.evictTimers.set(callId, t);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function channelStateToCallState(stateStr: string): CallState {
  switch (stateStr) {
    case "0": return "unknown";  // Down
    case "3": return "dialing"; // Dialing
    case "4": return "ringing"; // Ring (destination is ringing)
    case "5": return "ringing"; // Ringing (caller hears ringback)
    case "6": return "up";      // Up / answered
    case "7": return "unknown"; // Busy
    default: return "unknown";
  }
}

function shouldUpgradeState(current: CallState, next: CallState): boolean {
  const order: CallState[] = ["unknown", "ringing", "dialing", "up", "held", "hungup"];
  return order.indexOf(next) > order.indexOf(current);
}

function extractExtension(channel: string): string | null {
  const m = /(?:PJSIP|SIP|IAX2?)\/([^@-]+)/.exec(channel);
  return m ? (m[1] ?? null) : null;
}

function isInternalExtension(dest: string): boolean {
  // Internal extensions are typically 3-5 digit numbers
  return /^\d{3,5}$/.test(dest.split("@")[0] ?? "");
}
