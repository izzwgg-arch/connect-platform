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

export type MobilePushRingPayload = {
  linkedId: string;
  toExtension: string;
  fromNumber: string | null;
  fromDisplay: string | null;
  /** Ring-group CID prefix (deduped), rendered as a tag on the ring screen. */
  fromPrefix?: string | null;
  connectTenantId: string | null;
  pbxVitalTenantId: string | null;
  state?: "ringing" | "hungup" | "diverted_to_voicemail" | "answered_elsewhere";
  /**
   * True when a tenant extension leg actually answered this call
   * (extensionAnsweredAt). The API uses it to suppress the user-visible
   * "Missed call" alert on hangup for calls that were answered on a desk
   * phone / another endpoint — those are not missed calls.
   */
  answered?: boolean;
  /**
   * PJSIP endpoint of the leg that ANSWERED (e.g. `T141_101_1`), derived from
   * {@link NormalizedCall.extensionAnsweredChannel}. The api uses it to tell
   * "answered on the desk phone — stop the apps" apart from "answered BY the
   * invited app whose claim lost a race" — the second must never receive a
   * cancel push (it kills the live call; Hanna 2026-08-21). Null when the
   * answering channel is unknown — the api then behaves as before.
   */
  answeredEndpoint?: string | null;
};

/**
 * Fires a mobile push notification to the API when an inbound call rings at an extension.
 * This bridges the telephony service (which sees all PBX events) to the API's
 * CallInvite + Expo push pipeline (which requires knowledge of registered devices).
 *
 * Pattern mirrors CdrNotifier: fire-and-forget HTTP POST to /internal/mobile-ring-notify.
 */
/** `PJSIP/T141_101_1-0000125e` → `T141_101_1`; null for trunk/Local/unknown channels. */
export function answeredEndpointFromChannel(channel: string | null | undefined): string | null {
  const m = /^PJSIP\/(T\d+_\d+(?:_\d+)?)-/i.exec(String(channel ?? ""));
  return m ? m[1] : null;
}

export class MobilePushNotifier {
  private readonly url: string | undefined;
  private readonly prewakeUrl: string | undefined;
  private readonly secret: string | undefined;
  private readonly prewakeEnabled: boolean;
  // De-dupe set: once we have found extensions and sent a push for a linkedId,
  // skip subsequent callUpsert events for the same call.
  private readonly pushed = new Set<string>();
  /** One-shot stop-ring notify per call so we do not spam /internal/mobile-ring-notify. */
  private readonly voicemailStopSent = new Set<string>();
  /** One-shot answered-elsewhere stop-ring notify per call. */
  private readonly answeredStopSent = new Set<string>();
  /** One-shot inbound pre-wake per call so we do not spam /internal/mobile-prewake. */
  private readonly preWoken = new Set<string>();
  /** One-shot contact-liveness probe per call. */
  private readonly qualified = new Set<string>();
  /**
   * AMI handle for the on-ring contact-liveness probe. Injected by
   * telephony/index.ts; absent in tests, where the probe simply no-ops.
   */
  private ami: { sendAction(action: string, fields?: Record<string, string>): string } | null = null;
  /**
   * Ask the PBX to verify, at ring time, that a mobile endpoint's registered
   * contacts are actually alive.
   *
   * WHY: a phone that slept and lost its socket leaves a contact bound for at
   * least 10 minutes (`minimum_expiration=600`), and the PBX only re-checks on
   * its own 30s `qualify_frequency` cycle. Inside that window the dead contact
   * looks healthy, so the call is dialled straight into a dead socket →
   * `cause 3 - No route to destination` → voicemail. That is the Luxure ext-101
   * failure. One probe here (qualify_timeout=3) collapses the window from ≤30s
   * to ~3s at the only moment it matters — far cheaper than raising
   * `qualify_frequency` fleet-wide, which costs battery on every device
   * continuously (phone radios idle ~10-20s after any packet).
   *
   * DEFAULT OFF: this makes the read-only PBX emit SIP OPTIONS and therefore
   * needs the owner's explicit mandate. Set PBX_CONTACT_QUALIFY_ON_RING=1.
   */
  private readonly qualifyOnRing = process.env.PBX_CONTACT_QUALIFY_ON_RING === "1";

  /** Injected after construction so the probe can use the existing AMI link. */
  setAmi(ami: { sendAction(action: string, fields?: Record<string, string>): string }): void {
    this.ami = ami;
  }

  constructor() {
    const base = env.CDR_INGEST_URL
      ? env.CDR_INGEST_URL.replace(/\/[^/]+$/, "")
      : undefined;
    this.url = base ? `${base}/mobile-ring-notify` : undefined;
    this.prewakeUrl = base ? `${base}/mobile-prewake` : undefined;
    this.secret = env.CDR_INGEST_SECRET;
    // Default-on; flip PBX_INBOUND_PREWAKE=0 to disable the early-wake entirely.
    this.prewakeEnabled = (process.env.PBX_INBOUND_PREWAKE ?? "1") === "1";

    if (!this.url) {
      log.info("CDR_INGEST_URL not set — mobile ring push disabled");
    } else {
      log.info({ url: this.url, prewake: this.prewakeEnabled }, "MobilePushNotifier ready");
    }
  }

  notify(call: NormalizedCall): void {
    if (!this.url) return;

    // Verbose entry log so we can trace every call through the push pipeline.
    log.info({ linkedId: call.linkedId, state: call.state, dir: call.direction, exts: call.extensions, from: call.from, tenantId: call.tenantId }, "mobile-ring: notify-entry");

    // Hangup path: notify API so it can mark the invite CANCELED + send an
    // INVITE_CANCELED push. This is the ONLY real-time hangup signal we get
    // before CDR ingest (which arrives 20–60s later), so it's critical for
    // stopping the native ringtone the moment the caller hangs up.
    if (call.state === "hungup") {
      this.voicemailStopSent.delete(call.linkedId);
      this.answeredStopSent.delete(call.linkedId);
      this.pushed.delete(call.linkedId);
      this.preWoken.delete(call.linkedId);
      const payload: MobilePushRingPayload = {
        linkedId: call.linkedId,
        toExtension: "",
        fromNumber: call.from ?? null,
        fromDisplay: call.fromName ?? null,
        connectTenantId: call.tenantId ?? null,
        pbxVitalTenantId: (call.metadata?.pbxVitalTenantId as string | undefined) ?? null,
        state: "hungup",
        answered: call.extensionAnsweredAt != null,
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
      const payload: MobilePushRingPayload = {
        linkedId: call.linkedId,
        toExtension: "",
        fromNumber: call.from ?? null,
        fromDisplay: call.fromName ?? null,
        connectTenantId: call.tenantId ?? null,
        pbxVitalTenantId: (call.metadata?.pbxVitalTenantId as string | undefined) ?? null,
        state: "diverted_to_voicemail",
        answered: call.extensionAnsweredAt != null,
      };
      log.info(
        { linkedId: call.linkedId, connectTenantId: call.tenantId },
        "mobile-ring: notifying API of diverted_to_voicemail (stop ring)",
      );
      this.postAsync(payload).catch((err: unknown) => {
        log.warn(
          { linkedId: call.linkedId, err: (err as Error)?.message },
          "mobile-ring: voicemail divert notify failed",
        );
      });
    }

    // Answered ANYWHERE — every still-ringing mobile fork must stop NOW, not
    // at call end. Live complaints 2026-07-29: "they answer the phone and the
    // app still rings" (desk phones) and the virtual-extension case: the
    // customer answers on his CARRIER phone (follow-me leg) while the app on
    // the same handset keeps ringing. Two truthful answer signals, either
    // fires the stop:
    //   • extensionAnsweredAt — a tenant PJSIP extension leg answered
    //   • bridgeIds non-empty — the caller got BRIDGED to an answering party
    //     (covers follow-me/virtual-ext PSTN legs). IVR/voicemail pickups run
    //     as dialplan apps WITHOUT a bridge, so menus don't false-trigger.
    // The API cancels PENDING invites + pushes INVITE_CANCELED
    // (reason answered_elsewhere) and records NO missed call.
    // ⛔⛔ `bridgeIds.length > 0` USED TO BE THE SECOND TEST HERE AND IT WAS WRONG.
    // `bridgeIds` is pushed on every BridgeEnter, including the FIRST channel
    // entering a bridge alone (MOH / parking / announcement) — before anyone has
    // answered. That made this one-shot stop-ring fire an event too early, while
    // `extensionAnsweredChannel` was still null, so `answeredEndpoint` below went
    // out blank; the api could not tell the answerer was the invited app and
    // cancelled the invite + pushed INVITE_CANCELED at the phone that had just
    // answered. Hanna's dropped answer (2026-08-21) — still reproducing on
    // 2026-08-23 with the answeredEndpoint fix deployed, because the field was
    // always blank. `multiPartyBridgeAt` is set in the same handler that resolves
    // the answering channel and BEFORE its emit, so the endpoint is always
    // populated by the time we read it here.
    //
    // ⛔ Both arms are still needed. The extension arm covers a desk/app answer;
    // the bridge arm covers the follow-me / virtual-extension case where the
    // customer answers on their CARRIER phone and no tenant extension leg ever
    // answers — that must still stop the app ringing (2026-07-29 complaint).
    const answeredByAnyParty =
      call.extensionAnsweredAt != null || call.multiPartyBridgeAt != null;
    if (
      this.pushed.has(call.linkedId) &&
      !this.answeredStopSent.has(call.linkedId) &&
      answeredByAnyParty
    ) {
      this.answeredStopSent.add(call.linkedId);
      const payload: MobilePushRingPayload = {
        linkedId: call.linkedId,
        toExtension: "",
        fromNumber: call.from ?? null,
        fromDisplay: call.fromName ?? null,
        connectTenantId: call.tenantId ?? null,
        pbxVitalTenantId: (call.metadata?.pbxVitalTenantId as string | undefined) ?? null,
        state: "answered_elsewhere",
        answered: true,
        answeredEndpoint: answeredEndpointFromChannel(call.extensionAnsweredChannel),
      };
      log.info(
        { linkedId: call.linkedId, connectTenantId: call.tenantId },
        "mobile-ring: notifying API of answered_elsewhere (stop ring)",
      );
      this.postAsync(payload).catch((err: unknown) => {
        log.warn(
          { linkedId: call.linkedId, err: (err as Error)?.message },
          "mobile-ring: answered_elsewhere notify failed",
        );
      });
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

    // ── Inbound PRE-WAKE (fires BEFORE the extension is resolved) ─────────────
    // The instant we observe an inbound call for a known tenant, kick the
    // tenant's asleep mobile devices so they re-register during the IVR window —
    // before VitalPBX dials the (possibly zero-contact) extension and drops to
    // voicemail. One-shot per call. Strictly additive: the API only sends
    // caller-less wake pushes; it never creates invites or alters routing, so an
    // already-online extension is completely unaffected.
    if (call.direction === "inbound") {
      this.maybePreWake(call);
    }

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

  /**
   * One-shot inbound pre-wake. Fires only when:
   *   • the early-wake feature is enabled (PBX_INBOUND_PREWAKE != "0"),
   *   • we have a prewake URL, and
   *   • we can identify the tenant (Connect id or VitalPBX code).
   * Safe to call on every upsert — guarded by the `preWoken` set.
   */
  private maybePreWake(call: NormalizedCall): void {
    if (!this.prewakeEnabled || !this.prewakeUrl) return;
    if (this.preWoken.has(call.linkedId)) return;

    const pbxVitalTenantId = (call.metadata?.pbxVitalTenantId as string | undefined) ?? null;
    const connectTenantId = call.tenantId ?? null;
    // Without any tenant identity the API cannot resolve who to wake — skip
    // (the normal observed-ring path still runs once a contact rings).
    if (!connectTenantId && !pbxVitalTenantId) return;

    // If the target extension is already known this early, pass it so the API
    // can wake surgically; otherwise the API wakes the tenant's asleep devices.
    const knownExt = (call.extensions ?? [])
      .map(extractShortExtension)
      .find((x): x is string => x !== null) ?? null;

    this.maybeQualifyContacts(call);

    this.preWoken.add(call.linkedId);
    this.postPrewake({
      linkedId: call.linkedId,
      connectTenantId,
      pbxVitalTenantId,
      toExtension: knownExt,
      // 2026-07-16 (owner request): pass the caller number so the API's
      // prewake VoIP push (callerNumber: input.fromNumber) shows the real
      // number on the iOS lock screen instead of "Unknown". The API schema
      // already accepts fromNumber (nullable/optional) — older APIs ignore it.
      fromNumber: call.from ?? null,
    }).catch((err: unknown) => {
      log.warn(
        { linkedId: call.linkedId, err: (err as Error)?.message },
        "mobile-prewake: notify failed",
      );
    });
  }

  /**
   * Fire one `PJSIPQualify` per mobile endpoint on this call (once per call).
   * Fire-and-forget: we never block the call on the result — the PBX updates its
   * own contact status, and the dialplan's wait loop reads it a few seconds
   * later when the call actually reaches the extension.
   *
   * Scope: only `T<tenant>_<ext>_<n>` mobile siblings. Desk endpoints are wired
   * and already qualified on the normal cycle; there is nothing to gain and a
   * (tiny) packet to lose by probing them here.
   */
  private maybeQualifyContacts(call: NormalizedCall): void {
    if (!this.qualifyOnRing || !this.ami) return;
    if (this.qualified.has(call.linkedId)) return;

    const mobileEndpoints = (call.extensions ?? []).filter((raw) => /^T\d+_\d{2,6}_\d+$/i.test(String(raw)));
    if (mobileEndpoints.length === 0) return;

    this.qualified.add(call.linkedId);
    for (const endpoint of mobileEndpoints) {
      try {
        this.ami.sendAction("PJSIPQualify", { Endpoint: String(endpoint) });
        log.info({ linkedId: call.linkedId, endpoint }, "contact-qualify: probe sent");
      } catch (err: unknown) {
        log.warn({ linkedId: call.linkedId, endpoint, err: (err as Error)?.message }, "contact-qualify: probe failed (non-fatal)");
      }
    }
  }

  private async postPrewake(payload: {
    linkedId: string;
    connectTenantId: string | null;
    pbxVitalTenantId: string | null;
    toExtension: string | null;
    fromNumber?: string | null;
  }): Promise<void> {
    if (!this.prewakeUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
      const res = await fetch(this.prewakeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.secret ? { "x-cdr-secret": this.secret } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        log.info({ linkedId: payload.linkedId, connectTenantId: payload.connectTenantId }, "mobile-prewake: notified");
      } else {
        const body = await res.text().catch(() => "");
        log.warn({ status: res.status, body }, "mobile-prewake: API returned error");
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      if ((err as Error)?.name === "AbortError") {
        log.warn("mobile-prewake: API notify timed out (5s)");
      } else {
        log.warn({ err: (err as Error)?.message }, "mobile-prewake: API notify error");
      }
    }
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
