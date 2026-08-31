import { EventEmitter } from "events";
import { extractPbxTenantCodeFromCallFields } from "./pbxTenantMarker";
import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import type { NormalizedCall, CallState, CallDirection } from "../types";
import {
  isLocalOnlyCall,
  hasValidChannel,
  hasValidBridgedParticipants,
  isHelperChannel,
} from "../normalizers/normalizeCallEvent";
import { normalizeExtensionFromChannel, looksLikeExtension } from "../normalizers/normalizeExtension";
import { extractPbxTenantHintsFromContext } from "../pbx/pbxTenantHints";

const log = childLogger("CallStateStore");

/** Active states only; exclude unknown (may be stale/down). */
const ACTIVE_STATES: CallState[] = ["ringing", "dialing", "up", "held"];

// Emitted events:
//   'callUpsert'   (call: NormalizedCall) — call was created or updated
//   'callRemove'   (callId: string)       — call was permanently removed
//   'callEvicted'  (call: NormalizedCall) — call was force-removed by a cleanup
//                  path (zombie/ghost/stale/clearAll) WITHOUT a normal hangup.
//                  Fired so the CDR is filed with whatever data exists; a later
//                  AMI Cdr event for the same linkedId corrects it via upsert.
//   'orphanCdr'    (call: NormalizedCall) — an AMI Cdr event arrived for a call
//                  the store no longer (or never) tracked. The event is the
//                  PBX's own end-of-call report, so it is synthesized into a
//                  minimal call and filed — no call may vanish from history
//                  just because the live tracker lost it.
export declare interface CallStateStore {
  on(event: "callUpsert", listener: (call: NormalizedCall) => void): this;
  on(event: "callRemove", listener: (callId: string) => void): this;
  on(event: "callEvicted", listener: (call: NormalizedCall) => void): this;
  on(event: "orphanCdr", listener: (call: NormalizedCall) => void): this;
}

// How long (ms) to keep a hung-up call in the store before evicting it.
// Downstream consumers can read it during this window.
const HANGUP_RETAIN_MS = 30_000;

// ── ARI bridge-reconcile safety margins ──────────────────────────────────────
// The ARI poll snapshot is taken BEFORE extra awaits (channel-var fetches,
// endpoint counts, afterPoll publish) run, so by the time reconcile sees it the
// bridge list can be a second or more stale. A call whose bridge formed inside
// that window looks "absent" and used to be force-evicted mid-call (live case
// 2026-08-04: Relax Tires linkedId 1785860821.162724 — evicted 0.8s after its
// bridges formed, 20s into a 5-minute call; its CDR was permanently lost).
// Two independent guards:
//   1. A bridge must be absent from TWO CONSECUTIVE polls before eviction.
//   2. A call whose most recent BridgeEnter is younger than the grace window is
//      never evicted by reconcile, regardless of strikes.
const RECONCILE_ABSENT_STRIKES_REQUIRED = 2;
const RECONCILE_BRIDGE_GRACE_MS = 15_000;

// ── ARI refutation of stale legs at hangup time (2026-08-31) ────────────────
// When a Hangup event arrives for one leg but a SIBLING leg's Hangup was
// missed (renamed channel, AMI gap), the call used to sit "On Call" until the
// 60s sweep / ARI reconcile — the "hung up but stayed on screen for a minute"
// complaint. reconcileLiveChannels caches the latest RAW ARI channel set; the
// hangup handler consults it: a remaining indexed channel that (a) is absent
// from that set, (b) provably PREDATES the snapshot (its uniqueid epoch is
// older than the snapshot by a safety margin, so if it were alive it HAD to be
// in the list), on (c) a fresh, non-empty snapshot, is refuted — and a call
// whose every remaining leg is refuted is over NOW, not at the next sweep.
// ⛔ The epoch guard is what makes this safe against the stale-snapshot lie
// that caused the 2026-08-04 wrongful evictions: a channel created after the
// snapshot can never be refuted by it.
const ARI_SET_FRESH_MS = 20_000;
const UNIQUEID_EPOCH_SAFETY_MS = 8_000;

/**
 * Parse the creation epoch (ms) out of an Asterisk uniqueid
 * ("<epoch>.<seq>", optionally "<systemname>-<epoch>.<seq>").
 * Returns null when the value doesn't carry a plausible epoch — callers must
 * treat null as "cannot refute", never as "dead".
 */
export function uniqueidEpochMs(uid: string): number | null {
  const m = /(?:^|-)(\d{10})\.\d+$/.exec(String(uid ?? "").trim());
  if (!m) return null;
  const epochMs = Number(m[1]) * 1000;
  if (!Number.isFinite(epochMs)) return null;
  // Sanity window: 2020 .. now + 1 day.
  if (epochMs < 1_577_836_800_000 || epochMs > Date.now() + 86_400_000) return null;
  return epochMs;
}

/** Max call duration (seconds) for duration-based stale cleanup. Only used when call has no live channel. */
const MAX_CALL_DURATION_SECONDS = 8000;

// Shared VitalPBX multi-tenant context prefixes. Used to extract tenant slug from dcontext/accountCode.
const VPBX_CTX_PREFIXES = ["ext-local-", "from-pstn-", "from-internal-", "from-trunk-", "outbound-", "from-external-"];

/**
 * Returns true when the channel name matches a tenant-extension leg pattern
 * (`PJSIP/T<id>_<exten>...` — including WebRTC `_<n>` suffix variants like
 * `T2_103_1`). Trunk legs (`PJSIP/<numeric>_<provider_slug>...`) and helper
 * channels (Local/, mixing/, Message/, …) return false.
 *
 * Used to gate the {@link NormalizedCall.extensionAnsweredAt} timestamp so a
 * trunk leg's IVR `Answer()` (which fires up to 30 seconds before the dialed
 * extension is even rung) does NOT make the call appear "already answered by
 * the called extension" to the mobile-wake answer pipeline.
 */
export function isExtensionLegChannel(channel: string | null | undefined): boolean {
  if (!channel) return false;
  return /^PJSIP\/T\d+_\d+/i.test(channel);
}

/**
 * Extract the resolved destination extension from a VitalPBX recording filename.
 *
 * IVR / DID-fronted inbound calls never expose the destination extension in the
 * AMI channel/exten fields during the IVR greeting — the trunk leg is the only
 * channel, so {@link normalizeExtensionFromChannel} yields null and the call's
 * `extensions[]` stays empty. That means MobilePushNotifier sends NO per-extension
 * "ring now" (INCOMING_CALL) push, so a mobile-only extension only rings if the
 * device happened to still be SIP-registered. (Confirmed live 2026-06-26 for
 * Luxure 101: DID → IVR-12 → ext 101, `extensions:[]` the whole call, only a
 * tenant pre-wake fired, and the killed device never rang → voicemail.)
 *
 * VitalPBX names the recording for the LEG that actually answers/records using
 *   {HHMMSS}-{TYPE}-{APP}-{SOURCE}-{DEST}-{RECORDING_ID}.wav
 * where RECORDING_ID is the call linkedId and DEST is the resolved destination
 * extension the dialplan routed to (set via `CALL_DESTINATION` the instant the
 * IVR option / direct-dial chooses it). So the filename gives us the real
 * destination — per call, after the caller's choice — well before (or as) the
 * PBX dials the extension. We parse it and feed it into the push pipeline so the
 * native ring push fires for IVR-fronted inbound calls too, for every tenant.
 *
 * We anchor on the known linkedId (which equals RECORDING_ID) so the captured
 * token is unambiguously the DEST field and never a digit run inside SOURCE.
 */
export function parseDestExtenFromRecordingPath(
  path: string | null | undefined,
  linkedId: string | null | undefined,
): string | null {
  if (!path) return null;
  const base = (path.split("/").pop() ?? path).trim();
  if (!base) return null;
  let m: RegExpExecArray | null = null;
  if (linkedId) {
    const esc = linkedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    m = new RegExp(`-(\\d{2,6})-${esc}\\.wav$`, "i").exec(base);
  }
  if (!m) {
    // Fallback when linkedId is not embedded verbatim: DEST is the 2–6 digit
    // token immediately before the `<secs>.<seq>.wav` recording id tail.
    m = /-(\d{2,6})-\d+\.\d+\.wav$/i.exec(base);
  }
  const ext = m?.[1] ?? null;
  return ext && looksLikeExtension(ext) ? ext : null;
}

/**
 * Set the durable `extensionLegSeen` flag the moment any real tenant-extension
 * leg (`PJSIP/T<id>_<exten>...`, incl. the WebRTC `_<n>` sibling) is dialed or
 * created for a call. Unlike `call.channels` (pruned on Hangup), this lives in
 * `metadata` and survives the leg being torn down — so the mobile-invite requeue
 * can tell "the app received the INVITE (and may have declined/hung up) — do NOT
 * re-ring the dialplan" apart from "the app was asleep and never got the INVITE
 * (genuine cold-start — requeue is safe)". This is what stops the ring-group
 * voicemail loop when a DND/declined leg (fast 486) tears down before the live
 * gate can see it.
 */
function markExtensionLegSeen(call: NormalizedCall, channel: string | null | undefined): void {
  if (call.metadata["extensionLegSeen"]) return;
  if (isExtensionLegChannel(channel)) {
    call.metadata["extensionLegSeen"] = true;
  }
}

/**
 * True when an Asterisk channel state means the *remote endpoint's* SIP stack
 * actively responded to our INVITE — i.e. a REAL, reachable device is there:
 *   5 / "Ringing"  → device returned `180 Ringing`
 *   6 / "Up"       → device returned `200 OK`
 *   7 / "Busy"     → device returned a busy/`486` final response
 *
 * A dead / zombie WebSocket contact (a mobile app the user swipe-killed, whose
 * WS lingers half-open so Asterisk still sends the INVITE into the void) gets
 * the INVITE but NEVER replies, so its leg stays at 0/"Down", 3/"Dialing" or
 * 4/"Ring" until the dial times out. We deliberately exclude 4/"Ring": that is
 * "we are dialing it", NOT "it answered us".
 */
function channelStateIndicatesPeerResponse(raw: string | null | undefined): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "5" || s === "ringing" || s === "6" || s === "up" || s === "7" || s === "busy";
}

/**
 * Durable companion to {@link markExtensionLegSeen}. Set the moment ANY real
 * tenant-extension leg reaches a state proving the endpoint's SIP stack replied
 * (180/200/486). Unlike `extensionLegSeen` (true even for a contact that was
 * merely *dialed*), this is true ONLY when a device actually responded — which
 * is exactly how we tell a genuinely-ringing device (must be protected; never
 * disturb it) apart from a dead post-swipe-kill WebSocket contact that the PBX
 * is ringing into the void (safe to re-dial so the freshly-rewoken contact gets
 * the INVITE). Never cleared on hangup. See
 * {@link TelephonyService.requeueLiveCallToDialplan}.
 */
function markExtensionLegResponded(
  call: NormalizedCall,
  channel: string | null | undefined,
  rawChannelState: string | null | undefined,
): void {
  if (call.metadata["extensionLegResponded"]) return;
  if (!isExtensionLegChannel(channel)) return;
  if (channelStateIndicatesPeerResponse(rawChannelState)) {
    call.metadata["extensionLegResponded"] = true;
  }
}

function digitsOnly(value: string | null | undefined): string {
  const digits = String(value || "").replace(/\D/g, "");
  return /^1\d{10}$/.test(digits) ? digits.slice(1) : digits;
}

/**
 * Extract the ring-group CID prefix the VitalPBX dialplan prepends to
 * CALLERID(name) — `Set(CALLERID(name)=Estimates:${CALLERID(name)})`. The
 * dialplan prepends it on every ring-group pass, so the name frequently arrives
 * tripled (e.g. "Estimates:Estimates:Estimates:A PLUS CENTER TEST"). We return
 * just the single label ("Estimates"), or null when the name has no prefix.
 *
 * Only the leading label is treated as a prefix: a numeric leading segment (a
 * bare caller number after the colon) or an overly-long segment (a real CNAM
 * that happens to contain a colon) yields null so we never mistake caller data
 * for a ring-group tag.
 */
export function extractRingGroupPrefix(rawName: string | null | undefined): string | null {
  const name = String(rawName ?? "").trim();
  const firstColon = name.indexOf(":");
  if (firstColon <= 0) return null;
  const token = name.slice(0, firstColon).trim();
  if (!token) return null;
  if (/^\+?[\d\s\-().]{4,}$/.test(token)) return null; // numeric → a number, not a label
  if (token.length > 40) return null; // too long → a real CNAM, not a ring-group label
  return token;
}

function isShortExtensionValue(value: string | null | undefined): boolean {
  const digits = digitsOnly(value);
  return digits.length >= 2 && digits.length <= 6;
}

function isExternalDialTarget(value: string | null | undefined): boolean {
  const digits = digitsOnly(value);
  return digits.length >= 10 && digits.length <= 15;
}

function hasStrongOutboundEvidence(call: NormalizedCall): boolean {
  return isShortExtensionValue(call.source_extension || call.from) && isExternalDialTarget(call.to);
}

/** All short subscriber extensions seen on SIP legs plus VitalPBX `extensions[]` hints. */
function collectUniqueShortExtensionPeers(call: NormalizedCall): Set<string> {
  const out = new Set<string>();
  for (const ch of call.channels) {
    const ex = normalizeExtensionFromChannel(ch);
    if (ex) out.add(ex);
  }
  for (const raw of call.extensions) {
    const wrapped = /^PJSIP\//i.test(raw) ? raw : `PJSIP/${raw}`;
    const ex = normalizeExtensionFromChannel(wrapped);
    if (ex) out.add(ex);
  }
  return out;
}

/**
 * VitalPBX emits `trk-<provider>-in` CDR contexts for BOTH true PSTN ingress and for the
 * provider-facing leg of an outbound external dial. When live AMI state already settled to
 * outbound/internal before this CDR, and we see exactly one subscriber extension family
 * against a PSTN `to`, treat the leg as ambiguous and do NOT force `direction=inbound`.
 */
function suppressTrkInboundDcontextMisclass(call: NormalizedCall): boolean {
  if (call.direction !== "outbound" && call.direction !== "internal") return false;
  if (!isExternalDialTarget(call.to)) return false;
  return collectUniqueShortExtensionPeers(call).size === 1;
}

/** Extract a "vpbx:{slug}" tenantId from a CDR dcontext or accountCode value (or null if none found). */
function resolveTenantFromCdrFields(dcontext?: string, accountCode?: string): string | null {
  const contextToCheck = dcontext || "";
  if (contextToCheck) {
    const ctx = contextToCheck.toLowerCase();
    for (const pfx of VPBX_CTX_PREFIXES) {
      if (ctx.startsWith(pfx)) {
        const slug = contextToCheck.slice(pfx.length).trim();
        if (slug && !/^\d+$/.test(slug)) return `vpbx:${slug}`;
      }
    }
  }
  if (accountCode) {
    const code = accountCode.trim();
    if (code && !/^\d+$/.test(code)) return `vpbx:${code}`;
  }
  return null;
}

export class CallStateStore extends EventEmitter {
  // Primary map: linkedId → NormalizedCall
  private calls = new Map<string, NormalizedCall>();

  // Secondary index: Asterisk Uniqueid (channel uniqueid) → callId (linkedId)
  private channelIndex = new Map<string, string>();
  private channelByUniqueId = new Map<string, string>();

  // Optional hook to map `vpbx:<slug>` / raw slug → Connect tenant CUID at
  // ingest time so downstream tenant filters (which compare against a viewer's
  // JWT CUID) don't need alias-awareness. Wired from telephony/index.ts with
  // PbxTenantMapCache.resolveBySlug.
  private slugToConnectIdResolver: ((slug: string) => string | null) | null = null;

  // Bridge → canonical callId (first call to join bridge wins; others merge into it)
  private bridgeIndex = new Map<string, string>();

  // Pending eviction timers
  private evictTimers = new Map<string, NodeJS.Timeout>();

  // Recording paths captured from AMI VarSet (MIXMONITOR_FILENAME / __REC_FILENAME)
  // keyed by linkedId. VarSet frequently fires BEFORE any Newchannel event we'd
  // track (MixMonitor runs inside a Local-channel macro whose linkedid may equal
  // the surviving call's linkedid). We stash the path here until a matching call
  // is upserted, then apply it — so we never lose recording metadata.
  // Also acts as a cache so re-applies during the call's lifetime are idempotent.
  private pendingRecordingPaths = new Map<string, string>();
  // Evict stale pending paths after this long so the map doesn't grow unbounded
  // for calls whose linkedid never ended up in the main store.
  private static PENDING_REC_TTL_MS = 60 * 60 * 1000; // 1h
  private pendingRecTimers = new Map<string, NodeJS.Timeout>();

  /** Register the slug→Connect-CUID resolver. Called once at startup so
   *  CDR-only ingest paths prefer a canonical Connect tenant id over a
   *  `vpbx:<slug>` alias that regular-user tenant filters can't match.
   */
  setSlugToConnectIdResolver(resolver: (slug: string) => string | null): void {
    this.slugToConnectIdResolver = resolver;
  }

  /** Register the PBX-tenant-code→Connect-CUID resolver (e.g. "T102" → cuid).
   *  Wired at startup from PbxTenantMapCache.resolveConnectTenant. This is the
   *  authoritative path — see extractPbxTenantCodeFromCallFields. */
  private tenantCodeToConnectIdResolver: ((tenantCode: string) => string | null) | null = null;
  setTenantCodeToConnectIdResolver(resolver: (tenantCode: string) => string | null): void {
    this.tenantCodeToConnectIdResolver = resolver;
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  getAll(): NormalizedCall[] {
    return [...this.calls.values()];
  }

  /** Active calls only: PBX-call truth is one bridge with two or more non-helper participants. */
  getActive(): NormalizedCall[] {
    return [...this.calls.values()].filter((c) => {
      if (c.state === "hungup") return false;
      if (c.state !== "up" && c.state !== "held") return false;
      if (isLocalOnlyCall(c)) return false;
      if (!hasValidBridgedParticipants(c)) return false;
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

  /**
   * Resolve the canonical AMI callId (linkedId) that owns a given Asterisk
   * bridge. The bridge unique id is the SAME value AMI reports as
   * `BridgeUniqueid` and ARI reports as `bridge.id`, so this lets the ARI-sourced
   * WS snapshot reuse the AMI call's id. Keeping one id namespace across the
   * initial snapshot and the live upsert/remove deltas is what lets a hang-up
   * (`callRemove(linkedId)`) actually clear the row a client received in its
   * snapshot. Returns undefined when AMI hasn't tracked this bridge.
   */
  getCallIdByBridgeId(bridgeId: string): string | undefined {
    if (!bridgeId) return undefined;
    const callId = this.bridgeIndex.get(bridgeId);
    if (callId && this.calls.has(callId)) return callId;
    return undefined;
  }

  /** Returns true if any channelIndex entry points to this callId (i.e. the call has a live Asterisk channel). */
  hasLiveChannelIndex(callId: string): boolean {
    for (const lid of this.channelIndex.values()) {
      if (lid === callId) return true;
    }
    return false;
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
        hasValidBridgedParticipants(c) ? "hasValidBridgedParticipants" : "NO_VALID_BRIDGE",
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
    tenantSlug: string | null;
    tenantName: string | null;
    direction: CallDirection;
    pbxVitalTenantId?: string | null;
    pbxTenantCode?: string | null;
  }): NormalizedCall {
    this.channelIndex.set(params.uniqueid, params.linkedId);
    this.channelByUniqueId.set(params.uniqueid, params.channel);

    let call = this.calls.get(params.linkedId);
    if (!call) {
      call = this.createEmpty(params.linkedId, params.tenantId, params.tenantSlug, params.direction);
      call.from = params.callerIDNum || null;
      call.to = params.exten || null;
      call.tenantSlug = params.tenantSlug;
      call.tenantName = params.tenantName;
      if (params.pbxVitalTenantId) call.metadata["pbxVitalTenantId"] = params.pbxVitalTenantId;
      if (params.pbxTenantCode) call.metadata["pbxTenantCode"] = params.pbxTenantCode;
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ callId: params.linkedId, channel: params.channel, tenantId: params.tenantId }, "live_call: call_created");
      }
    } else if (env.ENABLE_TELEPHONY_DEBUG && !call.channels.includes(params.channel)) {
      log.debug({ callId: params.linkedId, channel: params.channel }, "live_call: call_merged_deduped");
    }

    if (params.pbxVitalTenantId) call.metadata["pbxVitalTenantId"] = params.pbxVitalTenantId;
    if (params.pbxTenantCode) call.metadata["pbxTenantCode"] = params.pbxTenantCode;
    if (params.context) call.metadata["lastContext"] = params.context;
    // Only store a real extension — never let helper/catch-all entries like "s" or "h"
    // overwrite a previously stored extension (e.g. "103").  The first Newchannel event
    // for the originating leg carries the dialled number; subsequent ringing-device legs
    // use "s" which is useless for an AMI Redirect back into the dialplan.
    if (params.exten && params.exten !== "s" && params.exten !== "h") {
      call.metadata["lastExten"] = params.exten;
    } else if (!call.metadata["lastExten"] && params.exten) {
      call.metadata["lastExten"] = params.exten;
    }
    call.channelState = params.channelState || call.channelState;
    if (looksLikeExtension(params.callerIDNum) && !call.source_extension) {
      call.source_extension = params.callerIDNum;
    }
    if (looksLikeExtension(params.exten) && !call.destination_extension) {
      call.destination_extension = params.exten;
    }

    // Upgrade tenantId/tenantName when newly resolved (e.g. trunk Newchannel fires after internal leg)
    if (!call.tenantId && params.tenantId) {
      call.tenantId = params.tenantId;
      call.tenantSlug = params.tenantSlug;
      call.tenantName = params.tenantName;
    } else if (!call.tenantSlug && params.tenantSlug) {
      call.tenantSlug = params.tenantSlug;
    }

    // Upgrade `to` from short extension to real DID when a longer number becomes available.
    // VitalPBX: first Newchannel may set exten=extension(e.g."108"); trunk channel sets exten=DID.
    const existingToDigits = (call.to ?? "").replace(/\D/g, "");
    const newExtenDigits = (params.exten ?? "").replace(/\D/g, "");
    if (newExtenDigits.length >= 10 && existingToDigits.length < 10) {
      call.to = params.exten;
    }

    // Capture CNAM from the first meaningful CallerIDName seen.
    // Exclude: generic placeholders, and purely numeric values (e.g. a DID "8457823064"
    // that VitalPBX puts in CallerIDName on extension channels for display purposes).
    const GENERIC_NAMES = new Set(["", "unknown", "Unknown", "UNKNOWN", "Wireless Caller", "Anonymous", "anonymous", "<unknown>"]);
    const isNumericOnly = /^\+?[\d\s\-().]{6,}$/.test(params.callerIDName ?? "");
    if (!call.fromName && params.callerIDName && !GENERIC_NAMES.has(params.callerIDName) && !isNumericOnly) {
      call.fromName = params.callerIDName;
    }

    // Capture the ring-group CID prefix as a SEPARATE field (never merged into
    // fromName/number). The bare inbound trunk leg has no prefix; the ring-group
    // member-dial legs (e.g. PJSIP/T2_103) carry the prefixed CallerIDName like
    // "Estimates:Caller". First non-null wins. This is what feeds the prefix tag
    // shown on the live ring screen and call history.
    if (!call.fromPrefix) {
      const pfx = extractRingGroupPrefix(params.callerIDName);
      if (pfx) call.fromPrefix = pfx;
    }

    if (!call.channels.includes(params.channel)) {
      call.channels.push(params.channel);
    }
    markExtensionLegSeen(call, params.channel);
    markExtensionLegResponded(call, params.channel, params.channelState);
    // Accumulate all seen channels in metadata so they survive post-hangup channel clear.
    // CdrNotifier uses this for PJSIP endpoint → tenant resolution.
    const seen = (call.metadata["seenChannels"] as string[] | undefined) ?? [];
    if (!seen.includes(params.channel)) {
      call.metadata["seenChannels"] = [...seen, params.channel];
    }
    // Normalize channel → bare dialplan extension (strips PJSIP/ driver,
    // T{n}_ VitalPBX tenant prefix, -<uniqueid> suffix, @host).
    const chExt = normalizeExtensionFromChannel(params.channel);
    if (chExt && !call.extensions.includes(chExt)) call.extensions.push(chExt);
    // Also seed from dialplan `exten` so the dialed-to extension is captured
    // even before the answering channel appears. Skip helper codes (`s`,`h`).
    if (looksLikeExtension(params.exten) && !call.extensions.includes(params.exten)) {
      call.extensions.push(params.exten);
    }
    // And from caller ID number when it clearly is an extension (internal calls).
    if (looksLikeExtension(params.callerIDNum) && !call.extensions.includes(params.callerIDNum)) {
      call.extensions.push(params.callerIDNum);
    }

    const prevState = call.state;
    const channelState = channelStateToCallState(params.channelState);
    if (shouldUpgradeState(call.state, channelState)) {
      call.state = channelState;
      if (channelState === "up" && !call.answeredAt) {
        call.answeredAt = new Date().toISOString();
      }
      if (
        channelState === "up" &&
        !call.extensionAnsweredAt &&
        isExtensionLegChannel(params.channel)
      ) {
        call.extensionAnsweredAt = new Date().toISOString();
        call.extensionAnsweredChannel = params.channel ?? null;
      }
    }
    this.debugBlfCallTransition(call, prevState, "Newchannel", {
      uniqueid: params.uniqueid,
      channel: params.channel,
      rawChannelState: params.channelState,
    });
    call.connectedLine = params.connectedLineNum || call.connectedLine;

    // Direction priority is evidence-based. Inbound trunk legs can arrive after
    // extension legs, but VitalPBX outbound calls also create a `trk-*-in` trunk
    // channel for the outbound provider leg. Do not let that later trunk channel
    // flip a strongly identified extension -> PSTN call into inbound.
    if (params.direction === "inbound") {
      if (call.direction === "unknown" || call.direction === "inbound" || !hasStrongOutboundEvidence(call)) {
        call.direction = "inbound";
      } else {
        log.info(
          {
            callId: call.id,
            currentDirection: call.direction,
            channel: params.channel,
            context: params.context,
            from: call.from,
            to: call.to,
            sourceExtension: call.source_extension,
          },
          "live_call: ignored inbound trunk hint for outbound extension call",
        );
      }
    } else if (call.direction === "unknown" && params.direction !== "unknown") {
      call.direction = params.direction;
    }

    this.calls.set(params.linkedId, call);
    // Apply any recording path that arrived via VarSet before the call existed.
    this.drainPendingRecordingPath(params.linkedId);
    this.emit("callUpsert", { ...call });
    return call;
  }

  // Called on NewCallerid — VitalPBX fires this exactly when the ring-group
  // dialplan runs `Set(CALLERID(name)=Prefix:...)`. This is the most direct
  // signal of the prefix; we capture it into the separate fromPrefix tag field.
  onNewCallerid(params: { linkedId: string; uniqueid: string; callerIDName: string }): void {
    let call = this.calls.get(params.linkedId);
    if (!call) {
      const cid = this.channelIndex.get(params.uniqueid);
      call = cid ? this.calls.get(cid) : undefined;
    }
    if (!call || call.state === "hungup") return;
    if (call.fromPrefix) return;
    const pfx = extractRingGroupPrefix(params.callerIDName);
    if (!pfx) return;
    call.fromPrefix = pfx;
    this.emit("callUpsert", { ...call });
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

    const prevState = call.state;
    const newState = channelStateToCallState(params.channelState);
    const channel = this.channelByUniqueId.get(params.uniqueid);
    markExtensionLegSeen(call, channel);
    markExtensionLegResponded(call, channel, params.channelState);
    if (shouldUpgradeState(call.state, newState)) {
      call.state = newState;
      // Mark answeredAt the first time a channel goes Up (state 6).
      // BridgeEnter also sets this; whichever fires first wins (both are guarded by !answeredAt).
      if (newState === "up" && !call.answeredAt) {
        call.answeredAt = new Date().toISOString();
      }
      // Mark extensionAnsweredAt ONLY when the channel that just went Up is a
      // tenant-extension leg (mobile/desk/WebRTC). Trunk-leg "up" events
      // (e.g. inbound IVR `Answer()` to play a greeting) intentionally do NOT
      // trip this flag — see {@link NormalizedCall.extensionAnsweredAt}.
      if (
        newState === "up" &&
        !call.extensionAnsweredAt &&
        isExtensionLegChannel(channel)
      ) {
        call.extensionAnsweredAt = new Date().toISOString();
        call.extensionAnsweredChannel = channel ?? null;
      }
      if (env.ENABLE_TELEPHONY_DEBUG && (newState === "ringing" || newState === "up")) {
        log.debug({ callId: params.linkedId, state: newState }, "live_call: call_marked_ringing_or_talking");
      }
    }
    if (params.connectedLineNum && !call.connectedLine) {
      call.connectedLine = params.connectedLineNum;
    }
    call.channelState = params.channelState || call.channelState;
    const channelExt = normalizeExtensionFromChannel(channel);
    if (channelExt && !call.extensions.includes(channelExt)) {
      call.extensions.push(channelExt);
    }
    this.debugBlfCallTransition(call, prevState, "Newstate", {
      uniqueid: params.uniqueid,
      rawChannelState: params.channelState,
    });

    this.emit("callUpsert", { ...call });
  }

  // Called on DialBegin — mark outbound/dialing
  onDialBegin(params: {
    linkedId: string;
    callerIDNum: string;
    destination: string;
    /** Channel that invoked Dial() — used to discriminate trunk vs extension. */
    channel?: string;
    /** Dialplan context of the dialing channel at Dial() invocation time. */
    context?: string;
    /** Dialplan exten of the dialing channel at Dial() invocation time. */
    exten?: string;
    /**
     * AMI DialBegin `DialString` (e.g. `T2_110_1/sip:8hkh5htv@host:port;...`).
     * For an extension-leg dial it carries the exact contact URI the leg was
     * forked to — the Mode-B cold-answer requeue uses this to tell a freshly
     * re-registered contact apart from the contact(s) actually dialed.
     */
    dialString?: string;
  }): void {
    const call = this.calls.get(params.linkedId);
    if (!call || call.state === "hungup") return;

    // Capture the TRUNK leg's dialplan position at Dial() invocation time so
    // {@link TelephonyService.requeueLiveCallToDialplan} can issue an AMI
    // Redirect that re-executes the same Dial() (i.e., re-rings the dialed
    // extension) when the mobile cold-start answer flow asks for a requeue.
    //
    // We MUST gate on the dialing channel being a non-extension (trunk) leg.
    // Extension legs that themselves call Dial() (e.g., call-pickup, attended
    // transfer) would otherwise overwrite the trunk's position and the
    // requeue would loop the call back into an extension's COS dialplan
    // with the DID as the dialed number — producing the "answer then bounce
    // back to caller" failure mode observed in the 2026-05-04 incident.
    if (
      params.channel &&
      params.context &&
      params.exten &&
      params.exten !== "s" &&
      params.exten !== "h" &&
      !isExtensionLegChannel(params.channel) &&
      !isHelperChannel(params.channel)
    ) {
      call.metadata["trunkDialContext"] = params.context;
      call.metadata["trunkDialExten"] = params.exten;
      call.metadata["trunkDialChannel"] = params.channel;
    }

    // Capture the EXTENSION leg's own Dial() position — the context/exten from
    // which the dialplan dials the `PJSIP/T<id>_<exten>` leg (e.g.
    // `sub-local-dialing,110`). For a DIRECT inbound dial the trunk dials the
    // extension itself, so this equals the trunk position; for an IVR / auto-
    // attendant routed call the trunk's recorded Dial position is the IVR
    // context (e.g. `IVR-5`) while the extension is dialed one layer deeper from
    // a `*local-dialing*` context. The mobile cold-answer requeue
    // ({@link TelephonyService.requeueLiveCallToDialplan}) needs THIS position —
    // never the IVR or ring-group layer — to re-deliver a fresh INVITE to a
    // re-woken contact without re-running the IVR or restarting a ring group.
    // Keyed on the DIALED channel being a tenant-extension leg, so a ring-group
    // fan-out (which dials a Local/ or group context, not a PJSIP/T leg here)
    // never records a position.
    if (
      isExtensionLegChannel(params.destination) &&
      params.context &&
      params.exten &&
      params.exten !== "s" &&
      params.exten !== "h"
    ) {
      call.metadata["extLegDialContext"] = params.context;
      call.metadata["extLegDialExten"] = params.exten;

      // MODE-B cold-answer evidence (2026-06-29). Record, at the instant an
      // extension leg is dialed:
      //   • `extLegDialedAt` — wall-clock of the FIRST extension-leg Dial() on
      //     this call (not overwritten by later forks/attempts), so the requeue
      //     can ask "did a contact register AFTER this?".
      //   • `extLegAor` — the endpoint/AOR (the part before `/` in DialString,
      //     e.g. `T2_110_1`) the leg was dialed to, matching ContactStatus.aor.
      //   • `extLegDialedContacts` — the set of contact URIs actually dialed
      //     (from DialString), so a re-registered contact that was NOT dialed is
      //     detectable. JsSIP rotates the Contact URI on every register, so the
      //     fresh contact always differs from these.
      // These are evidence only; the redirect target stays `extLegDialContext`/
      // `extLegDialExten` (a direct `*local-dialing*` position), never a DID.
      if (typeof call.metadata["extLegDialedAt"] !== "number") {
        call.metadata["extLegDialedAt"] = Date.now();
      }
      const dialString = String(params.dialString ?? "");
      const slash = dialString.indexOf("/");
      if (slash > 0) {
        const aor = dialString.slice(0, slash).trim();
        const dialedUri = dialString.slice(slash + 1).trim();
        if (aor && typeof call.metadata["extLegAor"] !== "string") {
          call.metadata["extLegAor"] = aor;
        }
        if (dialedUri) {
          const existing = Array.isArray(call.metadata["extLegDialedContacts"])
            ? (call.metadata["extLegDialedContacts"] as string[])
            : [];
          if (!existing.includes(dialedUri)) {
            call.metadata["extLegDialedContacts"] = [...existing, dialedUri];
          }
        }
      }
    }

    // Earliest possible signal that the dialplan is delivering this call to a
    // real extension endpoint (mobile/desk/WebRTC). Recording it here — before
    // the leg's own Newchannel — closes the race where a DND/declined leg sends
    // a fast 486 and is torn down before the live-leg gate can observe it.
    markExtensionLegSeen(call, params.destination);

    // ── Authoritative tenant from the dialed leg's own name (2026-08-29) ──────
    // On the SignalWire inbound path the trunk leg carries no DID in its exten
    // (the request-URI user is literally "s"), so the call reaches DialBegin
    // with tenantId still NULL — and THIS event is the one that adds the
    // extension and triggers MobilePushNotifier's ONE-SHOT ring push. The
    // tenant marker is sitting right here in params.destination
    // (`Local/T102_101_1@connect-mobile-wake-dial/n`, `PJSIP/T102_101`);
    // throwing it away meant the ring notify went out with connectTenantId
    // null and the api guessed ext "101" across tenants — the Loopcom Demo
    // call's INCOMING_CALL push was delivered to ANOTHER company's user
    // (Trimpro) and the demo iPhone never rang (2026-08-29, linkedId
    // 1788055211.42054; the tenant resolved 2 ms AFTER the push fired).
    // Fill-only: never overrides a tenant already resolved, and
    // extractPbxTenantCodeFromCallFields returns null on conflicting markers.
    if (!call.tenantId && this.tenantCodeToConnectIdResolver) {
      const dialTenantCode = extractPbxTenantCodeFromCallFields(
        params.destination,
        params.channel,
        params.context,
        params.exten,
      );
      if (dialTenantCode) {
        const resolvedTenantId = this.tenantCodeToConnectIdResolver(dialTenantCode);
        if (resolvedTenantId) {
          call.tenantId = resolvedTenantId;
          call.metadata["pbxTenantCode"] = dialTenantCode;
          if (!call.metadata["pbxVitalTenantId"]) {
            call.metadata["pbxVitalTenantId"] = dialTenantCode.replace(/^T/i, "");
          }
        }
      }
    }

    const callerDigits = (params.callerIDNum ?? "").replace(/\D/g, "");
    const callerShort = callerDigits.length >= 2 && callerDigits.length <= 6;

    const prevState = call.state;
    if (call.direction === "unknown") {
      // The originating channel is placing a dial — internal if destination is clearly an extension
      call.direction = isInternalExtension(params.destination) ? "internal" : "outbound";
    } else if (
      call.direction === "outbound" &&
      callerShort &&
      isInternalExtension(params.destination)
    ) {
      // VitalPBX often labels the first Newchannel as outbound (T{n}_cos-*) even when the
      // extension is dialing another extension (105 → 101). Promote to internal.
      call.direction = "internal";
    }
    if (call.state === "unknown" || call.state === "ringing") {
      call.state = "dialing";
    }
    const destExt = normalizeExtensionFromChannel(params.destination) ?? (looksLikeExtension(params.destination) ? params.destination : null);
    if (destExt && !call.extensions.includes(destExt)) {
      call.extensions.push(destExt);
    }
    if (destExt && !call.destination_extension) call.destination_extension = destExt;
    const callerExt = looksLikeExtension(params.callerIDNum) ? params.callerIDNum : null;
    if (callerExt && !call.extensions.includes(callerExt)) {
      call.extensions.push(callerExt);
    }
    if (callerExt && !call.source_extension) call.source_extension = callerExt;
    this.debugBlfCallTransition(call, prevState, "DialBegin", {
      callerIDNum: params.callerIDNum,
      destination: params.destination,
    });

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
    // Reconcile grace anchor: a freshly-bridged call must never be evicted by a
    // stale ARI snapshot (see RECONCILE_BRIDGE_GRACE_MS).
    call.metadata["lastBridgeEnterAtMs"] = Date.now();
    const bridgeChannel = this.channelByUniqueId.get(params.uniqueid);
    markExtensionLegSeen(call, bridgeChannel);
    const bridgeExt = normalizeExtensionFromChannel(bridgeChannel);
    if (bridgeExt && !call.extensions.includes(bridgeExt)) {
      call.extensions.push(bridgeExt);
    }

    const canonicalCallId = this.bridgeIndex.get(bridgeId);
    if (canonicalCallId !== undefined && canonicalCallId !== params.linkedId) {
      this.mergeCallInto(params.linkedId, canonicalCallId);
      call = this.calls.get(canonicalCallId);
      if (!call) return;
    } else {
      this.bridgeIndex.set(bridgeId, params.linkedId);
    }

    const prevState = call.state;
    if (parseInt(params.bridgeNumChannels, 10) >= 2) {
      // Two or more parties are now in a bridge — somebody is really talking to
      // the caller. This is the ONLY honest "bridged to an answering party"
      // signal; `bridgeIds` is already non-empty one event earlier (a single
      // channel entering a bridge for MOH/parking/announcement). See
      // NormalizedCall.multiPartyBridgeAt for the Hanna incident this fixes.
      if (!call.multiPartyBridgeAt) {
        call.multiPartyBridgeAt = new Date().toISOString();
      }
      if (call.state !== "up") {
        call.state = "up";
        call.answeredAt = new Date().toISOString();
        if (env.ENABLE_TELEPHONY_DEBUG) {
          log.debug({ callId: call.id }, "live_call: call_marked_talking");
        }
      }
      // Mark extensionAnsweredAt only when an extension leg is the one
      // joining (or already in) this multi-party bridge. A bridge of trunk +
      // IVR Local helper would not satisfy this — the joining channel must
      // be a real `PJSIP/T<id>_<exten>...` leg.
      if (!call.extensionAnsweredAt) {
        const joiningChannel = this.channelByUniqueId.get(params.uniqueid);
        const anyExtensionInBridge =
          isExtensionLegChannel(joiningChannel) ||
          call.channels.some((ch) => isExtensionLegChannel(ch));
        if (anyExtensionInBridge) {
          call.extensionAnsweredAt = new Date().toISOString();
          call.extensionAnsweredChannel = isExtensionLegChannel(joiningChannel)
            ? (joiningChannel ?? null)
            : (call.channels.find((ch) => isExtensionLegChannel(ch)) ?? null);
        }
      }
    }
    this.debugBlfCallTransition(call, prevState, "BridgeEnter", {
      uniqueid: params.uniqueid,
      bridgeId: params.bridgeId,
      bridgeNumChannels: params.bridgeNumChannels,
    });

    this.emit("callUpsert", { ...call });
  }

  private mergeCallInto(fromCallId: string, intoCallId: string): void {
    const fromCall = this.calls.get(fromCallId);
    const intoCall = this.calls.get(intoCallId);
    if (!fromCall || !intoCall || fromCallId === intoCallId) return;

    for (const ch of fromCall.channels) {
      if (!intoCall.channels.includes(ch)) intoCall.channels.push(ch);
    }
    // Merge seenChannels metadata so the accumulated channel history is preserved
    const fromSeen = (fromCall.metadata["seenChannels"] as string[] | undefined) ?? fromCall.channels;
    const intoSeen = (intoCall.metadata["seenChannels"] as string[] | undefined) ?? [...intoCall.channels];
    for (const ch of fromSeen) {
      if (!intoSeen.includes(ch)) intoSeen.push(ch);
    }
    intoCall.metadata["seenChannels"] = intoSeen;
    for (const br of fromCall.bridgeIds) {
      if (!intoCall.bridgeIds.includes(br)) intoCall.bridgeIds.push(br);
    }
    for (const ext of fromCall.extensions) {
      if (!intoCall.extensions.includes(ext)) intoCall.extensions.push(ext);
    }
    if (fromCall.from && !intoCall.from) intoCall.from = fromCall.from;
    if (fromCall.to && !intoCall.to) intoCall.to = fromCall.to;
    if (fromCall.source_extension && !intoCall.source_extension) intoCall.source_extension = fromCall.source_extension;
    if (fromCall.destination_extension && !intoCall.destination_extension) intoCall.destination_extension = fromCall.destination_extension;
    if (fromCall.channelState && !intoCall.channelState) intoCall.channelState = fromCall.channelState;
    if (fromCall.answeredAt && !intoCall.answeredAt) intoCall.answeredAt = fromCall.answeredAt;
    if (fromCall.extensionAnsweredAt && !intoCall.extensionAnsweredAt) {
      intoCall.extensionAnsweredAt = fromCall.extensionAnsweredAt;
      intoCall.extensionAnsweredChannel = fromCall.extensionAnsweredChannel ?? intoCall.extensionAnsweredChannel ?? null;
    }
    if (fromCall.metadata["extensionLegSeen"]) {
      intoCall.metadata["extensionLegSeen"] = true;
    }
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
    // The name the store recorded for this uniqueid — may differ from the
    // Hangup event's channel string when Asterisk renamed the channel
    // (masquerade / <ZOMBIE> suffix). Read BEFORE deleting the mapping.
    const recordedChannelName = this.channelByUniqueId.get(params.uniqueid);
    this.channelIndex.delete(params.uniqueid);
    this.channelByUniqueId.delete(params.uniqueid);

    let call = this.calls.get(params.linkedId);
    if (!call && callIdByChannel !== undefined) {
      call = this.calls.get(callIdByChannel) ?? undefined;
    }
    if (!call) return;

    // Remove by BOTH names: the event's channel string and whatever name the
    // store recorded for this uniqueid. Exact-name-only matching left renamed
    // channels in the list forever — the call never emptied, never went
    // hungup, and sat "stuck" on Active Calls until the 60s sweeper.
    call.channels = call.channels.filter(
      (ch) => ch !== params.channel && (recordedChannelName === undefined || ch !== recordedChannelName),
    );

    // A call with no live channel in the index is OVER, no matter what
    // stale strings remain in call.channels (renames, missed events). This is
    // the exact-second hangup invariant: the last real channel's Hangup ends
    // the call NOW, not at the next cleanup sweep.
    if (call.channels.length > 0 && !this.hasLiveChannelIndex(call.id)) {
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug(
          { callId: call.id, staleChannels: call.channels },
          "live_call: no_live_channel_invariant_forced_hangup",
        );
      }
      call.channels = [];
    } else if (call.channels.length > 0 && this.ariRefutesCallChannels(call.id)) {
      // ARI-refuted stale legs (2026-08-31): this Hangup is real, and every
      // OTHER channel the store still holds for the call is provably absent
      // from a fresh ARI snapshot it predates — i.e. its own Hangup was missed
      // (rename/AMI gap). Ending the call NOW instead of waiting for the
      // reconciler/60s sweep is what keeps Active Calls and Team Directory in
      // exact sync with the wire. The refuted uids are dropped from the index
      // so no ghost bookkeeping survives.
      const staleUids = this.uniqueIdsForCall(call.id);
      for (const uid of staleUids) {
        this.channelIndex.delete(uid);
        this.channelByUniqueId.delete(uid);
      }
      log.info(
        { callId: call.id, staleUids, staleChannels: call.channels },
        "live_call: ari_refuted_stale_legs_forced_hangup",
      );
      call.channels = [];
    }

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

  // Called on CDR — update billing seconds, fix direction/from/to if still unknown.
  // The AMI CDR event fires after Hangup while the call is still in the 30s retention window,
  // so CdrNotifier will run again with the updated (better) data.
  onCdr(params: {
    linkedId: string;
    uniqueid?: string;
    duration: string;
    billableSeconds: string;
    disposition: string;
    source?: string;
    destination?: string;
    dcontext?: string;
    accountCode?: string;
    channel?: string;
    destChannel?: string;
    lastApplication?: string;
  }): void {
    const call = this.calls.get(params.linkedId);
    if (!call) {
      // ── Orphan-CDR safety net (2026-08-04) ─────────────────────────────────
      // The Cdr event is Asterisk's own end-of-call report; it fires whether or
      // not the live tracker still knows the call. A call can be gone here
      // because it was force-evicted (stale ARI snapshot), because this service
      // restarted mid-call, or because the Cdr arrived after the retention
      // window. Losing the event = the call vanishes from every customer's
      // history — 71 calls on Aug 4, 179 on Aug 3. Synthesize a minimal call
      // and hand it to CdrNotifier; the API upserts by linkedId, so several
      // orphan legs (and any provisional eviction record) merge into one row.
      //
      // EXCEPT self-rooted Local fork legs: a queue/ring-group agent attempt is
      // a Local/ channel whose Cdr event carries no parent linkage, so its
      // linkedId collapses to its own uniqueid. Filing those creates one
      // phantom "missed call" row PER AGENT for every queue ring (verified
      // live: 1785865090.16349x — six phantom rows for one Gesheft call whose
      // real record 1785865079.163486 already existed). A Local leg that DOES
      // carry its parent's linkedId (e.g. the ring-group forward legs that are
      // a forwarded call's only Cdr records) still files normally.
      const isSelfRootedLocalFork =
        /^Local\//i.test(String(params.channel ?? "")) &&
        !!params.uniqueid &&
        params.linkedId === params.uniqueid;
      if (isSelfRootedLocalFork) {
        if (env.ENABLE_TELEPHONY_DEBUG) {
          log.debug({ linkedId: params.linkedId, channel: params.channel }, "cdr: orphan local fork leg skipped");
        }
        return;
      }
      this.emit("orphanCdr", this.synthesizeCallFromCdrEvent(params));
      return;
    }

    const dur = parseInt(params.duration, 10);
    const bill = parseInt(params.billableSeconds, 10);
    if (!isNaN(dur) && dur > call.durationSec) call.durationSec = dur;
    if (!isNaN(bill) && bill > call.billableSec) call.billableSec = bill;
    // Call-level disposition merges by PRIORITY, not last-write-wins. A call
    // forked to several devices emits one Cdr event per fork; the losing forks
    // report NO ANSWER and can arrive AFTER the answered leg's event. Live bug
    // 2026-07-28 (first day AMI Cdr events were enabled): an answered 30s call
    // classified "missed" because the unanswered fork's event landed last.
    // ANSWERED must always win; anything beats an empty value.
    {
      const dispRank = (d: string) =>
        d === "ANSWERED" ? 4 : d === "BUSY" ? 3 : d === "NO ANSWER" ? 2 : d ? 1 : 0;
      const prevDisp = String(call.metadata["cdrDisposition"] ?? "").toUpperCase().trim();
      const newDisp = String(params.disposition ?? "").toUpperCase().trim();
      if (dispRank(newDisp) > dispRank(prevDisp)) {
        call.metadata["cdrDisposition"] = params.disposition;
      }
    }

    // Populate from/to from CDR source/destination if missing
    if (params.source && !call.from) call.from = params.source;
    if (params.destination && !call.to) call.to = params.destination;
    if (looksLikeExtension(params.source) && !call.source_extension) call.source_extension = params.source!;
    if (looksLikeExtension(params.destination) && !call.destination_extension) call.destination_extension = params.destination!;

    // Seed call.extensions from CDR source/destination when they are bare
    // extensions. This backfills the extension set for calls whose channel
    // strings didn't expose a dialable extension (e.g. trunk legs).
    if (looksLikeExtension(params.source) && !call.extensions.includes(params.source!)) {
      call.extensions.push(params.source!);
    }
    if (looksLikeExtension(params.destination) && !call.extensions.includes(params.destination!)) {
      call.extensions.push(params.destination!);
    }
    if (params.channel) {
      const chExt = normalizeExtensionFromChannel(params.channel);
      if (chExt && !call.extensions.includes(chExt)) call.extensions.push(chExt);
    }

    // Store raw CDR fields for downstream use
    if (params.dcontext) call.metadata["cdrDcontext"] = params.dcontext;
    if (params.accountCode) call.metadata["cdrAccountCode"] = params.accountCode;

    if (params.dcontext) {
      const prev = (call.metadata["cdrDcontexts"] as string[] | undefined) ?? [];
      const d = params.dcontext.trim();
      if (d && !prev.includes(d)) {
        call.metadata["cdrDcontexts"] = [...prev, d];
      }
      const h = extractPbxTenantHintsFromContext(params.dcontext);
      if (h.vitalTenantId) call.metadata["pbxVitalTenantId"] = h.vitalTenantId;
      if (h.tenantCode) call.metadata["pbxTenantCode"] = h.tenantCode;
    }

    // If tenant still unresolved, try to extract from dcontext or accountCode.
    // dcontext may be "ext-local-a_plus_center" → slug "a_plus_center". Prefer
    // the Connect tenant CUID when we know the mapping; only fall back to the
    // `vpbx:<slug>` alias when we don't. This is critical so tenant-scoped WS
    // snapshots (which filter by strict CUID equality against the viewer's JWT
    // tenant) actually include these calls for regular users.
    // ── Authoritative: the tenant marker the PBX stamps on the call ───────────
    // This runs FIRST and is allowed to CORRECT a tenant already set from weaker
    // evidence. The old code below is gated on `!call.tenantId`, i.e. the first
    // leg to arrive won permanently and no later leg could fix it — so a call
    // that opened on a shared or trunk leg kept the wrong company for its whole
    // life. That is what mislabelled 116 calls into other tenants' history in a
    // single week (~3% of matched calls: "how often a weak leg arrives first").
    //
    // Evidence beats arrival order. A `T<n>_` marker comes from Asterisk, cannot
    // be forged upstream, and therefore overrides anything guessed earlier.
    const pbxTenantCode = extractPbxTenantCodeFromCallFields(params.dcontext, (params as any).channel);
    if (pbxTenantCode && this.tenantCodeToConnectIdResolver) {
      const authoritative = this.tenantCodeToConnectIdResolver(pbxTenantCode);
      if (authoritative && call.tenantId !== authoritative) {
        if (call.tenantId) {
          // Visible on purpose: every line here is a call that WOULD have been
          // labelled with the wrong company under the old first-leg-wins rule.
          console.warn(
            "[TENANT_CORRECTED] call=%s was=%s now=%s marker=%s dcontext=%s",
            call.linkedId, call.tenantId, authoritative, pbxTenantCode, params.dcontext ?? "",
          );
          // ISOLATION: while mislabelled, this call was broadcast to the WRONG
          // tenant's screens. callRemove goes to ALL clients, so emitting it
          // here clears the row from the wrong tenant the second the marker
          // corrects it; the callUpsert at the end of this method re-adds it
          // for the right tenant only. Without this, the wrong company watched
          // someone else's call sit on their Active Calls for its whole life.
          this.emit("callRemove", call.id);
        }
        call.tenantId = authoritative;
      }
    }

    if (!call.tenantId && (params.dcontext || params.accountCode)) {
      const resolved = resolveTenantFromCdrFields(params.dcontext, params.accountCode);
      if (resolved) {
        if (this.slugToConnectIdResolver && resolved.startsWith("vpbx:")) {
          const slug = resolved.slice(5);
          const canonical = this.slugToConnectIdResolver(slug);
          call.tenantId = canonical ?? resolved;
          if (!call.tenantSlug) call.tenantSlug = slug;
        } else {
          call.tenantId = resolved;
          if (!call.tenantSlug && resolved.startsWith("vpbx:")) {
            call.tenantSlug = resolved.slice(5);
          }
        }
      }
    }

    // Accumulate each CDR leg so CdrNotifier can detect and emit separate outbound PSTN legs.
    // This captures the per-leg src/dst/context data that gets lost when the call is aggregated.
    const legEntry = {
      source:      (params.source      ?? "").trim(),
      destination: (params.destination ?? "").trim(),
      dcontext:    (params.dcontext    ?? "").trim(),
      duration:    isNaN(dur)  ? 0 : dur,
      billableSec: isNaN(bill) ? 0 : bill,
      disposition: (params.disposition ?? "").trim(),
      lastApplication: (params.lastApplication ?? "").trim(),
    };
    if (legEntry.source || legEntry.destination) {
      const prevLegs = (call.metadata["cdrLegs"] as typeof legEntry[] | undefined) ?? [];
      // Dedupe key MUST include lastApplication AND disposition: a
      // ring-to-voicemail flow emits "Dial"/NO ANSWER then "VoiceMail"/ANSWERED
      // with identical src/dst/dcontext, and a multi-device fork emits
      // "Dial"/ANSWERED + "Dial"/NO ANSWER (one per fork — verified in PBX CDR
      // 2026-07-28). The old narrower keys silently dropped whichever leg
      // arrived second — including the ANSWERED leg that proves a human took
      // the call.
      const isDupe = prevLegs.some(
        (l) =>
          l.source      === legEntry.source &&
          l.destination === legEntry.destination &&
          l.dcontext    === legEntry.dcontext &&
          (l.lastApplication ?? "") === legEntry.lastApplication &&
          (l.disposition ?? "") === legEntry.disposition,
      );
      if (!isDupe) call.metadata["cdrLegs"] = [...prevLegs, legEntry];
    }

    // Direction correction from AMI Cdr event fields.
    // dcontext is the MOST AUTHORITATIVE direction signal — it reflects the Asterisk
    // dialplan context that originated the call (e.g. "ext-local-gesheft" = internal/outbound,
    // "from-trunk" = inbound). This MUST override any earlier heuristic that may have
    // misclassified the call (e.g. Newchannel trunk leg setting "inbound" on an outbound call
    // whose caller-ID is a 10-digit DID).
    const dctx = (params.dcontext ?? "").toLowerCase();
    const destBare = (params.destination ?? "").replace(/\D/g, "");
    const destIsShortExt = /^\d{2,6}$/.test(destBare);
    const destIsLongPstn = /^\d{10,}$/.test(destBare.replace(/^1(\d{10})$/, "$1"));

    const prevDir = call.direction;
    let dcontextDir: CallDirection | null = null;

    if (
      dctx.includes("from-trunk") || dctx.includes("from-pstn") ||
      dctx.includes("from-external") || dctx.includes("inbound") ||
      /^ivr-\d/.test(dctx)
    ) {
      dcontextDir = "inbound";
    } else if (
      /^trk-[^-]+-in/.test(dctx) &&
      !suppressTrkInboundDcontextMisclass(call)
    ) {
      // See {@link suppressTrkInboundDcontextMisclass}: `trk-*-in` alone is ambiguous.
      dcontextDir = "inbound";
    } else if (
      dctx.includes("from-internal") || dctx.includes("ext-local") || dctx.includes("outbound") ||
      /^trk-[^-]+-dial/.test(dctx) ||
      /^t\d+_cos-/.test(dctx) ||
      dctx.includes("sub-local-dialing")
    ) {
      if (destIsShortExt) dcontextDir = "internal";
      else if (destIsLongPstn) dcontextDir = "outbound";
      else dcontextDir = "outbound"; // ext-local context with ambiguous dest = still outbound
    }

    if (dcontextDir) {
      if (dcontextDir === "inbound" && hasStrongOutboundEvidence(call)) {
        log.info(
          {
            callId: call.id,
            dcontext: params.dcontext,
            from: call.from,
            to: call.to,
            sourceExtension: call.source_extension,
          },
          "cdr: ignored inbound dcontext for outbound extension call",
        );
      } else if (dcontextDir === "inbound") {
        // Authoritative from-trunk CDR: lock the call as inbound and set a permanent flag.
        // Any later from-internal CDR events (outbound PSTN legs of the same linkedId) must
        // NOT flip this direction — those legs are emitted as separate records by CdrNotifier.
        call.direction = "inbound";
        call.metadata["inboundConfirmedByCdr"] = true;
      } else if (!call.metadata["inboundConfirmedByCdr"]) {
        // Only update direction when not yet confirmed as inbound by a real from-trunk CDR.
        // For hybrid inbound→PSTN-outbound flows this guard keeps the main record as inbound.
        call.direction = dcontextDir;
      }
      // else: call is inbound-confirmed; non-inbound CDR context is for a separate outbound leg.
      if (prevDir !== call.direction) {
        log.info(
          { callId: call.id, prev: prevDir, now: call.direction, dcontext: params.dcontext },
          "cdr: dcontext overrode direction"
        );
      }
    } else if (call.direction === "unknown" && params.source && params.destination) {
      // Fallback: number-length heuristic only when dcontext gave no signal AND direction is still unknown.
      const srcDigits = params.source.replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
      const dstDigits = params.destination.replace(/[^\d]/g, "").replace(/^1(\d{10})$/, "$1");
      const srcLong = srcDigits.length >= 10;
      const dstLong = dstDigits.length >= 10;
      const srcShort = srcDigits.length >= 2 && srcDigits.length <= 6;
      const dstShort = dstDigits.length >= 2 && dstDigits.length <= 6;
      if (srcShort && dstLong) call.direction = "outbound";
      else if (srcLong && dstShort) call.direction = "inbound";
      else if (srcShort && dstShort) call.direction = "internal";
      else if (srcLong) call.direction = "inbound";
    }

    this.emit("callUpsert", { ...call });
  }

  /**
   * Build a minimal NormalizedCall from a raw AMI Cdr event for a call the
   * store no longer tracks (see the orphan-CDR net in {@link onCdr}). Times
   * avoid trusting the PBX's local-time strings: startedAt comes from the
   * linkedId's epoch prefix (Asterisk linkedids are `<epoch>.<seq>`), endedAt
   * is "now" (the Cdr event fires at call end), answeredAt is back-computed
   * from billableSeconds. Direction is left "unknown" — CdrNotifier derives it
   * from the dcontext exactly as it does for tracked calls, and the API's
   * resolver re-derives tenant attribution from the same fields.
   */
  private synthesizeCallFromCdrEvent(params: {
    linkedId: string;
    duration: string;
    billableSeconds: string;
    disposition: string;
    source?: string;
    destination?: string;
    dcontext?: string;
    accountCode?: string;
    channel?: string;
    destChannel?: string;
    lastApplication?: string;
  }): NormalizedCall {
    const dur = Math.max(0, parseInt(params.duration, 10) || 0);
    const bill = Math.max(0, parseInt(params.billableSeconds, 10) || 0);
    const nowMs = Date.now();
    const epochMatch = /^(\d{10})\.\d+$/.exec(params.linkedId);
    const startedMs = epochMatch ? Number(epochMatch[1]) * 1000 : nowMs - dur * 1000;
    const disp = String(params.disposition ?? "").toUpperCase().trim();
    const answeredMs = disp === "ANSWERED" && bill > 0 ? nowMs - bill * 1000 : null;

    let tenantId: string | null = null;
    const pbxTenantCode = extractPbxTenantCodeFromCallFields(
      params.dcontext,
      params.channel,
      params.destChannel,
    );
    if (pbxTenantCode && this.tenantCodeToConnectIdResolver) {
      tenantId = this.tenantCodeToConnectIdResolver(pbxTenantCode);
    }
    if (!tenantId && (params.dcontext || params.accountCode)) {
      const resolved = resolveTenantFromCdrFields(params.dcontext, params.accountCode);
      if (resolved) {
        if (this.slugToConnectIdResolver && resolved.startsWith("vpbx:")) {
          tenantId = this.slugToConnectIdResolver(resolved.slice(5)) ?? resolved;
        } else {
          tenantId = resolved;
        }
      }
    }

    const leg = {
      source: (params.source ?? "").trim(),
      destination: (params.destination ?? "").trim(),
      dcontext: (params.dcontext ?? "").trim(),
      duration: dur,
      billableSec: bill,
      disposition: (params.disposition ?? "").trim(),
      lastApplication: (params.lastApplication ?? "").trim(),
    };

    const channels = [params.channel, params.destChannel]
      .map((c) => String(c ?? "").trim())
      .filter(Boolean);

    return {
      id: params.linkedId,
      linkedId: params.linkedId,
      tenantId,
      tenantSlug: null,
      tenantName: null,
      direction: "unknown",
      state: "hungup",
      from: params.source?.trim() || null,
      fromName: null,
      fromPrefix: null,
      to: params.destination?.trim() || null,
      connectedLine: null,
      source_extension: looksLikeExtension(params.source) ? params.source!.trim() : null,
      destination_extension: looksLikeExtension(params.destination) ? params.destination!.trim() : null,
      channelState: null,
      channels,
      bridgeIds: [],
      extensions: [],
      queueId: null,
      trunk: null,
      startedAt: new Date(startedMs).toISOString(),
      answeredAt: answeredMs ? new Date(answeredMs).toISOString() : null,
      extensionAnsweredAt: null,
      endedAt: new Date(nowMs).toISOString(),
      durationSec: dur,
      billableSec: bill,
      metadata: {
        source: "ami_cdr_orphan",
        cdrDisposition: params.disposition,
        ...(params.dcontext ? { cdrDcontext: params.dcontext, cdrDcontexts: [params.dcontext] } : {}),
        ...(params.accountCode ? { cdrAccountCode: params.accountCode } : {}),
        ...(pbxTenantCode ? { pbxTenantCode } : {}),
        cdrLegs: leg.source || leg.destination ? [leg] : [],
      },
    };
  }

  // Called when AMI reports the MIXMONITOR_FILENAME (or equivalent) VarSet.
  // Stores the absolute filesystem path on the PBX (e.g.
  // /var/spool/asterisk/monitor/<tenant_hash>/YYYY/MM/DD/<name>.wav) against the
  // linkedId so the CDR payload can include it at Hangup.
  // Multiple VarSets may fire per call — we prefer paths that include a tenant
  // hash directory (longer, more specific) over the initial "bare" path.
  //
  // If the call is not yet tracked (VarSet fires before the first Newchannel we
  // see is normalized), we buffer the path in pendingRecordingPaths and apply
  // it when the call gets created in upsertChannel.
  setRecordingPath(linkedId: string, path: string): void {
    if (!linkedId || !path) return;

    const call = this.calls.get(linkedId);
    if (!call) {
      // Buffer until the call is tracked.
      const pending = this.pendingRecordingPaths.get(linkedId);
      const chosen = this.preferLongerRecordingPath(pending, path);
      if (chosen && chosen !== pending) {
        this.pendingRecordingPaths.set(linkedId, chosen);
        this.armPendingRecTimer(linkedId);
        if (env.ENABLE_TELEPHONY_DEBUG) {
          log.debug({ linkedId, path: chosen }, "recording: pending_path_buffered");
        }
      }
      return;
    }

    const existing = (call.metadata["recordingAbsPath"] as string | undefined) ?? null;
    const chosen = this.preferLongerRecordingPath(existing, path);
    if (chosen !== existing) {
      call.metadata["recordingAbsPath"] = chosen;
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ linkedId, path: chosen }, "recording: path_set");
      }
    }
    // IVR/DID-fronted inbound calls expose the destination extension ONLY in the
    // recording filename (the trunk leg never parses to an extension during the
    // IVR). Resolve it and emit a callUpsert so MobilePushNotifier sends the
    // native "ring now" push for mobile-only extensions that would otherwise
    // silently drop to voicemail.
    if (this.applyRecordingDestExtension(call, chosen ?? path)) {
      this.emit("callUpsert", { ...call });
    }
  }

  /**
   * Resolve and attach the IVR/DID destination extension parsed from the
   * recording filename. Returns true iff a new extension was added (so the
   * caller should emit a callUpsert to re-run the mobile push pipeline).
   *
   * Default-on for all tenants; set PBX_IVR_DEST_RESOLVE=0 to disable. Only
   * applied to inbound/internal calls — outbound recordings encode the dialed
   * PSTN number, not a local extension, and must never be treated as a ring
   * target. MobilePushNotifier still owns all caller/self-ring filtering, so
   * adding the destination here is strictly additive.
   */
  private applyRecordingDestExtension(call: NormalizedCall, path: string | null): boolean {
    if ((process.env.PBX_IVR_DEST_RESOLVE ?? "1") !== "1") return false;
    if (call.direction !== "inbound" && call.direction !== "internal") return false;
    const ext = parseDestExtenFromRecordingPath(path, call.linkedId);
    if (!ext) return false;
    if (call.extensions.includes(ext)) {
      if (!call.destination_extension) call.destination_extension = ext;
      return false;
    }
    call.extensions.push(ext);
    if (!call.destination_extension) call.destination_extension = ext;
    call.metadata["ivrDestExtenFromRecording"] = ext;
    log.info(
      { linkedId: call.linkedId, ext, dir: call.direction },
      "recording: resolved IVR/DID destination extension for mobile ring push",
    );
    return true;
  }

  /** Return the "better" of two candidate paths: prefer the one with a deeper
   *  directory (tenant-hash prefix) and discard nothing — fallback to the
   *  non-empty one. Returns null if both are null/empty. */
  private preferLongerRecordingPath(a: string | null | undefined, b: string | null | undefined): string | null {
    const aa = (a ?? "").trim();
    const bb = (b ?? "").trim();
    if (!aa && !bb) return null;
    if (!aa) return bb;
    if (!bb) return aa;
    // Prefer path with more directory segments (tenant-hash / YYYY / MM / DD / file).
    const aSegs = aa.split("/").filter(Boolean).length;
    const bSegs = bb.split("/").filter(Boolean).length;
    if (bSegs > aSegs) return bb;
    if (aSegs > bSegs) return aa;
    // Tie break: prefer the newer one (later VarSet usually wins).
    return bb;
  }

  private armPendingRecTimer(linkedId: string): void {
    const existing = this.pendingRecTimers.get(linkedId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.pendingRecordingPaths.delete(linkedId);
      this.pendingRecTimers.delete(linkedId);
    }, CallStateStore.PENDING_REC_TTL_MS);
    if (typeof (t as any).unref === "function") (t as any).unref();
    this.pendingRecTimers.set(linkedId, t);
  }

  /** Drain any buffered recording path for linkedId onto the live call (if any). */
  private drainPendingRecordingPath(linkedId: string): void {
    const pending = this.pendingRecordingPaths.get(linkedId);
    if (!pending) return;
    const call = this.calls.get(linkedId);
    if (!call) return;
    const existing = (call.metadata["recordingAbsPath"] as string | undefined) ?? null;
    const chosen = this.preferLongerRecordingPath(existing, pending);
    if (chosen && chosen !== existing) {
      call.metadata["recordingAbsPath"] = chosen;
      if (env.ENABLE_TELEPHONY_DEBUG) {
        log.debug({ linkedId, path: chosen }, "recording: pending_path_applied");
      }
    }
    if (this.applyRecordingDestExtension(call, chosen ?? pending)) {
      this.emit("callUpsert", { ...call });
    }
    this.pendingRecordingPaths.delete(linkedId);
    const t = this.pendingRecTimers.get(linkedId);
    if (t) { clearTimeout(t); this.pendingRecTimers.delete(linkedId); }
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
    tenantSlug: string | null,
    direction: CallDirection,
  ): NormalizedCall {
    return {
      id: linkedId,
      linkedId,
      tenantId,
      tenantSlug,
      tenantName: null,
      fromName: null,
      fromPrefix: null,
      direction,
      state: "unknown",
      from: null,
      to: null,
      connectedLine: null,
      source_extension: null,
      destination_extension: null,
      channelState: null,
      channels: [],
      bridgeIds: [],
      extensions: [],
      queueId: null,
      trunk: null,
      startedAt: new Date().toISOString(),
      answeredAt: null,
      extensionAnsweredAt: null,
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
    for (const uid of uidsToDelete) {
      this.channelIndex.delete(uid);
      this.channelByUniqueId.delete(uid);
    }
    this.emitCallRemove(callId);
  }

  /** Clear all call state (e.g. on AMI disconnect). Emits callRemove for each known call. */
  clearAll(): void {
    for (const t of this.evictTimers.values()) clearTimeout(t);
    this.evictTimers.clear();
    this.bridgeIndex.clear();
    // An AMI disconnect must not erase in-flight calls from history: file a
    // provisional CDR for every active call before dropping state. If the call
    // is still live, post-reconnect AMI events rebuild it and the eventual Cdr
    // event corrects the record via linkedId upsert.
    for (const call of this.calls.values()) {
      if (call.state === "hungup") continue;
      if (!ACTIVE_STATES.includes(call.state)) continue;
      call.state = "hungup";
      call.endedAt = new Date().toISOString();
      call.metadata["staleEvictReason"] = "ami_disconnect_clear_all";
      this.emit("callEvicted", { ...call });
    }
    const ids = [...this.calls.keys()];
    this.calls.clear();
    this.channelIndex.clear();
    this.channelByUniqueId.clear();
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

  private debugBlfCallTransition(
    call: NormalizedCall,
    previousState: CallState,
    source: string,
    extra: Record<string, unknown>,
  ): void {
    if (!env.ENABLE_BLF_DEBUG) return;
    if (previousState === call.state && source !== "BridgeEnter") return;
    log.info(
      {
        source,
        callId: call.id,
        linkedId: call.linkedId,
        tenantId: call.tenantId,
        extensions: call.extensions,
        previousState,
        nextState: call.state,
        reason: source,
        ...extra,
      },
      "blf: call_state_transition",
    );
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
      const call = this.calls.get(id);
      if (call && call.state !== "hungup") {
        call.state = "hungup";
        call.endedAt = new Date().toISOString();
        call.metadata["staleEvictReason"] = "stale_duration";
        this.emit("callEvicted", { ...call });
      }
      this.evictCallNow(id);
    }
    for (const id of toMarkHungupAndSchedule) {
      const call = this.calls.get(id);
      if (!call) continue;
      call.state = "hungup";
      call.endedAt = new Date().toISOString();
      call.metadata["staleEvictReason"] = "ghost_no_live_channel";
      // Same contract as forceEvictZombie: cleanup must never eat the CDR.
      this.emit("callEvicted", { ...call });
      this.emitCallRemove(id);
      this.scheduleEvict(id);
    }
  }

  /**
   * Force-evict a zombie/stale call from the store regardless of channel state.
   * Returns the call's channel strings so the caller can issue AMI Hangup for each.
   * Safe to call even if the call is already gone.
   */
  /**
   * The uniqueids currently indexed to this call — read-only, no side effects.
   *
   * These are what ARI's raw `/channels` snapshot reports as channel `id`, so
   * they are the authoritative way to ask Asterisk "does this call still
   * exist?" (`reconcileLiveChannels` compares the same values). Exposed so a
   * caller can verify liveness BEFORE deciding to touch a call.
   */
  uniqueIdsForCall(callId: string): string[] {
    const uniqueIds: string[] = [];
    for (const [uid, lid] of this.channelIndex) {
      if (lid === callId) uniqueIds.push(uid);
    }
    return uniqueIds;
  }

  forceEvictZombie(callId: string, reason: string): { channels: string[]; uniqueIds: string[] } {
    const call = this.calls.get(callId);
    if (!call) return { channels: [], uniqueIds: [] };

    const channels = [...call.channels];
    const uniqueIds = this.uniqueIdsForCall(callId);

    call.state = "hungup";
    call.endedAt = new Date().toISOString();
    call.metadata["staleEvictReason"] = reason;

    log.warn(
      { callId, channels, uniqueIds, reason },
      "live_call: zombie_force_evicted",
    );

    // File the CDR with whatever this call knows. Eviction used to emit only
    // callRemove — CdrNotifier listens for hungup callUpserts, so an evicted
    // call whose real AMI Cdr event arrived after the retention window was
    // permanently missing from history (the 2026-08-04 loss). The record is
    // provisional; the AMI Cdr event (via the store or the orphanCdr net)
    // upserts the same linkedId later with authoritative duration/disposition.
    this.emit("callEvicted", { ...call });

    this.emitCallRemove(callId);
    this.scheduleEvict(callId);

    return { channels, uniqueIds };
  }

  /**
   * Zombie reconciliation against the RAW ARI channel list — the unfilterable
   * liveness truth. AMI can miss a Hangup edge and leave a call stuck in `up`;
   * this catches those within ~2 polls so Active Calls and BLF clear fast.
   *
   * REWRITTEN 2026-08-04 (was reconcileActiveBridges): membership in the
   * QUALIFYING-bridge list is the wrong liveness signal — a queue/ring-group
   * call is two half-bridges (trunk↔Local, Local↔agent), each with one
   * non-Local leg, so `computeBridgedActiveCalls` excludes BOTH by design and
   * the old reconciler force-evicted the live call (265 evictions on Aug 3; a
   * Gesheft call was killed 40s into a talk even with strikes+grace). A call is
   * dead only when NONE of its channels exist in ARI's raw /channels snapshot —
   * Local helpers included, no qualifying rules.
   *
   * Kept guards: two consecutive absent polls, plus a young-call/young-bridge
   * grace window (a channel created moments before the snapshot round-trip may
   * legitimately be missing from it).
   */
  private reconcileAbsentStrikes = new Map<string, number>();

  // Latest RAW ARI /channels snapshot, cached on every reconcile pass so the
  // hangup handler can consult it synchronously (ariRefutesCallChannels).
  private lastAriChannelSet: Set<string> | null = null;
  private lastAriSetAtMs = 0;

  /**
   * True when a FRESH, non-empty ARI snapshot proves that every channel the
   * store still indexes for this call is dead: each uniqueid is absent from
   * the raw /channels list AND its creation epoch predates the snapshot by the
   * safety margin (so, if alive, it HAD to appear in it).
   *
   * ⛔ Fails toward "cannot refute" on every doubt: no snapshot, stale
   * snapshot, EMPTY snapshot (an ARI hiccup returning an empty list must not
   * end every call at once — the strike-guarded reconciler covers a genuinely
   * idle PBX within ~2 polls), unparseable uniqueid, or a channel younger than
   * the snapshot.
   */
  private ariRefutesCallChannels(callId: string): boolean {
    const set = this.lastAriChannelSet;
    if (!set || set.size === 0) return false;
    const setAt = this.lastAriSetAtMs;
    if (Date.now() - setAt > ARI_SET_FRESH_MS) return false;
    const uids = this.uniqueIdsForCall(callId);
    if (uids.length === 0) return false;
    return uids.every((uid) => {
      if (set.has(uid)) return false;
      const epochMs = uniqueidEpochMs(uid);
      return epochMs !== null && epochMs <= setAt - UNIQUEID_EPOCH_SAFETY_MS;
    });
  }

  reconcileLiveChannels(rawChannelIds: Iterable<string>): void {
    const live = new Set(rawChannelIds);
    const seenThisRound = new Set<string>();
    const now = Date.now();
    this.lastAriChannelSet = live;
    this.lastAriSetAtMs = now;

    // uniqueids per call, from the index (the store's own liveness bookkeeping).
    const uidsByCall = new Map<string, string[]>();
    for (const [uid, cid] of this.channelIndex) {
      const arr = uidsByCall.get(cid);
      if (arr) arr.push(uid);
      else uidsByCall.set(cid, [uid]);
    }

    // WIDENED 2026-08-31: sweep EVERY tracked call in an active state, not just
    // getActive(). getActive() keeps only up/held calls with a qualifying
    // bridge — so a ringing/dialing call, or a call that dropped below two
    // valid legs after a missed Hangup, vanished from snapshots but was never
    // reconciled and never got a callRemove on the delta stream. Connected
    // clients kept it (and the extension stuck "On Call") until the 60s ghost
    // sweep. ARI's raw channel list is the liveness truth for ALL of them:
    // if none of a call's channels exist there, the call is done.
    // The 2-strike + young-call/young-bridge grace guards are unchanged.
    for (const call of this.calls.values()) {
      if (call.state === "hungup") continue;
      if (!ACTIVE_STATES.includes(call.state)) continue;
      seenThisRound.add(call.id);

      const uids = uidsByCall.get(call.id) ?? [];
      if (uids.length === 0) {
        // Nothing indexed — ARI can neither confirm nor refute. The ghost
        // sweep owns this shape (no_live_channel).
        this.reconcileAbsentStrikes.delete(call.id);
        continue;
      }
      if (uids.some((uid) => live.has(uid))) {
        this.reconcileAbsentStrikes.delete(call.id);
        continue;
      }

      const startedMs = new Date(call.startedAt).getTime();
      const callAgeOk = !isNaN(startedMs) && now - startedMs >= RECONCILE_BRIDGE_GRACE_MS;
      const lastBridgeEnterAtMs = Number(call.metadata["lastBridgeEnterAtMs"] ?? 0);
      const bridgeAgeOk = !lastBridgeEnterAtMs || now - lastBridgeEnterAtMs >= RECONCILE_BRIDGE_GRACE_MS;
      if (!callAgeOk || !bridgeAgeOk) {
        this.reconcileAbsentStrikes.delete(call.id);
        continue;
      }

      const strikes = (this.reconcileAbsentStrikes.get(call.id) ?? 0) + 1;
      if (strikes < RECONCILE_ABSENT_STRIKES_REQUIRED) {
        this.reconcileAbsentStrikes.set(call.id, strikes);
        continue;
      }
      this.reconcileAbsentStrikes.delete(call.id);
      this.forceEvictZombie(
        call.id,
        `ari_no_live_channel uids=${uids.join(",") || "(none)"} strikes=${strikes}`,
      );
    }
    // Drop strike entries for calls that left the store between polls.
    for (const id of this.reconcileAbsentStrikes.keys()) {
      if (!seenThisRound.has(id)) this.reconcileAbsentStrikes.delete(id);
    }
  }

  /**
   * Start a background timer that periodically runs stale/ghost cleanup.
   * This ensures ghosts are removed even when no new WS clients connect.
   */
  private staleCleanupTimer: ReturnType<typeof setInterval> | null = null;

  startPeriodicStaleCleanup(intervalMs = 60_000): void {
    if (this.staleCleanupTimer) return;
    this.staleCleanupTimer = setInterval(() => {
      try {
        this.runStaleCleanup();
      } catch (err) {
        log.error({ err }, "live_call: periodic_stale_cleanup_error");
      }
    }, intervalMs);
    if (this.staleCleanupTimer.unref) this.staleCleanupTimer.unref();
    log.info({ intervalMs }, "live_call: periodic_stale_cleanup_started");
  }

  stopPeriodicStaleCleanup(): void {
    if (this.staleCleanupTimer) {
      clearInterval(this.staleCleanupTimer);
      this.staleCleanupTimer = null;
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
  const order: CallState[] = ["unknown", "dialing", "ringing", "up", "held", "hungup"];
  return order.indexOf(next) > order.indexOf(current);
}


function isInternalExtension(dest: string): boolean {
  // Strip SIP URI parameters and get the base part before '@'
  const bare = dest.split("@")[0] ?? "";

  // Plain short number: 101, 205, 1001, etc.
  if (/^\d{2,6}$/.test(bare)) return true;

  // Local/{ext}@{context} — VitalPBX IVR routing to an extension
  // e.g. Local/105@T11_ivr-only-extensions-00000dec;1 → bare = "Local/105"
  if (/^Local\/(\d{2,6})$/.test(bare)) return true;

  // PJSIP/T{n}_{ext}-{hex} or PJSIP/{ext}-{hex} — VitalPBX tenant extension channels
  // e.g. PJSIP/T11_105-00002d2a, PJSIP/T18_101-00002d27
  // Must NOT match trunk channels like PJSIP/344022_trust-xxxx (trunk prefix = all digits + slug)
  const pjsipM = /^(?:PJSIP|SIP)\/([A-Za-z]\d+_)?(\d{2,6})(?:-[\da-f]+)?$/i.exec(bare);
  if (pjsipM) return true;

  return false;
}
