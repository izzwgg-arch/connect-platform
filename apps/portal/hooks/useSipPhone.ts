"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../services/apiClient";
import { useTelephonyAudio } from "./useTelephonyAudio";

// ── Types ──────────────────────────────────────────────────────────────────

export type SipRegState =
  | "idle"
  | "connecting"
  | "registering"
  | "registered"
  | "unregistering"
  | "failed";

export type SipCallState =
  | "idle"
  | "dialing"
  | "ringing"
  | "connected"
  | "ended";

export type MicPermission = "unknown" | "granted" | "denied" | "prompt";

export type IceCandidateType = "host" | "srflx" | "relay" | "prflx" | null;

export interface SipDiagnostics {
  sipWssUrl: string | null;
  sipDomain: string | null;
  extensionNumber: string | null;
  sipUsername: string | null;
  hasTurn: boolean;
  hasStun: boolean;
  micPermission: MicPermission;
  iceGatheringState: RTCIceGatheringState | null;
  iceConnectionState: RTCIceConnectionState | null;
  /** Actual ICE candidate type in use — relay means TURN is active. */
  selectedCandidateType: IceCandidateType;
  /** True when the selected ICE path routes through a TURN relay. */
  isUsingRelay: boolean;
  /** Cumulative packets lost on inbound audio RTP stream. */
  packetsLost: number | null;
  /** Cumulative packets sent on outbound audio RTP stream. */
  packetsSent: number | null;
  /** Inbound audio jitter in milliseconds. */
  jitterMs: number | null;
  /** Round-trip time for the selected ICE candidate pair in milliseconds. */
  rttMs: number | null;
  /** Inbound bytes received total. */
  bytesReceived: number | null;
  /** Outbound bytes sent total. */
  bytesSent: number | null;
  /** Approx inbound bitrate kbps (computed from delta). */
  bitrateKbps: number | null;
  /** Audio input level 0–1 from media-source stats (if available). */
  audioLevel: number | null;
  /** True once at least one live remote audio track is attached to the element. */
  remoteAudioReceiving: boolean;
  /** Negotiated audio codec name (e.g. "opus", "PCMU"). */
  audioCodec: string | null;
  /** Computed call quality grade based on live stats. */
  qualityGrade: "excellent" | "good" | "fair" | "poor" | "failed" | null;
  /** Raw last-10 stat snapshots for debug mode. */
  rawSamples: RawStatSample[];
  lastRegError: string | null;
  lastCallError: string | null;
  webrtcEnabled: boolean;
  sipWssConfigured: boolean;
  sipDomainConfigured: boolean;
}

/** One raw stat sample for debug panel. */
export interface RawStatSample {
  ts: number;
  packetsLost: number | null;
  packetsReceived: number | null;
  packetsSent: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  bytesReceived: number | null;
  bytesSent: number | null;
  bitrateKbps: number | null;
  audioLevel: number | null;
  candidateType: IceCandidateType;
  qualityGrade: "excellent" | "good" | "fair" | "poor" | "failed";
}

export type SipPhoneState = {
  regState: SipRegState;
  callState: SipCallState;
  /** "outbound" when user placed the call, "inbound" when a SIP INVITE arrived, null when idle. */
  callDirection: "outbound" | "inbound" | null;
  remoteParty: string | null;
  muted: boolean;
  onHold: boolean;
  /** True when audio is routed to the loudest output device (speaker/headphone). */
  speakerOn: boolean;
  /** Available audio output devices for routing. Empty until first enumeration. */
  audioOutputDevices: MediaDeviceInfo[];
  /** Current audio output sink id (empty string = browser default). */
  currentSinkId: string;
  error: string | null;
  diag: SipDiagnostics;
};

export type SipPhoneActions = {
  dial: (target: string) => void;
  answer: () => void;
  hangup: () => void;
  setMute: (mute: boolean) => void;
  toggleHold: () => void;
  /** Toggle between default earpiece and loudest-speaker output device. */
  toggleSpeaker: () => void;
  /** Set audio output to a specific device sink id. */
  setAudioSinkId: (sinkId: string) => Promise<void>;
  sendDtmf: (digit: string) => void;
  /** Play a local DTMF keypad tone without sending SIP DTMF (for pre-call dialpad). */
  playDtmfTone: (digit: string) => void;
  /** Blind transfer the active call to a target extension/number. */
  transfer: (target: string) => void;
  dialpadInput: string;
  setDialpadInput: React.Dispatch<React.SetStateAction<string>>;
};

type VoiceExtension = {
  extensionNumber: string;
  displayName: string;
  sipUsername: string;
  /** PJSIP auth object username in Asterisk (e.g. "T2_103_1"). Used in SIP Authorization header. */
  authUsername?: string | null;
  hasSipPassword: boolean;
  webrtcEnabled: boolean;
  sipWsUrl: string | null;
  sipDomain: string | null;
  outboundProxy: string | null;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  dtmfMode: "RFC2833" | "SIP_INFO";
};

// ── Audio constraints ───────────────────────────────────────────────────────
// Voice-optimised: echo cancellation, noise suppression, mono, 48kHz preferred.
const VOICE_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: { ideal: 48_000 },
};

// ── JsSIP dynamic import ────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsSIPModule = any;

async function loadJsSIP(): Promise<JsSIPModule> {
  if (typeof window === "undefined") throw new Error("JsSIP requires a browser");
  const mod = await import("jssip");
  mod.default?.debug?.disable?.("JsSIP:*");
  return mod.default ?? mod;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function hasTurnServer(
  servers: Array<{ urls: string | string[] }> | undefined,
): boolean {
  if (!Array.isArray(servers)) return false;
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).startsWith("turn:") || String(u).startsWith("turns:"));
  });
}

function hasStunServer(
  servers: Array<{ urls: string | string[] }> | undefined,
): boolean {
  if (!Array.isArray(servers)) return false;
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).startsWith("stun:"));
  });
}

async function checkMicPermission(): Promise<MicPermission> {
  if (typeof window === "undefined") return "unknown";
  try {
    if (navigator.permissions) {
      const result = await navigator.permissions.query({ name: "microphone" as PermissionName });
      return result.state as MicPermission;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

interface FullStatSnapshot {
  packetsLost: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  packetsReceived: number | null;
  packetsSent: number | null;
  audioCodec: string | null;
  selectedCandidateType: IceCandidateType;
  bytesReceived: number | null;
  bytesSent: number | null;
  audioLevel: number | null;
}

/** Scrape getStats() for all audio quality + ICE fields. Non-fatal. */
async function pollCallStats(pc: RTCPeerConnection): Promise<FullStatSnapshot> {
  const result: FullStatSnapshot = {
    packetsLost: null,
    jitterMs: null,
    rttMs: null,
    packetsReceived: null,
    packetsSent: null,
    audioCodec: null,
    selectedCandidateType: null,
    bytesReceived: null,
    bytesSent: null,
    audioLevel: null,
  };
  try {
    const stats = await pc.getStats();
    const localCandidates = new Map<string, string>();
    const codecMap = new Map<string, string>();
    stats.forEach((r) => {
      if (r.type === "local-candidate" && typeof (r as any).candidateType === "string") {
        localCandidates.set(r.id, (r as any).candidateType);
      }
      if (r.type === "codec" && typeof (r as any).mimeType === "string") {
        codecMap.set(r.id, (r as any).mimeType);
      }
    });
    stats.forEach((r) => {
      if (r.type === "inbound-rtp" && (r as any).kind === "audio") {
        const ir = r as any;
        if (typeof ir.packetsLost === "number") result.packetsLost = ir.packetsLost;
        if (typeof ir.packetsReceived === "number") result.packetsReceived = ir.packetsReceived;
        if (typeof ir.jitter === "number") result.jitterMs = Math.round(ir.jitter * 1000);
        if (typeof ir.bytesReceived === "number") result.bytesReceived = ir.bytesReceived;
        if (ir.codecId && codecMap.has(ir.codecId)) {
          result.audioCodec = codecMap.get(ir.codecId)!.replace("audio/", "");
        }
      }
      if (r.type === "outbound-rtp" && (r as any).kind === "audio") {
        const or = r as any;
        if (typeof or.packetsSent === "number") result.packetsSent = or.packetsSent;
        if (typeof or.bytesSent === "number") result.bytesSent = or.bytesSent;
      }
      if (r.type === "candidate-pair" && (r as any).nominated === true) {
        const cp = r as any;
        if (typeof cp.currentRoundTripTime === "number") {
          result.rttMs = Math.round(cp.currentRoundTripTime * 1000);
        }
        const localCandType = localCandidates.get(cp.localCandidateId);
        if (localCandType) result.selectedCandidateType = localCandType as IceCandidateType;
      }
      // Audio input level from media-source (local mic level)
      if (r.type === "media-source" && (r as any).kind === "audio") {
        const ms = r as any;
        if (typeof ms.audioLevel === "number") result.audioLevel = ms.audioLevel;
      }
    });
  } catch {
    // getStats can throw if the PC is torn down
  }
  return result;
}

/** Compute a quality grade from call stats.
 *  Returns null when no stats have arrived yet (prevents false "poor" reports
 *  for short calls where getStats() never returned meaningful values). */
function computeQualityGrade(
  rttMs: number | null,
  jitterMs: number | null,
  packetsLost: number | null,
  packetsReceived: number | null,
): "excellent" | "good" | "fair" | "poor" | "failed" {
  const hasStats =
    rttMs !== null ||
    jitterMs !== null ||
    (packetsLost !== null && packetsReceived !== null);
  if (!hasStats) return "good"; // no stats available — optimistic default, not "poor"

  // Unknown RTT: use a neutral midpoint rather than 999 so it doesn't auto-fail
  const rtt = rttMs ?? 150;
  const jitter = jitterMs ?? 0;
  const lossRate =
    packetsLost != null && packetsReceived != null && packetsReceived > 0
      ? (packetsLost / (packetsLost + packetsReceived)) * 100
      : 0;
  if (rtt <= 100 && jitter <= 10 && lossRate < 0.5) return "excellent";
  if (rtt <= 200 && jitter <= 25 && lossRate < 1) return "good";
  if (rtt <= 350 && jitter <= 50 && lossRate < 3) return "fair";
  return "poor";
}

const DEFAULT_DIAG: SipDiagnostics = {
  sipWssUrl: null,
  sipDomain: null,
  extensionNumber: null,
  sipUsername: null,
  hasTurn: false,
  hasStun: false,
  micPermission: "unknown",
  iceGatheringState: null,
  iceConnectionState: null,
  selectedCandidateType: null,
  isUsingRelay: false,
  packetsLost: null,
  packetsSent: null,
  jitterMs: null,
  rttMs: null,
  bytesReceived: null,
  bytesSent: null,
  bitrateKbps: null,
  audioLevel: null,
  remoteAudioReceiving: false,
  audioCodec: null,
  qualityGrade: null,
  rawSamples: [],
  lastRegError: null,
  lastCallError: null,
  webrtcEnabled: false,
  sipWssConfigured: false,
  sipDomainConfigured: false,
};

// ── Hook ──────────────────────────────────────────────────────────────────

export function useSipPhone(): SipPhoneState & SipPhoneActions {
  const [regState, setRegState] = useState<SipRegState>("idle");
  const [callState, setCallState] = useState<SipCallState>("idle");
  const [callDirection, setCallDirection] = useState<"outbound" | "inbound" | null>(null);
  const [remoteParty, setRemoteParty] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [currentSinkId, setCurrentSinkId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<SipDiagnostics>(DEFAULT_DIAG);
  const [dialpadInput, setDialpadInput] = useState("");

  const { startRingback, startRingtone, playDtmfTone, stopAll: stopAllAudio } = useTelephonyAudio();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uaRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wiredPeerConnectionsRef = useRef<WeakSet<RTCPeerConnection>>(new WeakSet());
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const callStartedAtRef = useRef<number | null>(null);
  const callDirectionRef = useRef<"outbound" | "inbound">("outbound");
  /** Local microphone stream — stopped explicitly on call end to release the mic indicator. */
  const localStreamRef = useRef<MediaStream | null>(null);
  /** Accumulator for the latest inbound-rtp packetsReceived count for the quality report. */
  const packetsReceivedRef = useRef<number | null>(null);
  /** Latest raw stat snapshot stored in a ref so end-of-call report always has real values. */
  const lastStatsRef = useRef<FullStatSnapshot | null>(null);
  /** Previous bytesReceived for bitrate calculation. */
  const prevBytesReceivedRef = useRef<number | null>(null);
  const prevBytesReceivedTsRef = useRef<number | null>(null);
  /** Timestamp of the last live ping to backend (avoid hammering). */
  const lastPingTsRef = useRef<number>(0);
  /** Timestamp of last observed bytesReceived growth — for one-way audio detection. */
  const lastBytesGrowthTsRef = useRef<number | null>(null);
  /** Whether we have already fired the one-way audio warning for this call. */
  const oneWayAudioWarnedRef = useRef<boolean>(false);
  /** Number of ICE restart attempts for the current call session. */
  const iceRestartAttemptsRef = useRef<number>(0);
  // Captures ICE state at its last known value before teardown resets diag state.
  const lastKnownIceStateRef = useRef<RTCIceConnectionState | null>(null);
  /** Timer for scheduled ICE restart after disconnected state. */
  const iceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Ref mirror of diag so async callbacks always have fresh values. */
  const diagRef = useRef<SipDiagnostics>(DEFAULT_DIAG);
  /** Stale-hangup confirmation timer: fires 10 s after hangup to force-clean PBX if needed. */
  const staleHangupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Timestamp when the local hangup was initiated (for the stale-report). */
  const hangupAtRef = useRef<string | null>(null);

  function patchDiag(patchOrFn: Partial<SipDiagnostics> | ((prev: SipDiagnostics) => SipDiagnostics)) {
    if (typeof patchOrFn === "function") {
      setDiag((prev) => {
        const next = patchOrFn(prev);
        diagRef.current = next;
        return next;
      });
    } else {
      setDiag((prev) => {
        const next = { ...prev, ...patchOrFn };
        diagRef.current = next;
        return next;
      });
    }
  }

  function stopStatsPolling() {
    if (statsIntervalRef.current !== null) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
  }

  function startStatsPolling(pc: RTCPeerConnection) {
    stopStatsPolling();
    // Poll every 2 s for live metrics; send a background ping every 10 s
    statsIntervalRef.current = setInterval(async () => {
      const s = await pollCallStats(pc);
      lastStatsRef.current = s;
      packetsReceivedRef.current = s.packetsReceived;

      // Compute bitrate from byte delta
      let bitrateKbps: number | null = null;
      const now = Date.now();
      if (s.bytesReceived != null && prevBytesReceivedRef.current != null && prevBytesReceivedTsRef.current != null) {
        const dtSec = (now - prevBytesReceivedTsRef.current) / 1000;
        if (dtSec > 0) {
          bitrateKbps = Math.round(((s.bytesReceived - prevBytesReceivedRef.current) * 8) / dtSec / 1000);
        }
      }
      if (s.bytesReceived != null) {
        prevBytesReceivedRef.current = s.bytesReceived;
        prevBytesReceivedTsRef.current = now;
      }

      // ── One-way audio detection ──────────────────────────────────────────
      // If bytesReceived has been non-zero but stopped growing for 8 s we have
      // a silent inbound path — surface it as a diagnostic warning immediately.
      if (s.bytesReceived !== null && s.bytesReceived > 0) {
        const prevBytes = prevBytesReceivedRef.current;
        if (prevBytes === null || s.bytesReceived > prevBytes) {
          // Bytes are flowing — reset the growth timer and clear any prior warning
          lastBytesGrowthTsRef.current = now;
          if (oneWayAudioWarnedRef.current) {
            oneWayAudioWarnedRef.current = false;
            console.log("[SipPhone] incoming_audio_resumed after gap");
            patchDiag({ remoteAudioReceiving: true });
          }
        } else if (lastBytesGrowthTsRef.current !== null && now - lastBytesGrowthTsRef.current > 8_000) {
          if (!oneWayAudioWarnedRef.current) {
            oneWayAudioWarnedRef.current = true;
            const warnMsg = "No incoming audio for 8 s — possible one-way audio or RTP path issue";
            console.warn("[SipPhone] one_way_audio_detected rttMs=" + s.rttMs + " isRelay=" + (s.selectedCandidateType === "relay"));
            patchDiag({ remoteAudioReceiving: false, lastCallError: warnMsg });
          }
        }
      } else if (s.bytesReceived === 0 && lastBytesGrowthTsRef.current === null) {
        // Call just started — initialise the timer on first poll
        lastBytesGrowthTsRef.current = now;
      }

      const grade = computeQualityGrade(s.rttMs, s.jitterMs, s.packetsLost, s.packetsReceived);
      const newSample: RawStatSample = {
        ts: now,
        packetsLost: s.packetsLost,
        packetsReceived: s.packetsReceived,
        packetsSent: s.packetsSent,
        jitterMs: s.jitterMs,
        rttMs: s.rttMs,
        bytesReceived: s.bytesReceived,
        bytesSent: s.bytesSent,
        bitrateKbps,
        audioLevel: s.audioLevel,
        candidateType: s.selectedCandidateType,
        qualityGrade: grade,
      };

      patchDiag((prev) => ({
        ...prev,
        packetsLost: s.packetsLost,
        packetsSent: s.packetsSent,
        jitterMs: s.jitterMs,
        rttMs: s.rttMs,
        bytesReceived: s.bytesReceived,
        bytesSent: s.bytesSent,
        bitrateKbps,
        audioLevel: s.audioLevel,
        selectedCandidateType: s.selectedCandidateType,
        isUsingRelay: s.selectedCandidateType === "relay",
        audioCodec: s.audioCodec ?? prev.audioCodec,
        qualityGrade: grade,
        // Keep last 10 samples for debug panel
        rawSamples: [...prev.rawSamples.slice(-9), newSample],
      }));

      // Send live ping every ~10 s (throttled) — non-blocking, non-fatal
      if (now - lastPingTsRef.current >= 10_000) {
        lastPingTsRef.current = now;
        const netInfo = (navigator as any).connection;
        const networkType: string | null = netInfo?.effectiveType || netInfo?.type || null;
        const durationMs = callStartedAtRef.current ? now - callStartedAtRef.current : 0;
        apiPost("/voice/diag/call-quality-ping", {
          platform: "WEB",
          durationMs,
          direction: callDirectionRef.current,
          candidateType: s.selectedCandidateType,
          isUsingRelay: s.selectedCandidateType === "relay",
          rttMs: s.rttMs,
          jitterMs: s.jitterMs,
          packetsLost: s.packetsLost,
          packetsReceived: s.packetsReceived,
          packetsSent: s.packetsSent,
          bytesReceived: s.bytesReceived,
          bytesSent: s.bytesSent,
          bitrateKbps,
          audioLevel: s.audioLevel,
          audioCodec: s.audioCodec,
          networkType,
          qualityGrade: grade,
        }).catch(() => { /* non-fatal */ });
      }
    }, 2_000);
  }

  /** Fire-and-forget: send a call quality report to the backend when a call ends.
   *  Uses lastStatsRef (updated every 2 s via polling) to avoid stale React state. */
  function submitCallQualityReport(endReason: string) {
    const startedAt = callStartedAtRef.current;
    const durationMs = startedAt ? Date.now() - startedAt : 0;
    if (durationMs < 1000) return; // skip sub-second non-calls

    // Prefer the live ref (always fresh) over React diag state (may lag one render)
    const s = lastStatsRef.current;
    const grade = computeQualityGrade(
      s?.rttMs ?? null,
      s?.jitterMs ?? null,
      s?.packetsLost ?? null,
      s?.packetsReceived ?? packetsReceivedRef.current,
    );

    const netInfo = (navigator as any).connection;
    const networkType: string | null = netInfo?.effectiveType || netInfo?.type || null;

    apiPost("/voice/diag/call-quality-report", {
      platform: "WEB",
      durationMs,
      direction: callDirectionRef.current,
      candidateType: s?.selectedCandidateType ?? null,
      isUsingRelay: s?.selectedCandidateType === "relay",
      rttMs: s?.rttMs ?? null,
      jitterMs: s?.jitterMs ?? null,
      packetsLost: s?.packetsLost ?? null,
      packetsReceived: s?.packetsReceived ?? packetsReceivedRef.current,
      packetsSent: s?.packetsSent ?? null,
      bytesReceived: s?.bytesReceived ?? null,
      bytesSent: s?.bytesSent ?? null,
      bitrateKbps: null, // final bitrate not meaningful at teardown
      // Use the ref (last known before teardown reset) rather than diag state
      // which may already be null when teardown clears it.
      iceConnectionState: lastKnownIceStateRef.current ?? diag.iceConnectionState,
      micPermission: diag.micPermission,
      remoteAudioReceiving: diag.remoteAudioReceiving,
      audioCodec: s?.audioCodec ?? diag.audioCodec,
      networkType,
      endReason,
      qualityGrade: grade,
    }).catch(() => {
      // Non-fatal — telemetry loss is acceptable
    });

    // Clear the live-call ping so the dashboard removes this call
    apiPost("/voice/diag/call-quality-ping/clear", {}).catch(() => {});
  }

  // ── Initialise ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function init() {
      // Off-screen audio element for remote media — display:none can block playback
      // in some browsers, so we keep it in the layout but invisible.
      if (!audioRef.current) {
        const el = document.createElement("audio");
        el.autoplay = true;
        el.setAttribute("playsinline", "");
        el.muted = false;
        el.volume = 1.0;
        Object.assign(el.style, {
          position: "fixed",
          left: "-9999px",
          width: "1px",
          height: "1px",
          opacity: "0",
          pointerEvents: "none",
        });
        document.body.appendChild(el);
        audioRef.current = el;
      }

      const micPerm = await checkMicPermission();
      if (!cancelled) patchDiag({ micPermission: micPerm });

      let ext: VoiceExtension;
      try {
        ext = await apiGet<VoiceExtension>("/voice/me/extension");
      } catch (e: unknown) {
        if (cancelled) return;
        const raw = e instanceof Error ? e.message : "EXTENSION_NOT_FOUND";
        const msg = raw.includes("EXTENSION_NOT_ASSIGNED") || raw.includes("EXTENSION_NOT_FOUND")
          ? "EXTENSION_NOT_ASSIGNED — No extension is assigned to your account. Contact your administrator to assign one via PBX → Extensions."
          : raw.includes("PBX_NOT_LINKED")
          ? "PBX_NOT_LINKED — The PBX is not configured for your account. Contact your administrator."
          : raw;
        setError(msg);
        patchDiag({ webrtcEnabled: false });
        return;
      }
      if (cancelled) return;

      const sipWssUrl = ext.sipWsUrl ?? null;
      const sipDomain = ext.sipDomain ?? null;

      patchDiag({
        sipWssUrl,
        sipDomain,
        extensionNumber: ext.extensionNumber,
        sipUsername: ext.sipUsername,
        hasTurn: hasTurnServer(ext.iceServers),
        hasStun: hasStunServer(ext.iceServers),
        webrtcEnabled: ext.webrtcEnabled,
        sipWssConfigured: !!sipWssUrl,
        sipDomainConfigured: !!sipDomain,
      });

      if (!ext.webrtcEnabled) {
        setError("WEBRTC_DISABLED — An administrator must enable WebRTC for this tenant. Go to PBX → Extensions → WebRTC Settings.");
        return;
      }
      if (!sipWssUrl) {
        setError("SIP WSS URL is not configured. Set sipWsUrl in Voice → Settings → WebRTC.");
        return;
      }
      if (!sipDomain) {
        setError("SIP Domain is not configured. Set sipDomain in Voice → Settings → WebRTC.");
        return;
      }
      if (!ext.sipUsername) {
        setError("No SIP username assigned. Contact your administrator.");
        return;
      }

      if (!hasTurnServer(ext.iceServers)) {
        console.warn("[SipPhone] No TURN server in ICE config — audio may fail behind strict NAT.");
      }

      let sipPassword: string;
      try {
        const reset = await apiPost<{ sipPassword: string; provisioning?: { sipPassword: string } }>(
          "/voice/me/reset-sip-password",
        );
        sipPassword = reset.sipPassword ?? reset.provisioning?.sipPassword ?? "";
      } catch (e: unknown) {
        if (cancelled) return;
        const raw = e instanceof Error ? e.message : "SIP_CREDENTIAL_FETCH_FAILED";
        const msg = raw.includes("SIP_CREDENTIAL_NOT_SET")
          ? "SIP_CREDENTIAL_NOT_SET — An administrator must set the SIP password for this extension."
          : raw.includes("RATE_LIMITED")
          ? "RATE_LIMITED — Too many credential requests. Reload the page to retry."
          : `Failed to fetch SIP credentials: ${raw}. Try refreshing the page.`;
        setError(msg);
        patchDiag({ lastRegError: msg });
        return;
      }

      if (cancelled || !sipPassword) {
        setError("SIP_CREDENTIAL_NOT_SET — An administrator must set the SIP password for this extension.");
        return;
      }

      try {
        const JsSIP = await loadJsSIP();
        if (cancelled) return;

        setRegState("connecting");
        const socket = new JsSIP.WebSocketInterface(sipWssUrl);

        const uaConfig: Record<string, unknown> = {
          sockets: [socket],
          uri: `sip:${ext.sipUsername}@${sipDomain}`,
          password: sipPassword,
          authorization_user: ext.authUsername || ext.sipUsername,
          display_name: ext.displayName || ext.sipUsername,
          register: true,
          register_expires: 300,
          session_timers: false,
          pcConfig: {
            iceServers: ext.iceServers?.length
              ? ext.iceServers
              : [{ urls: "stun:stun.l.google.com:19302" }],
            iceTransportPolicy: (process.env.NEXT_PUBLIC_FORCE_ICE_RELAY === "true" ? "relay" : "all") as RTCIceTransportPolicy,
          },
        };

        if (ext.outboundProxy) {
          uaConfig.outbound_proxy_set = ext.outboundProxy;
        }

        const ua = new JsSIP.UA(uaConfig);
        uaRef.current = ua;
        let regFailCount = 0;

        ua.on("connecting", () => { if (!cancelled) setRegState("connecting"); });
        ua.on("connected",  () => { if (!cancelled) setRegState("registering"); });

        ua.on("disconnected", () => {
          if (!cancelled) {
            setRegState("failed");
            const msg = "SIP WebSocket disconnected. Check PBX WSS transport on port 8089.";
            setError(msg);
            patchDiag({ lastRegError: msg });
          }
        });

        ua.on("registered", () => {
          if (!cancelled) {
            regFailCount = 0;
            setRegState("registered");
            setError(null);
            patchDiag({ lastRegError: null });
            // Probe mic permission immediately after registration so the browser
            // shows the "Allow microphone" prompt while the softphone is visible.
            if (navigator.mediaDevices?.getUserMedia) {
              navigator.mediaDevices
                .getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS, video: false })
                .then((s) => {
                  s.getTracks().forEach((t) => t.stop());
                  patchDiag({ micPermission: "granted" });
                })
                .catch((err) => {
                  const msg = `Microphone access denied — allow microphone in browser settings. (${err?.name ?? err})`;
                  if (!cancelled) setError(msg);
                  patchDiag({ micPermission: "denied", lastRegError: msg });
                });
            }
          }
        });

        ua.on("unregistered", () => { if (!cancelled) setRegState("idle"); });

        ua.on("registrationFailed", (e: { cause: string; response?: { status_code?: number } }) => {
          if (!cancelled) {
            regFailCount += 1;
            const code = e.response?.status_code;
            const msg = code
              ? `SIP registration failed (${code}): ${e.cause}. ${code === 401 || code === 403 ? "Check SIP credentials." : "Check PBX configuration."}`
              : `SIP registration failed: ${e.cause}`;
            setRegState("failed");
            setError(msg);
            patchDiag({ lastRegError: msg });
            // Stop hammering the PBX after 3 consecutive failures — require manual reload.
            if (regFailCount >= 3) {
              try { ua.stop(); } catch { /* ignore */ }
              uaRef.current = null;
              setError(`SIP registration failed after 3 attempts: ${e.cause}. Reload the page to retry.`);
            }
          }
        });

        ua.on(
          "newRTCSession",
          (data: {
            originator: string;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: any;
            request: { from: { uri: { user: string }; display_name?: string } };
          }) => {
            if (cancelled) return;

            // JsSIP creates RTCPeerConnection BEFORE firing newRTCSession for outgoing
            // calls (RTCSession.js line 287 vs 296). Wire directly if PC already exists;
            // fall back to the "peerconnection" event for incoming calls (answer path).
            if (data.session.connection) {
              wirePC(data.session.connection);
            } else {
              data.session.on("peerconnection", (pcData: { peerconnection: RTCPeerConnection }) => {
                wirePC(pcData.peerconnection);
              });
            }

            if (data.originator === "remote") {
              callDirectionRef.current = "inbound";
              setCallDirection("inbound");
              setOnHold(false);
              const party = data.request.from.display_name || data.request.from.uri.user;
              bindSession(data.session, party);
              setCallState("ringing");
              setRemoteParty(party);
              console.log("[SIP] INCOMING_CALL from:", party);
              // Inbound: play ringtone
              startRingtone();
            }
          },
        );

        ua.start();
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "SIP UA init failed";
        setRegState("failed");
        setError(msg);
        patchDiag({ lastRegError: msg });
      }
    }

    init();

    return () => {
      cancelled = true;
      stopStatsPolling();
      stopLocalStream();
      if (staleHangupTimerRef.current) { clearTimeout(staleHangupTimerRef.current); staleHangupTimerRef.current = null; }
      if (uaRef.current) {
        try { uaRef.current.stop(); } catch { /* ignore */ }
        uaRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.srcObject = null;
        audioRef.current.remove();
        audioRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session lifecycle ───────────────────────────────────────────────────

  const clearCallDiag = useCallback(() => {
    stopStatsPolling();
    lastKnownIceStateRef.current = null; // reset after quality report has been submitted
    patchDiag({
      iceGatheringState: null,
      iceConnectionState: null,
      selectedCandidateType: null,
      isUsingRelay: false,
      packetsLost: null,
      jitterMs: null,
      rttMs: null,
      remoteAudioReceiving: false,
      audioCodec: null,
      qualityGrade: null,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const teardownRemoteAudioPlayback = useCallback(() => {
    stopStatsPolling();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
  }, []);

  /** Stop all local mic tracks — releases the browser mic indicator. */
  function stopLocalStream() {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
  }

  function attachRemoteStream(stream: MediaStream) {
    const el = audioRef.current;
    if (!el) {
      console.warn("[SipPhone] audioRef missing — cannot play remote audio");
      return;
    }
    el.srcObject = stream;
    const tracks = stream.getAudioTracks();
    patchDiag({ remoteAudioReceiving: tracks.some((t) => t.readyState === "live") });
    el.play().catch((err) => {
      const resume = () => {
        audioRef.current?.play().catch(() => undefined);
        document.removeEventListener("click", resume);
        document.removeEventListener("touchend", resume);
      };
      document.addEventListener("click", resume, { once: true });
      document.addEventListener("touchend", resume, { once: true });
      patchDiag({ lastCallError: `audio autoplay blocked: ${err?.name} — tap screen to hear audio` });
    });
  }

  function syncReceiversToAudio(pc: RTCPeerConnection) {
    const tracks = pc
      .getReceivers()
      .map((r) => r.track)
      .filter((t): t is MediaStreamTrack => !!t && t.kind === "audio" && t.readyState === "live");
    if (tracks.length > 0) attachRemoteStream(new MediaStream(tracks));
  }

  function wirePC(pc: RTCPeerConnection) {
    if (wiredPeerConnectionsRef.current.has(pc)) return;
    wiredPeerConnectionsRef.current.add(pc);

    pc.addEventListener("track", (e: RTCTrackEvent) => {
      if (e.track.kind !== "audio") return;
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      console.log("[SipPhone] remote_track_received id=" + e.track.id + " state=" + e.track.readyState);
      attachRemoteStream(stream);

      // Monitor remote track lifecycle for mid-call audio drops
      e.track.addEventListener("mute", () => {
        console.warn("[SipPhone] remote_track_muted — PBX stopped sending audio");
        patchDiag({ remoteAudioReceiving: false, lastCallError: "Remote audio muted by PBX (hold or network issue?)" });
      });
      e.track.addEventListener("unmute", () => {
        console.log("[SipPhone] remote_track_unmuted — audio resumed");
        patchDiag({ remoteAudioReceiving: true, lastCallError: null });
        // Re-attach the stream after unmute to ensure the audio element is playing
        attachRemoteStream(stream);
      });
      e.track.addEventListener("ended", () => {
        console.warn("[SipPhone] remote_track_ended — audio path terminated");
        patchDiag({ remoteAudioReceiving: false, lastCallError: "Remote audio track ended unexpectedly" });
      });
    });

    pc.addEventListener("icegatheringstatechange", () => {
      console.log("[SipPhone] ICE gathering →", pc.iceGatheringState);
      patchDiag({ iceGatheringState: pc.iceGatheringState });
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      const iceState = pc.iceConnectionState;
      console.log("[SipPhone] ICE connection →", iceState, new Date().toISOString());
      // Keep a persistent ref so the final quality report can read the last known state
      // even after diag is reset to null during call teardown.
      lastKnownIceStateRef.current = iceState;
      patchDiag({ iceConnectionState: iceState });

      if (iceState === "connected" || iceState === "completed") {
        syncReceiversToAudio(pc);
        // Kick off stats polling and do an immediate first poll for candidate type.
        startStatsPolling(pc);
        pollCallStats(pc).then((s) => {
          const isRelay = s.selectedCandidateType === "relay";
          console.log("[SipPhone] ICE_CONNECTED candidateType=" + s.selectedCandidateType + " relay=" + isRelay);
          patchDiag({
            selectedCandidateType: s.selectedCandidateType,
            isUsingRelay: isRelay,
            packetsLost: s.packetsLost,
            jitterMs: s.jitterMs,
            rttMs: s.rttMs,
          });
        });
      }

      if (iceState === "failed") {
        stopStatsPolling();
        const MAX_ICE_RESTARTS = 2;
        if (iceRestartAttemptsRef.current < MAX_ICE_RESTARTS && sessionRef.current?.connection === pc) {
          iceRestartAttemptsRef.current += 1;
          console.warn(
            "[SipPhone] ICE_FAILED — attempting ICE restart " +
            iceRestartAttemptsRef.current + "/" + MAX_ICE_RESTARTS,
          );
          patchDiag({ lastCallError: `ICE failed — auto-restarting (attempt ${iceRestartAttemptsRef.current}/${MAX_ICE_RESTARTS})…` });
          try {
            pc.restartIce();
            console.log("[SipPhone] ICE restart triggered via restartIce()");
          } catch (e) {
            console.warn("[SipPhone] restartIce() not supported, skipping", e);
          }
        } else {
          const hasTurn = diag.hasTurn;
          const msg = "ICE connection failed — audio cannot reach the PBX. "
            + (hasTurn
              ? "TURN is configured; check firewall/UDP ports."
              : "No TURN server configured — configure one via Voice → Settings → WebRTC.");
          console.error("[SipPhone] ICE_FAILED_PERMANENT hasTurn=" + hasTurn + " restarts=" + iceRestartAttemptsRef.current);
          setError(msg);
          patchDiag({ lastCallError: msg });
        }
      }

      if (iceState === "disconnected") {
        console.warn("[SipPhone] ICE_DISCONNECTED — scheduling recovery check in 4s");
        patchDiag({ lastCallError: "ICE disconnected — possible network interruption, waiting for recovery…" });
        // Clear any previous timer
        if (iceRestartTimerRef.current) clearTimeout(iceRestartTimerRef.current);
        // If still disconnected after 4s, attempt ICE restart
        iceRestartTimerRef.current = setTimeout(() => {
          if (pc.iceConnectionState === "disconnected" && sessionRef.current?.connection === pc) {
            const MAX_ICE_RESTARTS = 2;
            if (iceRestartAttemptsRef.current < MAX_ICE_RESTARTS) {
              iceRestartAttemptsRef.current += 1;
              console.warn("[SipPhone] ICE still disconnected after 4s — triggering ICE restart " + iceRestartAttemptsRef.current);
              patchDiag({ lastCallError: `Network issue — auto-restarting audio connection (attempt ${iceRestartAttemptsRef.current})…` });
              try { pc.restartIce(); } catch (e) { console.warn("[SipPhone] restartIce() failed", e); }
            }
          }
          iceRestartTimerRef.current = null;
        }, 4000);
      }

      if (iceState === "connected" || iceState === "completed") {
        // Clear any pending restart timer since ICE recovered
        if (iceRestartTimerRef.current) {
          clearTimeout(iceRestartTimerRef.current);
          iceRestartTimerRef.current = null;
        }
        if (iceRestartAttemptsRef.current > 0) {
          console.log("[SipPhone] ICE recovered after " + iceRestartAttemptsRef.current + " restart(s)");
          patchDiag({ lastCallError: null });
          iceRestartAttemptsRef.current = 0;
        }
      }

      if (iceState === "checking") {
        console.log("[SipPhone] ICE checking candidates…");
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      const connState = pc.connectionState;
      console.log("[SipPhone] PeerConnection →", connState);
      if (connState === "connected") syncReceiversToAudio(pc);
      if (connState === "failed") {
        console.error("[SipPhone] PeerConnection_FAILED — media path is dead");
        patchDiag({ lastCallError: "Peer connection failed — media path is dead" });
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindSession(session: any, party: string) {
    sessionRef.current = session;
    setRemoteParty(party);

    session.on("progress", () => {
      setCallState("ringing");
      // Outbound: play US ringback (440+480 Hz, 2s on / 4s off)
      if (callDirectionRef.current === "outbound") startRingback();
    });
    session.on("accepted", () => {
      stopAllAudio();
      if (!callStartedAtRef.current) callStartedAtRef.current = Date.now();
      console.log("[SIP] CALL_ACCEPTED");
      setCallState("connected");
      if (session.connection) syncReceiversToAudio(session.connection);
    });
    session.on("confirmed", () => {
      stopAllAudio();
      if (!callStartedAtRef.current) callStartedAtRef.current = Date.now();
      console.log("[SIP] CALL_ACCEPTED (confirmed)");
      setCallState("connected");
      if (session.connection) syncReceiversToAudio(session.connection);
    });

    session.on("ended", () => {
      stopAllAudio();
      console.log("[SIP] CALL_ENDED");
      // Cancel stale-hangup timer — call ended normally via SIP, no need for force cleanup
      if (staleHangupTimerRef.current) { clearTimeout(staleHangupTimerRef.current); staleHangupTimerRef.current = null; }
      submitCallQualityReport("normal");
      sessionRef.current = null;
      setOnHold(false);
      setCallDirection(null);
      setCallState("ended");
      setRemoteParty(null);
      setMutedState(false);
      stopLocalStream();
      teardownRemoteAudioPlayback();
      clearCallDiag();
      callStartedAtRef.current = null;
      packetsReceivedRef.current = null;
      lastStatsRef.current = null;
      prevBytesReceivedRef.current = null;
      prevBytesReceivedTsRef.current = null;
      lastPingTsRef.current = 0;
      lastBytesGrowthTsRef.current = null;
      oneWayAudioWarnedRef.current = false;
      iceRestartAttemptsRef.current = 0;
      if (iceRestartTimerRef.current) { clearTimeout(iceRestartTimerRef.current); iceRestartTimerRef.current = null; }
      setTimeout(() => setCallState("idle"), 2000);
    });

    session.on("failed", (e: { cause: string }) => {
      stopAllAudio();
      console.log("[SIP] CALL_FAILED cause:", e.cause);
      // Cancel stale-hangup timer — call failed cleanly at SIP level
      if (staleHangupTimerRef.current) { clearTimeout(staleHangupTimerRef.current); staleHangupTimerRef.current = null; }
      submitCallQualityReport(e.cause || "failed");
      sessionRef.current = null;
      setOnHold(false);
      setCallDirection(null);
      const msg = `Call failed: ${e.cause}`;
      setCallState("idle");
      setRemoteParty(null);
      setMutedState(false);
      setError(msg);
      stopLocalStream();
      teardownRemoteAudioPlayback();
      patchDiag({ lastCallError: msg });
      clearCallDiag();
      callStartedAtRef.current = null;
      packetsReceivedRef.current = null;
      lastStatsRef.current = null;
      prevBytesReceivedRef.current = null;
      prevBytesReceivedTsRef.current = null;
      lastPingTsRef.current = 0;
      lastBytesGrowthTsRef.current = null;
      oneWayAudioWarnedRef.current = false;
      iceRestartAttemptsRef.current = 0;
      if (iceRestartTimerRef.current) { clearTimeout(iceRestartTimerRef.current); iceRestartTimerRef.current = null; }
    });

    // Sync any already-live tracks if peerconnection was created before this binding.
    if (session.connection) syncReceiversToAudio(session.connection);
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  const dial = useCallback(
    (target: string) => {
      if (!uaRef.current || regState !== "registered") {
        setError("Not registered. Wait for SIP registration before dialling.");
        return;
      }
      const domain = uaRef.current._configuration?.uri?.host;
      if (!domain) return;
      const normalised = target.trim();
      if (!normalised) return;

      callDirectionRef.current = "outbound";
      setCallDirection("outbound");
      callStartedAtRef.current = Date.now();
      setCallState("dialing");
      setError(null);
      setOnHold(false);
      console.log("[SIP] CALL_INITIATED target:", normalised);
      // Start ringback immediately on dial (before "progress" from PBX)
      startRingback();

      navigator.mediaDevices
        .getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS, video: false })
        .then((localStream) => {
          localStreamRef.current = localStream;
          try {
            const session = uaRef.current!.call(`sip:${normalised}@${domain}`, {
              mediaStream: localStream,
              pcConfig: uaRef.current!._configuration?.pcConfig ?? {},
            });
            bindSession(session, normalised);
          } catch (e: unknown) {
            localStream.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
            setCallState("idle");
            const msg = e instanceof Error ? e.message : "Call failed";
            setError(msg);
            patchDiag({ lastCallError: msg });
          }
        })
        .catch((err) => {
          setCallState("idle");
          if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
            setError("Microphone access denied. Allow microphone in your browser settings for this site, then try again.");
          } else if (err?.name === "NotFoundError") {
            setError("No microphone found. Connect a headset or microphone and try again.");
          } else {
            setError(`Microphone error: ${err?.message ?? err}`);
          }
          patchDiag({ lastCallError: `mic_error: ${err?.name}`, micPermission: "denied" });
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regState],
  );

  const answer = useCallback(() => {
    if (!sessionRef.current) return;
    stopAllAudio(); // Stop ringtone immediately on answer
    navigator.mediaDevices
      .getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS, video: false })
      .then((localStream) => {
        localStreamRef.current = localStream;
        try {
          sessionRef.current?.answer({ mediaStream: localStream });
          // Do NOT set callState("connected") here — wait for JsSIP "confirmed"
          // event (fired when ACK arrives) so the UI transitions only once the
          // SIP dialog is fully established. bindSession's "confirmed" handler
          // will set the state correctly.
        } catch (e: unknown) {
          localStream.getTracks().forEach((t) => t.stop());
          localStreamRef.current = null;
          const msg = e instanceof Error ? e.message : "Answer failed";
          setError(msg);
        }
      })
      .catch((err) => {
        if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
          setError("Microphone access denied. Allow microphone in browser settings to answer calls.");
        } else {
          setError(`Microphone error: ${err?.message ?? err}`);
        }
      });
  }, []);

  const hangup = useCallback(() => {
    stopAllAudio();
    console.log("[SIP] user hangup");

    // Capture extension and hangup time before clearing state
    const extensionAtHangup = diagRef.current.extensionNumber;
    const hangupIso = new Date().toISOString();
    hangupAtRef.current = hangupIso;

    if (sessionRef.current) {
      submitCallQualityReport("user_hangup");
      try { sessionRef.current.terminate(); } catch { /* already ended */ }
      sessionRef.current = null;
    }
    setCallState("idle");
    setCallDirection(null);
    setRemoteParty(null);
    setMutedState(false);
    setOnHold(false);
    stopLocalStream();
    teardownRemoteAudioPlayback();
    clearCallDiag();
    callStartedAtRef.current = null;
    packetsReceivedRef.current = null;
    lastStatsRef.current = null;
    prevBytesReceivedRef.current = null;
    prevBytesReceivedTsRef.current = null;
    lastPingTsRef.current = 0;
    lastBytesGrowthTsRef.current = null;
    oneWayAudioWarnedRef.current = false;

    // ── Post-hangup stale-call safeguard ──────────────────────────────────────
    // 10 seconds after hangup, ask the telephony service if a call for this
    // extension is still active. If so, force-evict it and hang up the PBX leg.
    // This is the last-resort defence if the PBX never delivered an AMI Hangup event.
    if (staleHangupTimerRef.current) clearTimeout(staleHangupTimerRef.current);
    if (extensionAtHangup) {
      staleHangupTimerRef.current = setTimeout(() => {
        staleHangupTimerRef.current = null;
        apiPost("/telephony/calls/stale-hangup-for-extension", {
          extension: extensionAtHangup,
          hangupAt: hangupIso,
        })
          .then((res: unknown) => {
            const r = res as { cleared?: number };
            if (r?.cleared && r.cleared > 0) {
              console.warn(
                `[SIP] stale-hangup-for-extension cleared ${r.cleared} zombie call(s) for extension ${extensionAtHangup}`,
                res,
              );
            }
          })
          .catch(() => { /* non-fatal — server may not have the endpoint yet */ });
      }, 10_000);
    }
  }, [teardownRemoteAudioPlayback, clearCallDiag]);

  const toggleHold = useCallback(() => {
    if (!sessionRef.current || callState !== "connected") return;
    try {
      if (onHold) {
        sessionRef.current.unhold();
        setOnHold(false);
        // Re-sync audio after unhold — the PBX sends a re-INVITE which may
        // result in new tracks or the existing tracks being unmuted. Give ICE
        // ~600 ms to settle before forcing a track re-attach.
        setTimeout(() => {
          const conn = sessionRef.current?.connection as RTCPeerConnection | undefined;
          if (conn) {
            console.log("[SipPhone] re-syncing audio after unhold");
            syncReceiversToAudio(conn);
          }
        }, 600);
      } else {
        sessionRef.current.hold();
        setOnHold(true);
        console.log("[SipPhone] call_on_hold");
      }
    } catch (e) {
      console.warn("[SipPhone] toggleHold failed:", e);
    }
  }, [callState, onHold]);

  const setMute = useCallback((mute: boolean) => {
    if (!sessionRef.current) return;
    try {
      if (mute) sessionRef.current.mute({ audio: true });
      else sessionRef.current.unmute({ audio: true });
      setMutedState(mute);
    } catch { /* ignore */ }
  }, []);

  const sendDtmf = useCallback(
    (digit: string) => {
      // Always play local keypad tone for tactile feedback
      playDtmfTone(digit);
      if (!sessionRef.current || callState !== "connected") return;
      try { sessionRef.current.sendDTMF(digit); } catch { /* ignore */ }
    },
    [callState, playDtmfTone],
  );

  // ── Audio output (speaker) routing ─────────────────────────────────────────

  /** Enumerate audio output devices and refresh state. */
  const refreshOutputDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((d) => d.kind === "audiooutput");
      setAudioOutputDevices(outputs);
    } catch { /* permissions not granted yet */ }
  }, []);

  const setAudioSinkId = useCallback(async (sinkId: string) => {
    const el = audioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el) return;
    try {
      if (typeof el.setSinkId === "function") {
        await el.setSinkId(sinkId);
      }
      setCurrentSinkId(sinkId);
      setSpeakerOn(sinkId !== "");
    } catch (e) {
      console.warn("[SipPhone] setSinkId failed:", e);
    }
  }, []);

  const toggleSpeaker = useCallback(async () => {
    if (speakerOn) {
      // Switch back to default (earpiece / OS default)
      await setAudioSinkId("");
      setSpeakerOn(false);
    } else {
      // Find first non-default audio output (usually the speaker/headphones)
      let devices = audioOutputDevices;
      if (devices.length === 0) {
        // Enumerate now if we haven't yet
        if (typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
          try {
            const all = await navigator.mediaDevices.enumerateDevices();
            devices = all.filter((d) => d.kind === "audiooutput");
            setAudioOutputDevices(devices);
          } catch { /* ignore */ }
        }
      }
      // Prefer a device that looks like a speaker; fall back to first non-default
      const speaker = devices.find(
        (d) => d.deviceId !== "default" && d.deviceId !== "communications" &&
          (d.label.toLowerCase().includes("speaker") || d.label.toLowerCase().includes("headphone") ||
           d.label.toLowerCase().includes("output")),
      ) ?? devices.find((d) => d.deviceId !== "default" && d.deviceId !== "");
      if (speaker) {
        await setAudioSinkId(speaker.deviceId);
        setSpeakerOn(true);
      } else {
        // setSinkId not available or only one device — toggle visual state
        setSpeakerOn(true);
      }
    }
  }, [speakerOn, audioOutputDevices, setAudioSinkId]);

  // Enumerate devices whenever a call connects
  useEffect(() => {
    if (callState === "connected") refreshOutputDevices();
  }, [callState, refreshOutputDevices]);

  // Reset speaker state on call end
  useEffect(() => {
    if (callState === "idle" || callState === "ended") {
      setSpeakerOn(false);
      setCurrentSinkId("");
    }
  }, [callState]);

  // ── Blind transfer ──────────────────────────────────────────────────────────

  const transfer = useCallback((target: string) => {
    if (!sessionRef.current || callState !== "connected") return;
    const domain = sessionRef.current.remote_identity?.uri?.host ?? "";
    const uri = target.includes("@") ? `sip:${target}` : `sip:${target}@${domain}`;
    try {
      sessionRef.current.refer(uri);
      console.log("[SIP] TRANSFER_SENT to:", uri);
    } catch (e) {
      console.error("[SIP] Transfer failed:", e);
      setError(`Transfer failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [callState]);

  return {
    regState,
    callState,
    callDirection,
    remoteParty,
    muted,
    onHold,
    speakerOn,
    audioOutputDevices,
    currentSinkId,
    error,
    diag,
    dial,
    answer,
    hangup,
    setMute,
    toggleHold,
    toggleSpeaker,
    setAudioSinkId,
    sendDtmf,
    playDtmfTone,
    transfer,
    dialpadInput,
    setDialpadInput,
  };
}
