import { EventEmitter } from "events";
import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { NormalizedCall, CallState, CallDirection } from "../types";
import {
  isLocalOnlyCall,
  hasValidChannel,
  isHelperChannel,
} from "../normalizers/normalizeCallEvent";

const log = childLogger("CallStateStore");

/** Active states only; exclude unknown (may be stale/down). */
const ACTIVE_STATES: CallState[] = ["ringing", "dialing", "up", "held"];

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

/** Max call duration (seconds) for duration-based stale cleanup. Only used when call has no live channel. */
const MAX_CALL_DURATION_SECONDS = 8000;

export class CallStateStore extends EventEmitter {
  // Primary map: linkedId → NormalizedCall
  private calls = new Map<string, NormalizedCall>();

  // Secondary index: Asterisk Uniqueid (channel uniqueid) → callId (linkedId)
  private channelIndex = new Map<string, string>();

  // Bridge → canonical callId (first call to join bridge wins; others merge into it)
  private bridgeIndex = new Map<string, string>();

  // Pending eviction timers
  private evictTimers = new Map<string, NodeJS.Timeout>();

  // ── Read ────────────────────────────────────────────────────────────────────

  getAll(): NormalizedCall[] {
    return [...this.calls.values()];
  }

  /** Active calls only: state in [ringing,dialing,up,held], not Local-only, has ≥1 valid channel. */
  getActive(): NormalizedCall[] {
    return [...this.calls.values()].filter((c) => {
      if (c.state === "hungup") return false;
      if (!ACTIVE_STATES.includes(c.state)) return false; // exclude unknown/stale
      if (isLocalOnlyCall(c)) return false;
      if (!hasValidChannel(c)) return false;
      return true;
    });
  }

  getById(callId: string): NormalizedCall | undefined {
    return this.calls.get(callId);
  }

  getByChannelId(uniqueid: string): NormalizedCall | undefined {
    const linkedId = this.channelIndex.get(uniqueid);
    return linkedId ? this.calls.get(linkedId) : undefined;
  }

  /** For diagnostics: raw channel count, derived active count, overcount warning, optional per-call summary. */
  getDiagnostics(): {
    rawChannelCount: number;
    derivedActiveCount: number;
    unresolvedActiveCount: number;
    hungupRetainedCount: number;
    overcountSuspected?: boolean;
    activeCallSummary?: Array<{
      callId: string;
      linkedId: string;
      uniqueIds: string[];
      channels: string[];
      bridgeIds: string[];
      tenantId: string | null;
      state: CallState;
      isLocalOnly: boolean;
    }>;
    sampleMergedCall?: NormalizedCall | null;
    sampleLocalIgnoredCall?: NormalizedCall | null;
  } {
    const rawChannelCount = this.channelIndex.size;
    const all = [...this.calls.values()];
    const active = this.getActive();
    const derivedActiveCount = active.length;
    const overcountSuspected =
      derivedActiveCount > rawChannelCount ||
      (rawChannelCount > 0 && derivedActiveCount > Math.ceil(rawChannelCount / 2) + 1);

    if (overcountSuspected && env.ENABLE_TELEPHONY_DEBUG) {
      log.warn(
        { rawChannelCount, derivedActiveCount },
        "live_call: overcount_suspected",
      );
    }

    const uniqueIdsFor = (callId: string): string[] => {
      const out: string[] = [];
      for (const [uid, cid] of this.channelIndex) if (cid === callId) out.push(uid);
      return out;
    };

    let activeCallSummary: Array<{
      callId: string;
      linkedId: string;
      uniqueIds: string[];
      channels: string[];
      bridgeIds: string[];
      tenantId: string | null;
      state: CallState;
      isLocalOnly: boolean;
    }> | undefined;
    let sampleMergedCall: NormalizedCall | null = null;
    let sampleLocalIgnoredCall: NormalizedCall | null = null;

    if (env.ENABLE_TELEPHONY_DEBUG) {
      activeCallSummary = active.map((c) => ({
        callId: c.id,
        linkedId: c.linkedId,
        uniqueIds: uniqueIdsFor(c.id),
        channels: [...c.channels],
        bridgeIds: [...c.bridgeIds],
        tenantId: c.tenantId,
        state: c.state,
        isLocalOnly: isLocalOnlyCall(c),
      }));
      if (active.length > 0 && active[0].channels.length > 1)
        sampleMergedCall = active[0];
      const localOnly = all.find((c) => c.state !== "hungup" && isLocalOnlyCall(c));
      if (localOnly) sampleLocalIgnoredCall = localOnly;
    }

    return {
      rawChannelCount,
      derivedActiveCount,
      unresolvedActiveCount: active.filter((c) => c.tenantId === null).length,
      hungupRetainedCount: all.filter((c) => c.state === "hungup").length,
      ...(overcountSuspected && { overcountSuspected: true }),
      ...(activeCallSummary && { activeCallSummary }),
      ...(sampleMergedCall && { sampleMergedCall }),
      ...(sampleLocalIgnoredCall && { sampleLocalIgnoredCall }),
    };
  }

  /**
   * Forensic report: every derived active call with whyActive, whyNotMerged, and bucket.
   * Use for live mismatch investigation.
   */
  getForensicReport(): {
    rawChannelCount: number;
    derivedActiveCount: number;
    activeCallsForensic: Array<{
      callId: string;
      linkedId: string;
      uniqueIds: string[];
      bridgeIds: string[];
      channels: string[];
      from: string | null;
      to: string | null;
      state: CallState;
      tenantId: string | null;
      startedAt: string;
      answeredAt: string | null;
      whyActive: string;
      whyNotMerged: string;
      bucket: string;
      traceNote: string;
    }>;
    bucketCounts: Record<string, number>;
  } {
    const rawChannelCount = this.channelIndex.size;
    const active = this.getActive();
    const derivedActiveCount = active.length;

    const uniqueIdsFor = (callId: string): string[] => {
      const out: string[] = [];
      for (const [uid, cid] of this.channelIndex) if (cid === callId) out.push(uid);
      return out;
    };

    const bridgeIdToCallIds = new Map<string, string[]>();
    for (const c of active) {
      for (const br of c.bridgeIds) {
        const list = bridgeIdToCallIds.get(br) ?? [];
        if (!list.includes(c.id)) list.push(c.id);
        bridgeIdToCallIds.set(br, list);
      }
    }

    const activeCallsForensic = active.map((c) => {
      const uniqueIds = uniqueIdsFor(c.id);
      const whyActive = [
        ACTIVE_STATES.includes(c.state) ? `state=${c.state}` : `state=${c.state}(not in active list)`,
        hasValidChannel(c) ? "hasValidChannel" : "NO_VALID_CHANNEL",
        !isLocalOnlyCall(c) ? "!isLocalOnlyCall" : "IS_LOCAL_ONLY",
      ].join("; ");
      const sharedBridgeCallIds = new Set<string>();
      for (const br of c.bridgeIds) {
        const list = bridgeIdToCallIds.get(br) ?? [];
        for (const otherId of list) if (otherId !== c.id) sharedBridgeCallIds.add(otherId);
      }
      let whyNotMerged: string;
      let bucket: string;
      let traceNote: string;
      if (sharedBridgeCallIds.size > 0) {
        whyNotMerged = `same bridge as callIds: ${[...sharedBridgeCallIds].join(", ")} → merge did not run or ran in wrong order`;
        bucket = "duplicateLeg";
        traceNote = "BridgeEnter merge should have merged this into canonical call; check onBridgeEnter/mergeCallInto and bridgeIndex.";
      } else if (c.bridgeIds.length > 0) {
        whyNotMerged = "canonical for bridge(s) " + c.bridgeIds.join(", ");
        bucket = "legitimate";
        traceNote = "Single call for this bridge.";
      } else if (c.state === "unknown") {
        whyNotMerged = "no bridge yet or single leg";
        bucket = "staleOrphan";
        traceNote = "State is unknown; getActive() should exclude unknown - possible filter bypass.";
      } else if (isLocalOnlyCall(c) || !hasValidChannel(c)) {
        whyNotMerged = "N/A";
        bucket = "helperArtifact";
        traceNote = "Should be excluded by getActive(); hasValidChannel or isLocalOnlyCheck is wrong.";
      } else {
        const sameFromTo = active.filter(
          (o) => o.id !== c.id && o.from === c.from && o.to === c.to && Math.abs(new Date(o.startedAt).getTime() - new Date(c.startedAt).getTime()) < 120_000,
        );
        if (sameFromTo.length > 0) {
          whyNotMerged = `same from/to/time as ${sameFromTo.map((o) => o.id).join(", ")}`;
          bucket = "wrongTenantDuplication";
          traceNote = "Possible duplicate by from/to/time; different callId (linkedId) - check effectiveLinkedId or tenant split.";
        } else {
          whyNotMerged = "no bridge yet or single leg; no other call shares bridge";
          bucket = "legitimate";
          traceNote = "Single leg or pre-bridge; no duplicate detected.";
        }
      }
      return {
        callId: c.id,
        linkedId: c.linkedId,
        uniqueIds,
        bridgeIds: [...c.bridgeIds],
        channels: [...c.channels],
        from: c.from,
        to: c.to,
        state: c.state,
        tenantId: c.tenantId,
        startedAt: c.startedAt,
        answeredAt: c.answeredAt,
        whyActive,
        whyNotMerged,
        bucket,
        traceNote,
      };
    });

    const bucketCounts: Record<string, number> = {};
    for (const row of activeCallsForensic) {
      bucketCounts[row.bucket] = (bucketCounts[row.bucket] ?? 0) + 1;
    }

    return {
      rawChannelCount,
      derivedActiveCount,
      activeCallsForensic,
      bucketCounts,
    };
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
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ callId: params.linkedId, channel: params.channel, tenantId: params.tenantId }, "live_call: call_created");
      }
    } else if (env.ENABLE_TELEPHONY_DEBUG && !call.channels.includes(params.channel)) {
      log.debug({ callId: params.linkedId, channel: params.channel }, "live_call: call_merged_deduped");
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
      if (env.ENABLE_TELEPHONY_DEBUG && (newState === "ringing" || newState === "up")) {
        log.debug({ callId: params.linkedId, state: newState }, "live_call: call_marked_ringing_or_talking");
      }
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
    const bridgeId = params.bridgeId;
    if (!bridgeId) return;

    this.channelIndex.set(params.uniqueid, params.linkedId);
    let call = this.calls.get(params.linkedId);
    if (!call || call.state === "hungup") return;

    if (!call.bridgeIds.includes(bridgeId)) {
      call.bridgeIds.push(bridgeId);
    }

    const canonicalCallId = this.bridgeIndex.get(bridgeId);
    if (canonicalCallId !== undefined && canonicalCallId !== params.linkedId) {
      this.mergeCallInto(params.linkedId, canonicalCallId);
      call = this.calls.get(canonicalCallId);
      if (!call) return;
    } else {
      this.bridgeIndex.set(bridgeId, params.linkedId);
    }

    if (parseInt(params.bridgeNumChannels, 10) >= 2) {
      if (call.state !== "up") {
        call.state = "up";
        call.answeredAt = new Date().toISOString();
        if (env.ENABLE_TELEPHONY_DEBUG) {
          log.debug({ callId: call.id }, "live_call: call_marked_talking");
        }
      }
    }

    this.emit("callUpsert", { ...call });
  }

  private mergeCallInto(fromCallId: string, intoCallId: string): void {
    const fromCall = this.calls.get(fromCallId);
    const intoCall = this.calls.get(intoCallId);
    if (!fromCall || !intoCall || fromCallId === intoCallId) return;

    for (const ch of fromCall.channels) {
      if (!intoCall.channels.includes(ch)) intoCall.channels.push(ch);
    }
    for (const br of fromCall.bridgeIds) {
      if (!intoCall.bridgeIds.includes(br)) intoCall.bridgeIds.push(br);
    }
    for (const ext of fromCall.extensions) {
      if (!intoCall.extensions.includes(ext)) intoCall.extensions.push(ext);
    }
    if (fromCall.from && !intoCall.from) intoCall.from = fromCall.from;
    if (fromCall.to && !intoCall.to) intoCall.to = fromCall.to;
    if (fromCall.answeredAt && !intoCall.answeredAt) intoCall.answeredAt = fromCall.answeredAt;
    if (fromCall.state !== "hungup" && shouldUpgradeState(intoCall.state, fromCall.state)) {
      intoCall.state = fromCall.state;
    }

    for (const [uid, cid] of this.channelIndex) {
      if (cid === fromCallId) this.channelIndex.set(uid, intoCallId);
    }
    for (const br of fromCall.bridgeIds) {
      this.bridgeIndex.set(br, intoCallId);
    }

    const evictTimer = this.evictTimers.get(fromCallId);
    if (evictTimer) {
      clearTimeout(evictTimer);
      this.evictTimers.delete(fromCallId);
    }
    this.calls.delete(fromCallId);
    this.emit("callRemove", fromCallId);
    if (env.ENABLE_TELEPHONY_DEBUG) {
      log.debug({ fromCallId, intoCallId, bridgeIds: fromCall.bridgeIds }, "live_call: call_merged_by_bridge");
    }
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
    // Resolve which call owns this channel before we remove uniqueid from the index.
    // Asterisk may send linkedid that doesn't match our canonical call (e.g. after merge),
    // so lookup by linkedId can miss; channelIndex always points at the call we have for this channel.
    const callIdByChannel = this.channelIndex.get(params.uniqueid);
    this.channelIndex.delete(params.uniqueid);

    let call = this.calls.get(params.linkedId);
    if (!call && callIdByChannel !== undefined) {
      call = this.calls.get(callIdByChannel) ?? undefined;
    }
    if (!call) return;

    call.channels = call.channels.filter((ch) => ch !== params.channel);

    // Only mark call ended when all channels are gone
    if (call.channels.length === 0) {
      if (call.state !== "hungup") {
        call.state = "hungup";
        call.endedAt = new Date().toISOString();
        const endMs = new Date(call.endedAt).getTime();
        const startMs = new Date(call.startedAt).getTime();
        // Use answeredAt for duration when present (talk time); else startedAt
        const refMs = call.answeredAt
          ? new Date(call.answeredAt).getTime()
          : startMs;
        call.durationSec = Math.max(0, Math.round((endMs - refMs) / 1000));
        call.metadata["hangupCause"] = params.cause;
      }
      this.emit("callUpsert", { ...call });
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ callId: call.id, cause: params.cause }, "live_call: call_hungup");
      }
      // Emit remove immediately so clients drop the row; evict timer still cleans store
      this.emitCallRemove(call.id);
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
      this.evictCallNow(callId);
    }, HANGUP_RETAIN_MS);

    if (t.unref) t.unref();
    this.evictTimers.set(callId, t);
  }

  /** Remove call from store immediately (used for duration-based stale kills so they don't reappear in snapshots). */
  private evictCallNow(callId: string): void {
    const call = this.calls.get(callId);
    if (call) for (const br of call.bridgeIds) this.bridgeIndex.delete(br);
    this.calls.delete(callId);
    const t = this.evictTimers.get(callId);
    if (t) {
      clearTimeout(t);
      this.evictTimers.delete(callId);
    }
    const uidsToDelete: string[] = [];
    for (const [uid, lid] of this.channelIndex) {
      if (lid === callId) uidsToDelete.push(uid);
    }
    for (const uid of uidsToDelete) this.channelIndex.delete(uid);
    this.emitCallRemove(callId);
  }

  /** Clear all call state (e.g. on AMI disconnect). Emits callRemove for each known call. */
  clearAll(): void {
    for (const t of this.evictTimers.values()) clearTimeout(t);
    this.evictTimers.clear();
    this.bridgeIndex.clear();
    const ids = [...this.calls.keys()];
    this.calls.clear();
    this.channelIndex.clear();
    if (env.ENABLE_TELEPHONY_DEBUG && ids.length > 0) {
      log.debug({ count: ids.length, callIds: ids }, "live_call: call_removed_clearAll");
    }
    for (const id of ids) this.emit("callRemove", id);
  }

  private emitCallRemove(callId: string): void {
    if (env.ENABLE_TELEPHONY_DEBUG) {
      log.debug({ callId }, "live_call: call_removed");
    }
    this.emit("callRemove", callId);
  }

  /**
   * Remove ghost calls: (1) active but no channelIndex entry (ghost), or (2) duration exceeds
   * MAX_CALL_DURATION_SECONDS (obviously stale — kills long-lived ghosts even if channelIndex
   * still has stale entries from missed Hangups). Collect ids first, then evict, to avoid mutating
   * the map during iteration.
   */
  private removeStaleGhostCalls(): void {
    const liveCallIds = new Set(this.channelIndex.values());
    const nowMs = Date.now();
    const toEvictNow: string[] = [];
    const toMarkHungupAndSchedule: string[] = [];
    for (const [id, call] of this.calls) {
      if (call.state === "hungup") continue;
      if (!ACTIVE_STATES.includes(call.state)) continue;
      const refMs = call.answeredAt
        ? new Date(call.answeredAt).getTime()
        : call.startedAt
          ? new Date(call.startedAt).getTime()
          : 0;
      const durationSec = refMs ? Math.floor((nowMs - refMs) / 1000) : 0;
      const overMaxDuration = durationSec > MAX_CALL_DURATION_SECONDS;
      const noLiveChannel = !liveCallIds.has(id);
      const removeAsGhost = noLiveChannel && (call.channels.length > 0 || overMaxDuration);
      const removeAsStaleByDuration = overMaxDuration; // kill obviously stale even if channelIndex still has entries
      if (!removeAsGhost && !removeAsStaleByDuration) continue;
      if (removeAsStaleByDuration) {
        toEvictNow.push(id);
      } else {
        toMarkHungupAndSchedule.push(id);
      }
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug(
          { callId: id, durationSec, overMaxDuration, removeAsStaleByDuration },
          "live_call: ghost_call_removed_reconcile",
        );
      }
    }
    for (const id of toEvictNow) {
      this.evictCallNow(id);
    }
    for (const id of toMarkHungupAndSchedule) {
      const call = this.calls.get(id);
      if (!call) continue;
      call.state = "hungup";
      call.endedAt = new Date().toISOString();
      this.emitCallRemove(id);
      this.scheduleEvict(id);
    }
  }

  /** Remove hungup calls that have been in store longer than HANGUP_RETAIN_MS (safety net). */
  runStaleCleanup(): void {
    this.removeStaleGhostCalls();
    const now = Date.now();
    const cutoff = now - HANGUP_RETAIN_MS;
    for (const [id, call] of this.calls) {
      if (call.state !== "hungup") continue;
      const endMs = call.endedAt ? new Date(call.endedAt).getTime() : 0;
      if (!isNaN(endMs) && endMs < cutoff) {
        for (const br of call.bridgeIds) this.bridgeIndex.delete(br);
        const t = this.evictTimers.get(id);
        if (t) clearTimeout(t);
        this.evictTimers.delete(id);
        this.calls.delete(id);
        const uidsToDelete: string[] = [];
        for (const [uid, lid] of this.channelIndex) {
          if (lid === id) uidsToDelete.push(uid);
        }
        for (const uid of uidsToDelete) this.channelIndex.delete(uid);
        if (env.ENABLE_TELEPHONY_DEBUG) {
          log.debug({ callId: id }, "live_call: call_removed_stale_cleanup");
        }
        this.emit("callRemove", id);
      }
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function channelStateToCallState(stateStr: string): CallState {
  const s = String(stateStr).trim();
  switch (s) {
    case "0":
    case "Down":
      return "unknown";
    case "3":
    case "Dialing":
      return "dialing";
    case "4":
    case "5":
    case "Ring":
    case "Ringing":
      return "ringing";
    case "6":
    case "Up":
      return "up";
    case "7":
    case "Busy":
      return "unknown";
    default:
      return "unknown";
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
