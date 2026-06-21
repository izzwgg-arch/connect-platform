import { childLogger } from "../../logging/logger";
import { env } from "../../config/env";
import { normalizeExtensionFromChannel } from "../normalizers/normalizeExtension";
import type { NormalizedCall } from "../types";

const log = childLogger("MobilePushNotifier");

// Short extension pattern: 2–6 digit numbers only (not trunk peer IDs like "344022_gesheft")
const SHORT_EXT_RE = /^\d{2,6}$/;

/**
 * Extract a plain extension number from a raw string that may be:
 *   "103"        → "103"   (direct SIP peer)
 *   "T8_103"     → "103"   (VitalPBX multi-tenant: Tcode_extension)
 *   "344022"     → null    (6-digit VitalPBX peer ID — too long or no context)
 *   "344022_gesheft" → null (not a numeric extension)
 *
 * Returns null if the string cannot be reduced to a short (2–6 digit) extension.
 */
function extractShortExtension(raw: string): string | null {
  // Direct short number: e.g. "103"
  if (SHORT_EXT_RE.test(raw)) return raw;
  // VitalPBX multi-tenant: "T{code}_{ext}" e.g. "T8_103" → "103"
  const m = /^T\d+_(\d{2,6})$/i.exec(raw);
  if (m?.[1]) return m[1];
  // Mobile / sibling contact suffix: "T8_103_1" → "103"
  const mm = /^T\d+_(\d{2,6})_\d+/i.exec(raw);
  if (mm?.[1]) return mm[1];
  return null;
}

function digitsOnly(raw: string | null | undefined): string {
  const digits = String(raw || "").replace(/\D/g, "");
  return /^1\d{10}$/.test(digits) ? digits.slice(1) : digits;
}

function isExternalDialTarget(raw: string | null | undefined): boolean {
  const digits = digitsOnly(raw);
  return digits.length >= 10 && digits.length <= 15;
}

/** Subscriber short extensions inferred from SIP legs + aggregated extension hints. */
function uniqShortSubscriberPeers(call: NormalizedCall): Set<string> {
  const out = new Set<string>();
  for (const ch of call.channels ?? []) {
    const ex = normalizeExtensionFromChannel(ch);
    if (ex) out.add(ex);
  }
  for (const raw of call.extensions ?? []) {
    const wrapped = /^PJSIP\//i.test(raw) ? raw : `PJSIP/${raw}`;
    const ex = normalizeExtensionFromChannel(wrapped);
    if (ex) out.add(ex);
  }
  return out;
}

/**
 * VitalPBX can surface carrier/provider legs (`trk-*-in`) that flip live direction to
 * "inbound" even when the user placed an outbound external call from their desk /
 * SIP phone. CID is often a company DID (10+ digits), so `selfOriginatingExt` never
 * fires. Detect the mislabel when all subscriber legs collapse to ONE extension whose
 * short id matches Caller-ID that is clearly NOT PSTN-shaped.
 *
 * IMPORTANT: Genuine PSTN→DID inbound has external Caller-ID; we bail out when
 * {@link isExternalDialTarget} is true for `call.from` so IVR / DID routes still push.
 */
function shouldSuppressInboundMislabeledOutboundSelfRing(call: NormalizedCall): boolean {
  if (call.direction !== "inbound") return false;
  if (!isExternalDialTarget(call.to)) return false;
  if (isExternalDialTarget(call.from)) return false;

  const origin =
    extractShortExtension(call.source_extension ?? "") ??
    extractShortExtension(call.from ?? "");
  if (!origin) return false;

  const peers = uniqShortSubscriberPeers(call);
  if (peers.size !== 1) return false;
  const solo = [...peers][0];
  if (solo !== origin) return false;

  return true;
}

/** True when PBX channels / dialplan context indicate the caller reached voicemail. */
export function looksDivertedToVoicemail(call: NormalizedCall): boolean {
  const chJoined = (call.channels || []).join(" ").toLowerCase();
  if (
    chJoined.includes("voicemail") ||
    chJoined.includes("vmail") ||
    chJoined.includes("@vm") ||
    chJoined.includes("app-voicemail")
  ) {
    return true;
  }
  const meta = call.metadata || {};
  const single = String(meta.cdrDcontext || "").toLowerCase();
  if (single.includes("voicemail") || single.includes("app-voicemail")) return true;
  const list = meta.cdrDcontexts;
  if (Array.isArray(list)) {
    for (const x of list) {
      const s = String(x || "").toLowerCase();
      if (s.includes("voicemail") || s.includes("app-voicemail")) return true;
    }
  }
  return false;
}

/**
 * Short extensions that currently have a LIVE leg on the call (derived from the
 * live `call.channels` list, which {@link CallStateStore.onHangup} prunes as each
 * leg drops — unlike the cumulative `call.extensions`). Used to detect when a
 * rung extension has no remaining ring/talk leg (voicemail divert or answered on
 * another endpoint).
 */
function liveExtensionsFromChannels(call: NormalizedCall): Set<string> {
  const out = new Set<string>();
  for (const ch of call.channels ?? []) {
    const ex = normalizeExtensionFromChannel(ch);
    if (ex) out.add(ex);
  }
  return out;
}

/**
 * Debounce window before declaring a rung extension's ring leg abandoned. Matches
 * the mobile native `FORK_ABANDON_STOP_MS` so ring-group fork re-INVITEs (leg
 * cancel + re-offer within ~500ms) don't trip a false stop.
 */
const RING_LEG_ABANDON_MS = 1500;

export type MobilePushRingPayload = {
  linkedId: string;
  toExtension: string;
  fromNumber: string | null;
  fromDisplay: string | null;
  /** Ring-group CID prefix (deduped), rendered as a tag on the ring screen. */
  fromPrefix?: string | null;
  connectTenantId: string | null;
  pbxVitalTenantId: string | null;
  state?: "ringing" | "hungup" | "diverted_to_voicemail";
};

/**
 * Fires a mobile push notification to the API when an inbound call rings at an extension.
 * This bridges the telephony service (which sees all PBX events) to the API's
 * CallInvite + Expo push pipeline (which requires knowledge of registered devices).
 *
 * Pattern mirrors CdrNotifier: fire-and-forget HTTP POST to /internal/mobile-ring-notify.
 */
export class MobilePushNotifier {
  private readonly url: string | undefined;
  private readonly secret: string | undefined;
  // De-dupe set: once we have found extensions and sent a push for a linkedId,
  // skip subsequent callUpsert events for the same call.
  private readonly pushed = new Set<string>();
  /** One-shot stop-ring notify per call so we do not spam /internal/mobile-ring-notify. */
  private readonly voicemailStopSent = new Set<string>();
  /** Short extensions we have actually rung (pushed) per linkedId. */
  private readonly pushedExts = new Map<string, Set<string>>();
  /** Latest call snapshot per linkedId, for re-evaluating after the debounce. */
  private readonly lastCall = new Map<string, NormalizedCall>();
  /** Pending ring-leg-abandon debounce timers per linkedId. */
  private readonly divertTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    const base = env.CDR_INGEST_URL
      ? env.CDR_INGEST_URL.replace(/\/[^/]+$/, "")
      : undefined;
    this.url = base ? `${base}/mobile-ring-notify` : undefined;
    this.secret = env.CDR_INGEST_SECRET;

    if (!this.url) {
      log.info("CDR_INGEST_URL not set — mobile ring push disabled");
    } else {
      log.info({ url: this.url }, "MobilePushNotifier ready");
    }
  }

  notify(call: NormalizedCall): void {
    if (!this.url) return;

    // Verbose entry log so we can trace every call through the push pipeline.
    log.info({ linkedId: call.linkedId, state: call.state, dir: call.direction, exts: call.extensions, from: call.from, tenantId: call.tenantId }, "mobile-ring: notify-entry");

    // Keep the freshest snapshot so the debounced ring-leg-abandon check re-evaluates
    // against current state (a fork re-INVITE that arrives during the window must win).
    this.lastCall.set(call.linkedId, call);

    // Hangup path: notify API so it can mark the invite CANCELED + send an
    // INVITE_CANCELED push. This is the ONLY real-time hangup signal we get
    // before CDR ingest (which arrives 20–60s later), so it's critical for
    // stopping the native ringtone the moment the caller hangs up.
    if (call.state === "hungup") {
      this.clearDivertTimer(call.linkedId);
      this.pushedExts.delete(call.linkedId);
      this.lastCall.delete(call.linkedId);
      this.voicemailStopSent.delete(call.linkedId);
      this.pushed.delete(call.linkedId);
      const payload: MobilePushRingPayload = {
        linkedId: call.linkedId,
        toExtension: "",
        fromNumber: call.from ?? null,
        fromDisplay: call.fromName ?? null,
        connectTenantId: call.tenantId ?? null,
        pbxVitalTenantId: (call.metadata?.pbxVitalTenantId as string | undefined) ?? null,
        state: "hungup",
      };
      log.info(
        { linkedId: call.linkedId, connectTenantId: call.tenantId, from: call.from },
        "mobile-ring: notifying API of hangup",
      );
      this.postAsync(payload).catch((err: unknown) => {
        log.warn(
          { linkedId: call.linkedId, err: (err as Error)?.message },
          "mobile-ring: hangup notify failed",
        );
      });
      return;
    }

    // Caller reached voicemail while the mobile ring pipeline is still active —
    // cancel the CallInvite + INVITE_CANCELED immediately (do not wait for hangup).
    if (
      this.pushed.has(call.linkedId) &&
      !this.voicemailStopSent.has(call.linkedId) &&
      looksDivertedToVoicemail(call)
    ) {
      this.voicemailStopSent.add(call.linkedId);
      this.clearDivertTimer(call.linkedId);
      log.info(
        { linkedId: call.linkedId, connectTenantId: call.tenantId },
        "mobile-ring: notifying API of diverted_to_voicemail (stop ring)",
      );
      this.postDivertedStop(call);
    }

    // Ring-leg-abandon detection (the reliable, PBX-channel-name-independent path).
    //
    // The legacy `looksDivertedToVoicemail` check above only fires when Asterisk
    // exposes a channel/context literally containing "voicemail". Many dialplans
    // (e.g. VitalPBX T<id>_cos-all ring groups) roll to voicemail WITHOUT such a
    // channel, so the killed app kept ringing until the caller hung up. Instead,
    // watch the LIVE channel set: once every extension we rang has lost its leg
    // (voicemail answered the trunk, or another endpoint answered) while the call
    // is still up, the call has left this device — stop the native ring.
    //
    // Debounced by RING_LEG_ABANDON_MS so a ring-group fork's brief cancel + re-
    // INVITE doesn't trip a false stop. The API only cancels PENDING invites, so a
    // device that actually answered (invite ACCEPTED) is never affected.
    // (call.state is already narrowed to non-"hungup" by the early return above.)
    if (
      this.pushed.has(call.linkedId) &&
      !this.voicemailStopSent.has(call.linkedId)
    ) {
      const rung = this.pushedExts.get(call.linkedId);
      if (rung && rung.size > 0) {
        const liveExts = liveExtensionsFromChannels(call);
        const anyStillLive = [...rung].some((ext) => liveExts.has(ext));
        if (anyStillLive) {
          // At least one rung extension still has a live leg — cancel any pending stop.
          this.clearDivertTimer(call.linkedId);
        } else if (!this.divertTimers.has(call.linkedId)) {
          const timer = setTimeout(() => {
            this.divertTimers.delete(call.linkedId);
            this.confirmRingLegAbandon(call.linkedId);
          }, RING_LEG_ABANDON_MS);
          if (typeof timer.unref === "function") timer.unref();
          this.divertTimers.set(call.linkedId, timer);
        }
      }
    }

    // Push for inbound (PSTN→extension) AND internal (extension→extension) ringing calls.
    // Allow any non-terminal state: "ringing", "unknown", "dialing", or "up".
    // We MUST allow "up" because IVR-routed calls answer the trunk leg (state→"up")
    // BEFORE the IVR creates the Local/<ext> channel that finally adds the target
    // extension to the call. Without "up" allowed, IVR-fronted DIDs never push.
    // The `pushed` dedup set prevents double-sends if multiple events qualify.
    const PUSH_ELIGIBLE_STATES = new Set(["ringing", "unknown", "dialing", "up"]);
    if (!PUSH_ELIGIBLE_STATES.has(call.state)) return;
    if (call.direction !== "inbound" && call.direction !== "internal") return;

    // Already sent a push for this call — skip.
    if (this.pushed.has(call.linkedId)) return;

    // For internal calls (ext→ext), exclude the calling extension so we only notify
    // the RECEIVING side.
    //
    // IMPORTANT: do NOT apply this filter for inbound calls. On IVR/Local-channel
    // paths Asterisk can rewrite `from` to the destination extension ("110"), which
    // would make us incorrectly drop the only recipient and skip mobile push entirely
    // when the app is closed.
    const callerExt = call.direction === "internal"
      ? extractShortExtension(call.from ?? "")
      : null;

    // Self-ring suppression for *outbound* dials only:
    // when an extension dials a 10–15 digit external target, both the desktop AOR
    // (T<id>_<ext>) and the mobile AOR (T<id>_<ext>_1) of the same extension can
    // appear in `extensions`. We must NOT push that extension's mobile, otherwise
    // the originator's own phone re-rings as if it were an incoming call.
    //
    // HARD PHONE caveat: Asterisk Caller-IDNum is frequently the company's external DID,
    // not the bare PBX extension, so `(source_extension || from)` fails to decode a short ext.
    // When all observed SIP endpoints collapse to ONE subscriber (`uniqShortSubscriberPeers`
    // size 1), treat that digit as `selfOriginatingExt` alongside the explicit CID path.
    //
    // CRITICAL: this MUST NOT apply to inbound calls. On VitalPBX-native inbound
    // (DID → IVR-X → T<id>_cos-all → ext) the dialed channel reports
    // `callerIDNum = <dest-ext>` (e.g. "103"), which Asterisk normalizes into
    // `source_extension`. Combined with `to` being the 10-digit DID, the old
    // direction-blind version of this guard incorrectly filtered the destination
    // extension out of its own push list, leading to "mobile-ring: suppressed …"
    // and a silent killed-app mobile (linkedId 1778094072.18393, A plus / T2_103,
    // 2026-05-06). Always gate on direction.
    const inferOutboundSelfOriginShort = (): string | null => {
      const direct =
        extractShortExtension(call.source_extension ?? "") ??
        extractShortExtension(call.from ?? "");
      if (direct) return direct;
      const peers = uniqShortSubscriberPeers(call);
      if (peers.size === 1) return [...peers][0];
      return null;
    };
    const selfOriginatingExt =
      call.direction !== "inbound" && isExternalDialTarget(call.to)
        ? inferOutboundSelfOriginShort()
        : null;

    if (shouldSuppressInboundMislabeledOutboundSelfRing(call)) {
      const origin =
        extractShortExtension(call.source_extension ?? "") ??
        extractShortExtension(call.from ?? "");
      const peers = uniqShortSubscriberPeers(call);
      log.info(
        {
          reason: "outbound_same_extension_family",
          linkedId: call.linkedId,
          sourceAor: call.source_extension ?? call.from ?? null,
          targetAor: call.to ?? null,
          callerExt: origin,
          targetExt: origin,
          direction: call.direction,
          extensions: call.extensions,
          channels: call.channels,
        },
        "mobile-ring: suppressed mislabeled inbound (desk outbound self-ring)",
      );
      return;
    }

    // Extract short extension numbers (e.g. "103") from the extensions list.
    // Handles both plain "103" and VitalPBX multi-tenant "T8_103" formats.
    // Trunk peer IDs (e.g. "344022_gesheft") and the calling party are filtered out.
    const toExtensions = [...new Set(
      call.extensions
        .map(extractShortExtension)
        .filter((x): x is string => x !== null && x !== callerExt && x !== selfOriginatingExt)
    )];
    if (toExtensions.length === 0) {
      if (selfOriginatingExt) {
        log.info(
          {
            linkedId: call.linkedId,
            from: call.from,
            to: call.to,
            sourceExtension: call.source_extension,
            direction: call.direction,
          },
          "mobile-ring: suppressed outbound self-ring (extension dialed external from same AOR)",
        );
      }
      // Extensions not yet resolved in this event — will retry on next callUpsert.
      return;
    }

    // Mark pushed BEFORE async calls so concurrent callUpsert events don't double-send.
    this.pushed.add(call.linkedId);

    // Record which short extensions we actually rang so the ring-leg-abandon check
    // knows whose live legs to watch for in call.channels.
    const rungSet = this.pushedExts.get(call.linkedId) ?? new Set<string>();
    for (const e of toExtensions) rungSet.add(e);
    this.pushedExts.set(call.linkedId, rungSet);

    const pbxVitalTenantId =
      (call.metadata?.pbxVitalTenantId as string | undefined) ?? null;

    for (const ext of toExtensions) {
      const payload: MobilePushRingPayload = {
        linkedId: call.linkedId,
        toExtension: ext,
        fromNumber: call.from ?? null,
        fromDisplay: call.fromName ?? null,
        fromPrefix: call.fromPrefix ?? null,
        connectTenantId: call.tenantId ?? null,
        pbxVitalTenantId,
      };

      log.info(
        {
          linkedId: call.linkedId,
          toExtension: ext,
          connectTenantId: call.tenantId,
          from: call.from,
        },
        "mobile-ring: notifying API",
      );

      this.postAsync(payload).catch((err: unknown) => {
        log.warn(
          { linkedId: call.linkedId, toExtension: ext, err: (err as Error)?.message },
          "mobile-ring: API notify failed",
        );
      });
    }
  }

  /** Cancel a pending ring-leg-abandon debounce timer for a call. */
  private clearDivertTimer(linkedId: string): void {
    const t = this.divertTimers.get(linkedId);
    if (t) {
      clearTimeout(t);
      this.divertTimers.delete(linkedId);
    }
  }

  /**
   * Fire the diverted_to_voicemail stop-ring to the API. The API only cancels
   * PENDING invites and pushes INVITE_CANCELED, so an answered call is untouched.
   */
  private postDivertedStop(call: NormalizedCall): void {
    const payload: MobilePushRingPayload = {
      linkedId: call.linkedId,
      toExtension: "",
      fromNumber: call.from ?? null,
      fromDisplay: call.fromName ?? null,
      connectTenantId: call.tenantId ?? null,
      pbxVitalTenantId: (call.metadata?.pbxVitalTenantId as string | undefined) ?? null,
      state: "diverted_to_voicemail",
    };
    this.postAsync(payload).catch((err: unknown) => {
      log.warn(
        { linkedId: call.linkedId, err: (err as Error)?.message },
        "mobile-ring: voicemail divert notify failed",
      );
    });
  }

  /**
   * Re-evaluate after the debounce window: if every rung extension still has no
   * live leg and the call is neither answered-here nor hung up, the ring has been
   * abandoned (voicemail / answered elsewhere) — tell the API to stop the ring.
   */
  private confirmRingLegAbandon(linkedId: string): void {
    const call = this.lastCall.get(linkedId);
    if (!call) return;
    if (!this.pushed.has(linkedId)) return;
    if (this.voicemailStopSent.has(linkedId)) return;
    if (call.state === "hungup") return; // hangup path already handles this
    const rung = this.pushedExts.get(linkedId);
    if (!rung || rung.size === 0) return;
    const liveExts = liveExtensionsFromChannels(call);
    if ([...rung].some((ext) => liveExts.has(ext))) return; // a leg came back

    this.voicemailStopSent.add(linkedId);
    log.info(
      { linkedId, rungExts: [...rung], channels: call.channels, state: call.state },
      "mobile-ring: ring leg abandoned (no live extension leg) — notifying API of diverted_to_voicemail (stop ring)",
    );
    this.postDivertedStop(call);
  }

  private async postAsync(payload: MobilePushRingPayload): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(this.url!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.secret ? { "x-cdr-secret": this.secret } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn(
          { status: res.status, body },
          "mobile-ring: API returned error",
        );
      } else {
        log.info({ status: res.status }, "mobile-ring: API notified ok");
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") {
        log.warn("mobile-ring: API notify timed out (8s)");
      } else {
        log.warn({ err: (err as Error)?.message }, "mobile-ring: API notify error");
      }
    }
  }
}
