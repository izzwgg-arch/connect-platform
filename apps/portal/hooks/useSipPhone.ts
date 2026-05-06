"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiGet, apiPost, ApiError } from "../services/apiClient";
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

export type OutboundDialRoute = {
  id: string;
  name: string;
  prefix?: string;
  callerIdName?: string | null;
  callerIdNumber?: string | null;
  isDefault?: boolean;
  label?: string;
};

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
  /** Available microphone/input devices for call media. Empty until enumeration. */
  audioInputDevices: MediaDeviceInfo[];
  /** Current audio output sink id (empty string = browser default). */
  currentSinkId: string;
  /** Current microphone device id (empty string = browser/default communications device). */
  currentMicDeviceId: string;
  error: string | null;
  diag: SipDiagnostics;
  outboundRoutes: OutboundDialRoute[];
  selectedOutboundRouteId: string;
  selectedOutboundRoute: OutboundDialRoute | null;
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
  /** Set microphone input for future outbound/answered calls. */
  setAudioInputDeviceId: (deviceId: string) => Promise<void>;
  /** Refresh input/output audio device lists. */
  refreshAudioDevices: () => Promise<void>;
  sendDtmf: (digit: string) => void;
  /** Play a local DTMF keypad tone without sending SIP DTMF (for pre-call dialpad). */
  playDtmfTone: (digit: string) => void;
  /** Blind transfer the active call to a target extension/number. */
  transfer: (target: string) => void;
  dialpadInput: string;
  setDialpadInput: React.Dispatch<React.SetStateAction<string>>;
  setSelectedOutboundRouteId: React.Dispatch<React.SetStateAction<string>>;
  // ── Multi-call (additive — single-call accessors above still work) ───────
  /** All SIP sessions on this UA: active, held, ringing. */
  sessions: MultiCallSession[];
  /** Active session id (same as the one driving callState). */
  activeSessionId: string | null;
  /** Held session ids in LIFO order — index 0 resumes first on hangup. */
  heldSessionIds: string[];
  /** Ringing inbound sessions (call-waiting) — empty when idle. */
  ringingSessionIds: string[];
  /** Answer a specific ringing session (puts any currently active on hold). */
  answerSession: (id: string) => void;
  /** Hold a specific session. */
  holdSession: (id: string) => void;
  /** Resume a specific held session (puts the currently active session on hold). */
  resumeSession: (id: string) => void;
  /** Hang up a specific session (active or held) without touching the others. */
  hangupSession: (id: string) => void;
  /** Atomic swap: put active on hold, resume the given held session. */
  swapToSession: (id: string) => void;
};

/** Multi-call session snapshot for UI. */
export interface MultiCallSession {
  id: string;
  remoteParty: string;
  direction: "inbound" | "outbound";
  state: "ringing" | "dialing" | "connected" | "held" | "ending";
  onHold: boolean;
  isActive: boolean;
  startedAt: number;
}

type ConnectDesktopApi = {
  isDesktop: boolean;
  windowKind?: "full" | "mini" | "phone-engine";
  phone: {
    sendFromEngine: (envelope: { type: "state" | "event"; payload?: unknown; event?: string }) => void;
    sendCommand: (command: { command: string; args: unknown[] }) => Promise<unknown>;
    onEngineEvent: (listener: (envelope: { type: "state" | "event"; payload?: unknown; event?: string }) => void) => () => void;
    onCommand: (listener: (command: { command: string; args: unknown[] }) => void) => () => void;
  };
  window?: {
    openMini: () => Promise<unknown>;
    openFull: (route?: string) => Promise<unknown>;
    expandToFull: (route?: string) => Promise<unknown>;
    closeMini: () => Promise<unknown>;
    minimize: () => Promise<unknown>;
    toggleAlwaysOnTop: () => Promise<unknown>;
    getSettings: () => Promise<DesktopWindowSettings>;
    updateSettings: (patch: Partial<DesktopWindowSettings>) => Promise<DesktopWindowSettings>;
    onSettings: (listener: (settings: DesktopWindowSettings) => void) => () => void;
  };
  notifications?: {
    show: (payload: { kind: string; title: string; body?: string; route?: string }) => Promise<unknown>;
  };
};

type DesktopWindowSettings = {
  alwaysOnTop?: boolean;
  startOnLogin?: boolean;
  openMinimizedToTray?: boolean;
  openMiniOnStartup?: boolean;
  minimizeToTray?: boolean;
  selectedMicDeviceId?: string;
  selectedSpeakerDeviceId?: string;
};

declare global {
  interface Window {
    connectDesktop?: ConnectDesktopApi;
  }
}

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

function voiceAudioConstraints(deviceId?: string): MediaTrackConstraints {
  const cleanDeviceId = (deviceId ?? "").trim();
  if (!cleanDeviceId || cleanDeviceId === "default") return VOICE_AUDIO_CONSTRAINTS;
  return {
    ...VOICE_AUDIO_CONSTRAINTS,
    deviceId: { exact: cleanDeviceId },
  };
}

function preferHeadsetDevice(devices: MediaDeviceInfo[]): MediaDeviceInfo | undefined {
  const usable = devices.filter((device) => device.deviceId && device.deviceId !== "default");
  const headset = usable.find((device) => {
    const label = device.label.toLowerCase();
    return label.includes("headset") || label.includes("headphone") || label.includes("airpods") || label.includes("jabra") || label.includes("poly") || label.includes("plantronics");
  });
  return headset ?? usable.find((device) => device.deviceId === "communications") ?? usable[0];
}

// ── JsSIP dynamic import ────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsSIPModule = any;

async function loadJsSIP(): Promise<JsSIPModule> {
  if (typeof window === "undefined") throw new Error("JsSIP requires a browser");
  const mod = await import("jssip");
  (mod.default as JsSIPModule)?.debug?.disable?.("JsSIP:*");
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

function normalizeDialTargetForSip(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return trimmed;
  return trimmed.replace(/[()\-\s.]/g, "");
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

// ── Local JsSIP engine hook ────────────────────────────────────────────────

function useLocalSipPhone(): SipPhoneState & SipPhoneActions {
  const [regState, setRegState] = useState<SipRegState>("idle");
  const [callState, setCallState] = useState<SipCallState>("idle");
  const [callDirection, setCallDirection] = useState<"outbound" | "inbound" | null>(null);
  const [remoteParty, setRemoteParty] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [onHold, setOnHold] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [currentSinkId, setCurrentSinkId] = useState("");
  const [currentMicDeviceId, setCurrentMicDeviceId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<SipDiagnostics>(DEFAULT_DIAG);
  const [dialpadInput, setDialpadInput] = useState("");
  const [outboundRoutes, setOutboundRoutes] = useState<OutboundDialRoute[]>([]);
  const [selectedOutboundRouteId, setSelectedOutboundRouteId] = useState("");

  const { startRingback, startRingtone, playDtmfTone, stopAll: stopAllAudio } = useTelephonyAudio();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uaRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionRef = useRef<any>(null);
  // ── Multi-call bookkeeping ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionsByIdRef = useRef<Map<string, any>>(new Map());
  const sessionMetaRef = useRef<Map<string, MultiCallSession>>(new Map());
  const [sessions, setSessions] = useState<MultiCallSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [heldSessionIds, setHeldSessionIds] = useState<string[]>([]);
  const [ringingSessionIds, setRingingSessionIds] = useState<string[]>([]);
  /** Unique id counter for sessions that JsSIP doesn't expose a stable id on. */
  const sessionIdCounterRef = useRef<number>(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const currentMicDeviceIdRef = useRef("");
  const MAX_CONCURRENT_SESSIONS_WEB = 5;

  function getOrAssignSessionId(s: unknown): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sess = s as any;
    if (sess.__mcId && typeof sess.__mcId === "string") return sess.__mcId;
    const id =
      (typeof sess.id === "string" && sess.id) ||
      `mc-${++sessionIdCounterRef.current}-${Date.now()}`;
    sess.__mcId = id;
    return id;
  }

  function publishMultiCallState() {
    const all = Array.from(sessionMetaRef.current.values()).sort(
      (a, b) => a.startedAt - b.startedAt,
    );
    setSessions(all);
    setHeldSessionIds(all.filter((x) => x.onHold).map((x) => x.id));
    setRingingSessionIds(
      all.filter((x) => x.state === "ringing" && x.direction === "inbound").map((x) => x.id),
    );
    const activeId = all.find((x) => x.isActive)?.id ?? null;
    activeSessionIdRef.current = activeId;
    setActiveSessionId(activeId);
    console.log(
      `[MULTICALL_STATE] web active=${activeId} held=[${all
        .filter((x) => x.onHold)
        .map((x) => x.id)
        .join(",")}] ringing=[${all
        .filter((x) => x.state === "ringing")
        .map((x) => x.id)
        .join(",")}]`,
    );
  }

  useEffect(() => {
    currentMicDeviceIdRef.current = currentMicDeviceId;
  }, [currentMicDeviceId]);

  function registerSessionMeta(
    id: string,
    patch: Partial<MultiCallSession> & Pick<MultiCallSession, "remoteParty" | "direction">,
  ) {
    const existing = sessionMetaRef.current.get(id);
    const meta: MultiCallSession = {
      id,
      remoteParty: patch.remoteParty,
      direction: patch.direction,
      state: patch.state ?? existing?.state ?? "ringing",
      onHold: patch.onHold ?? existing?.onHold ?? false,
      isActive: patch.isActive ?? existing?.isActive ?? false,
      startedAt: existing?.startedAt ?? Date.now(),
    };
    sessionMetaRef.current.set(id, meta);
    publishMultiCallState();
  }

  function patchSessionMeta(id: string, patch: Partial<MultiCallSession>) {
    const existing = sessionMetaRef.current.get(id);
    if (!existing) return;
    sessionMetaRef.current.set(id, { ...existing, ...patch });
    publishMultiCallState();
  }

  function removeSessionMeta(id: string) {
    const removed = sessionMetaRef.current.get(id);
    sessionMetaRef.current.delete(id);
    sessionsByIdRef.current.delete(id);

    if (removed?.isActive) {
      // LIFO restore: most-recently-held call resumes.
      const held = Array.from(sessionMetaRef.current.values())
        .filter((s) => s.onHold)
        .sort((a, b) => b.startedAt - a.startedAt);
      const next = held[0];
      if (next) {
        console.log(`[MULTICALL_RESUME] web restoring_next_held call=${next.id}`);
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        internalUnhold(next.id);
      }
    }
    publishMultiCallState();
  }

  /** Issue SIP unhold on the given session and mark it active. */
  function internalUnhold(id: string) {
    const s = sessionsByIdRef.current.get(id);
    if (!s) return;
    try {
      s.unhold();
    } catch (err) {
      console.warn("[MULTICALL_RESUME] unhold threw:", err);
    }
    sessionRef.current = s;
    patchSessionMeta(id, { onHold: false, isActive: true, state: "connected" });
    // Other active sessions stay held unless user holds them explicitly.
  }

  /** Issue SIP hold on the given session and mark it held. */
  function internalHold(id: string) {
    const s = sessionsByIdRef.current.get(id);
    if (!s) return;
    try {
      s.hold();
    } catch (err) {
      console.warn("[MULTICALL_HOLD] hold threw:", err);
    }
    patchSessionMeta(id, { onHold: true, isActive: false, state: "held" });
  }
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
  /** Guard: prevents duplicate CALL_QUALITY_REPORT when both user_hangup and the
   *  subsequent SIP "ended" event fire submitCallQualityReport for the same call. */
  const finalReportSentRef = useRef<boolean>(false);

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
    // Guard: user_hangup fires terminate() which triggers the SIP "ended" event,
    // causing a second call here. Only the first invocation per call should send.
    if (finalReportSentRef.current) {
      console.log("[SipPhone] quality_report_suppressed reason=" + endReason);
      return;
    }
    finalReportSentRef.current = true;

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

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    apiGet<{ routes: OutboundDialRoute[] }>("/me/outbound-routes")
      .then((result) => {
        if (cancelled) return;
        const routes = (result.routes || []).filter((route) => route && route.id);
        setOutboundRoutes(routes);
        setSelectedOutboundRouteId("");
      })
      .catch(() => {
        if (!cancelled) {
          setOutboundRoutes([]);
          setSelectedOutboundRouteId("");
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (callState === "idle" || callState === "ended") setSelectedOutboundRouteId("");
  }, [callState]);

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
        // 401 means the auth token wasn't ready yet (race condition on startup).
        // Retry silently after a short delay instead of surfacing an error.
        if (e instanceof ApiError && e.status === 401) {
          setTimeout(() => {
            if (cancelled) return;
            try { init(); } catch { /* ignore */ }
          }, 2_500);
          return;
        }
        const fromBody =
          e instanceof ApiError && e.body && typeof e.body === "object"
            ? (e.body as { extensionNumber?: string; message?: string })
            : null;
        const extNum = fromBody?.extensionNumber?.trim() || null;
        const raw = e instanceof Error ? e.message : "EXTENSION_NOT_FOUND";
        const msg =
          e instanceof ApiError && e.status === 403
            ? "FORBIDDEN — Your account cannot load Connect phone settings. Ask an administrator to update your permissions."
            : raw.includes("EXTENSION_NOT_PROVISIONED")
              ? `EXTENSION_NOT_PROVISIONED — ${fromBody?.message || `Extension ${extNum || "?"} is not linked to the PBX yet. Ask an administrator to sync or re-provision WebRTC.`}`
              : raw.includes("EXTENSION_NOT_ASSIGNED") || raw.includes("EXTENSION_NOT_FOUND")
                ? "EXTENSION_NOT_ASSIGNED — No extension is assigned to your account. Contact your administrator to assign one via PBX → Extensions."
                : raw.includes("PBX_NOT_LINKED")
                  ? "PBX_NOT_LINKED — The PBX is not configured for your account. Contact your administrator."
                  : raw;
        setError(msg);
        patchDiag({
          webrtcEnabled: false,
          ...(extNum ? { extensionNumber: extNum } : {}),
        });
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
        const fromBody =
          e instanceof ApiError && e.body && typeof e.body === "object"
            ? (e.body as { extensionNumber?: string; message?: string })
            : null;
        const extNum = fromBody?.extensionNumber?.trim() || null;
        const raw = e instanceof Error ? e.message : "SIP_CREDENTIAL_FETCH_FAILED";
        const msg = raw.includes("EXTENSION_NOT_PROVISIONED")
          ? `EXTENSION_NOT_PROVISIONED — ${fromBody?.message || `Extension ${extNum || "?"} is not linked to the PBX yet.`}`
          : raw.includes("SIP_CREDENTIAL_NOT_SET")
            ? "SIP_CREDENTIAL_NOT_SET — An administrator must set the SIP password for this extension."
            : raw.includes("RATE_LIMITED")
              ? "RATE_LIMITED — Too many credential requests. Reload the page to retry."
              : `Failed to fetch SIP credentials: ${raw}. Try refreshing the page.`;
        setError(msg);
        patchDiag({ lastRegError: msg, ...(extNum ? { extensionNumber: extNum } : {}) });
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
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        const queueReconnect = (delayMs = 2_500) => {
          if (reconnectTimer) return;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (cancelled || uaRef.current !== ua) return;
            try {
              setRegState("connecting");
              ua.start();
            } catch (err) {
              console.warn("[SipPhone] reconnect start failed", err);
            }
          }, delayMs);
        };

        ua.on("connecting", () => { if (!cancelled) setRegState("connecting"); });
        ua.on("connected",  () => { if (!cancelled) setRegState("registering"); });

        ua.on("disconnected", () => {
          if (!cancelled) {
            setRegState("failed");
            const msg = "SIP WebSocket disconnected. Check PBX WSS transport on port 8089.";
            setError(msg);
            patchDiag({ lastRegError: msg });
            queueReconnect(2_500);
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
                .getUserMedia({ audio: voiceAudioConstraints(currentMicDeviceIdRef.current), video: false })
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

        ua.on("unregistered", () => {
          if (cancelled) return;
          // Desktop phone engine should remain registered. When we are unexpectedly
          // unregistered after login/reload, trigger a reconnect instead of idling
          // forever (which shows as "Offline" in the mini dialer).
          setRegState("registering");
          queueReconnect(1_000);
        });

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
            // Keep retrying in desktop so users do not get stuck on Offline after reload.
            if (regFailCount >= 3) {
              setError(`SIP registration failed: ${e.cause}. Reconnecting...`);
              queueReconnect(3_000);
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

            // Multi-call accounting: track every session the UA knows about,
            // regardless of originator. The legacy single-call accessors below
            // only follow the current "foreground" call via sessionRef.
            const mcId = getOrAssignSessionId(data.session);
            const activeCount = sessionsByIdRef.current.size;
            if (activeCount >= MAX_CONCURRENT_SESSIONS_WEB && data.originator === "remote") {
              console.warn(
                `[MULTICALL] web max_concurrent_sessions_reached=${activeCount} rejecting inbound ${mcId}`,
              );
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (data.session as any).terminate({ status_code: 486, reason_phrase: "Busy Here" });
              } catch { /* ignore */ }
              return;
            }
            sessionsByIdRef.current.set(mcId, data.session);

            if (data.originator === "remote") {
              const party = data.request.from.display_name || data.request.from.uri.user;
              console.log(`[MULTICALL] web incoming call=${mcId} from=${party} activeBefore=${activeSessionIdRef.current ?? "none"}`);
              registerSessionMeta(mcId, {
                remoteParty: party,
                direction: "inbound",
                state: "ringing",
                onHold: false,
                isActive: false,
              });

              if (!sessionRef.current || sessionRef.current.isEnded?.()) {
                // Idle path — let the existing single-call flow drive the UI.
                callDirectionRef.current = "inbound";
                setCallDirection("inbound");
                setOnHold(false);
                bindSession(data.session, party);
                setCallState("ringing");
                setRemoteParty(party);
                console.log("[SIP] INCOMING_CALL from:", party);
                startRingtone();
              } else {
                // Call-waiting path — do NOT hijack the primary callState UI.
                // Bind lightweight per-session listeners so multi-call meta is
                // accurate; the softphone's MultiCallPanel renders the banner.
                bindSideSession(data.session, party, mcId);
                console.log(`[MULTICALL] web call_waiting incoming=${mcId} while active=${activeSessionIdRef.current}`);
                startRingtone();
              }
            } else {
              // Outbound — bindSession sets the meta once the session binds.
              registerSessionMeta(mcId, {
                remoteParty: String(data.session.remote_identity?.uri?.user ?? ""),
                direction: "outbound",
                state: "dialing",
                onHold: false,
                isActive: true,
              });
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
        setTimeout(() => {
          if (cancelled || uaRef.current) return;
          try { init(); } catch { /* ignore */ }
        }, 3_000);
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
        // Fallback: if SIP confirmed/accepted didn't fire (some PBX configs),
        // ICE media path succeeding is a reliable signal that the call is live.
        setCallState((prev) => (prev === "ringing" || prev === "dialing") ? "connected" : prev);
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
    const mcId = getOrAssignSessionId(session);
    patchSessionMeta(mcId, { remoteParty: party, isActive: true });

    session.on("progress", () => {
      // Guard: never regress from "connected" → "ringing". A late SIP 180 Ringing
      // can arrive after 200 OK on some VitalPBX proxy setups; without this guard
      // the call transitions back to the ringing/outgoing screen after connecting.
      setCallState((prev) => (prev === "dialing" ? "ringing" : prev));
      patchSessionMeta(mcId, { state: "ringing" });
      // Outbound: play US ringback — skip if session already established (late 180)
      if (callDirectionRef.current === "outbound" && !session.isEstablished?.()) startRingback();
    });
    session.on("accepted", () => {
      stopAllAudio();
      if (!callStartedAtRef.current) {
        callStartedAtRef.current = Date.now();
        finalReportSentRef.current = false;
      }
      console.log("[SIP] CALL_ACCEPTED");
      setCallState("connected");
      patchSessionMeta(mcId, { state: "connected", onHold: false, isActive: true });
      if (session.connection) syncReceiversToAudio(session.connection);
    });
    session.on("confirmed", () => {
      stopAllAudio();
      if (!callStartedAtRef.current) {
        callStartedAtRef.current = Date.now();
        finalReportSentRef.current = false;
      }
      console.log("[SIP] CALL_ACCEPTED (confirmed)");
      setCallState("connected");
      patchSessionMeta(mcId, { state: "connected", onHold: false, isActive: true });
      if (session.connection) syncReceiversToAudio(session.connection);
    });
    session.on("hold", () => {
      console.log(`[MULTICALL_HOLD] web session=${mcId} hold_event`);
      patchSessionMeta(mcId, { onHold: true, state: "held", isActive: false });
    });
    session.on("unhold", () => {
      console.log(`[MULTICALL_RESUME] web session=${mcId} unhold_event`);
      patchSessionMeta(mcId, { onHold: false, state: "connected", isActive: true });
    });

    session.on("ended", () => {
      stopAllAudio();
      console.log("[SIP] CALL_ENDED");
      // Cancel stale-hangup timer — call ended normally via SIP, no need for force cleanup
      if (staleHangupTimerRef.current) { clearTimeout(staleHangupTimerRef.current); staleHangupTimerRef.current = null; }
      submitCallQualityReport("normal");
      // Multi-call: drop from map. If this was the active call and other
      // sessions are held, removeSessionMeta will auto-unhold the next LIFO.
      removeSessionMeta(mcId);
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
      removeSessionMeta(mcId);
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

  /**
   * Lightweight session binding for a call-waiting inbound session while
   * another session is already active. Only updates multi-call meta — does
   * NOT touch the primary callState / remoteParty / sessionRef.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindSideSession(session: any, party: string, mcId: string) {
    session.on("progress", () => {
      patchSessionMeta(mcId, { state: "ringing", remoteParty: party });
    });
    session.on("accepted", () => {
      // Answered via answerSession — promotion to active is handled there.
      patchSessionMeta(mcId, { state: "connected" });
    });
    session.on("confirmed", () => {
      patchSessionMeta(mcId, { state: "connected" });
    });
    session.on("hold", () => {
      patchSessionMeta(mcId, { onHold: true, state: "held", isActive: false });
    });
    session.on("unhold", () => {
      patchSessionMeta(mcId, { onHold: false, state: "connected", isActive: true });
    });
    session.on("ended", () => {
      console.log(`[MULTICALL] web side_session_ended=${mcId}`);
      removeSessionMeta(mcId);
    });
    session.on("failed", () => {
      console.log(`[MULTICALL] web side_session_failed=${mcId}`);
      removeSessionMeta(mcId);
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  const selectedOutboundRoute = outboundRoutes.find((route) => route.id === selectedOutboundRouteId) || null;

  const dial = useCallback(
    (target: string) => {
      if (!uaRef.current || regState !== "registered") {
        setError("Not registered. Wait for SIP registration before dialling.");
        return;
      }
      // Guard: callStartedAtRef is set synchronously at the start of this function
      // before any async work. A second rapid invocation (double-click, Enter+click)
      // will see it already set and bail out before placing a second SIP INVITE.
      if (callStartedAtRef.current !== null) {
        console.warn("[SipPhone] dial() suppressed — call already in progress");
        return;
      }
      const domain = uaRef.current._configuration?.uri?.host;
      if (!domain) return;
      const normalised = target.trim();
      if (!normalised) return;

      // Multi-call policy: if another session is currently active, put it on
      // hold before starting the new outbound call.
      const currentActive = Array.from(sessionMetaRef.current.values()).find(
        (x) => x.isActive,
      );
      if (currentActive) {
        console.log(
          `[MULTICALL_HOLD] web auto-holding active=${currentActive.id} before outbound to ${normalised}`,
        );
        internalHold(currentActive.id);
      }

      callDirectionRef.current = "outbound";
      setCallDirection("outbound");
      callStartedAtRef.current = Date.now();
      finalReportSentRef.current = false;
      setCallState("dialing");
      setError(null);
      setOnHold(false);
      console.log("[SIP] CALL_INITIATED target:", normalised, "route:", selectedOutboundRoute?.name || "none");
      // Start ringback immediately on dial (before "progress" from PBX)
      startRingback();

      const resolveDialTarget = selectedOutboundRoute
        ? apiPost<{ finalNumber: string }>("/me/outbound-routes/resolve-dial", {
            number: normalised,
            outboundRouteId: selectedOutboundRoute.id,
          }).then((result) => result.finalNumber || normalizeDialTargetForSip(normalised))
        : Promise.resolve(normalised);

      resolveDialTarget
        .then((pbxDialTarget) => navigator.mediaDevices
        .getUserMedia({ audio: voiceAudioConstraints(currentMicDeviceIdRef.current), video: false })
        .then((localStream) => {
          localStreamRef.current = localStream;
          try {
            const session = uaRef.current!.call(`sip:${pbxDialTarget}@${domain}`, {
              mediaStream: localStream,
              pcConfig: uaRef.current!._configuration?.pcConfig ?? {},
            });
            bindSession(session, normalised);
          } catch (e: unknown) {
            localStream.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
            setCallState("idle");
            setSelectedOutboundRouteId("");
            const msg = e instanceof Error ? e.message : "Call failed";
            setError(msg);
            patchDiag({ lastCallError: msg });
          }
        })
        .catch((err) => {
          setCallState("idle");
          setSelectedOutboundRouteId("");
          if (err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError") {
            setError("Microphone access denied. Allow microphone in your browser settings for this site, then try again.");
          } else if (err?.name === "NotFoundError") {
            setError("No microphone found. Connect a headset or microphone and try again.");
          } else {
            setError(`Microphone error: ${err?.message ?? err}`);
          }
          patchDiag({ lastCallError: `mic_error: ${err?.name}`, micPermission: "denied" });
        }))
        .catch((err) => {
          setCallState("idle");
          setSelectedOutboundRouteId("");
          const msg = err instanceof Error ? err.message : "Could not resolve outbound route";
          setError(msg);
          patchDiag({ lastCallError: msg });
          stopAllAudio();
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outboundRoutes, regState, selectedOutboundRouteId],
  );

  const answer = useCallback(() => {
    if (!sessionRef.current) return;
    stopAllAudio(); // Stop ringtone immediately on answer
    navigator.mediaDevices
      .getUserMedia({ audio: voiceAudioConstraints(currentMicDeviceIdRef.current), video: false })
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

  // ── Audio device routing ───────────────────────────────────────────────────

  /** Enumerate audio input/output devices and refresh state. */
  const refreshAudioDevices = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const outputs = devices.filter((d) => d.kind === "audiooutput");
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);
      if (!currentMicDeviceIdRef.current) {
        const preferred = preferHeadsetDevice(inputs);
        if (preferred?.deviceId) setCurrentMicDeviceId(preferred.deviceId);
      }
    } catch { /* permissions not granted yet */ }
  }, []);

  const setAudioInputDeviceId = useCallback(async (deviceId: string) => {
    setCurrentMicDeviceId(deviceId);
    currentMicDeviceIdRef.current = deviceId;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: voiceAudioConstraints(deviceId), video: false });
      probe.getTracks().forEach((track) => track.stop());
      patchDiag({ micPermission: "granted", lastCallError: null });
      await refreshAudioDevices();
    } catch (err: any) {
      patchDiag({ micPermission: "denied", lastCallError: `mic_select_failed: ${err?.name ?? "unknown"}` });
      throw err;
    }
  }, [refreshAudioDevices]);

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

  useEffect(() => {
    void refreshAudioDevices();
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.addEventListener) return undefined;
    const handleDeviceChange = () => void refreshAudioDevices();
    navigator.mediaDevices.addEventListener("devicechange", handleDeviceChange);
    return () => navigator.mediaDevices.removeEventListener("devicechange", handleDeviceChange);
  }, [refreshAudioDevices]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.connectDesktop?.window) return undefined;
    let cancelled = false;
    window.connectDesktop.window.getSettings()
      .then((desktopSettings) => {
        if (cancelled) return;
        if (desktopSettings.selectedMicDeviceId) void setAudioInputDeviceId(desktopSettings.selectedMicDeviceId).catch(() => undefined);
        if (desktopSettings.selectedSpeakerDeviceId) void setAudioSinkId(desktopSettings.selectedSpeakerDeviceId);
      })
      .catch(() => undefined);
    const unsubscribe = window.connectDesktop.window.onSettings((desktopSettings) => {
      if (desktopSettings.selectedMicDeviceId != null && desktopSettings.selectedMicDeviceId !== currentMicDeviceIdRef.current) {
        void setAudioInputDeviceId(desktopSettings.selectedMicDeviceId).catch(() => undefined);
      }
      if (desktopSettings.selectedSpeakerDeviceId != null && desktopSettings.selectedSpeakerDeviceId !== currentSinkId) {
        void setAudioSinkId(desktopSettings.selectedSpeakerDeviceId);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [currentSinkId, setAudioInputDeviceId, setAudioSinkId]);

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
    if (callState === "connected") void refreshAudioDevices();
  }, [callState, refreshAudioDevices]);

  // Reset speaker state on call end
  useEffect(() => {
    if (callState === "idle" || callState === "ended") {
      setSpeakerOn(false);
      setCurrentSinkId("");
    }
  }, [callState]);

  // ── Blind transfer ──────────────────────────────────────────────────────────

  // ── Multi-call actions ──────────────────────────────────────────────────

  const answerSession = useCallback((id: string) => {
    const s = sessionsByIdRef.current.get(id);
    if (!s) {
      console.warn(`[MULTICALL] answerSession: no session for id=${id}`);
      return;
    }
    // Hold any currently active session before answering the new one.
    const active = Array.from(sessionMetaRef.current.values()).find((x) => x.isActive);
    if (active && active.id !== id) {
      console.log(`[MULTICALL_HOLD] web holding active=${active.id} before answering ${id}`);
      internalHold(active.id);
    }
    stopAllAudio();
    navigator.mediaDevices
      .getUserMedia({ audio: voiceAudioConstraints(currentMicDeviceIdRef.current), video: false })
      .then((localStream) => {
        localStreamRef.current = localStream;
        try {
          s.answer({ mediaStream: localStream });
          sessionRef.current = s;
          const meta = sessionMetaRef.current.get(id);
          if (meta) {
            const party = meta.remoteParty;
            setRemoteParty(party);
            callDirectionRef.current = meta.direction;
            setCallDirection(meta.direction);
            setCallState("connected");
          }
          patchSessionMeta(id, { isActive: true, onHold: false, state: "connected" });
        } catch (e) {
          localStream.getTracks().forEach((t) => t.stop());
          localStreamRef.current = null;
          setError(e instanceof Error ? e.message : "Answer failed");
        }
      })
      .catch((err) => {
        setError(`Microphone error: ${err?.message ?? err}`);
      });
  }, [stopAllAudio]);

  const holdSession = useCallback((id: string) => {
    console.log(`[MULTICALL_HOLD] web explicit hold session=${id}`);
    internalHold(id);
  }, []);

  const resumeSession = useCallback((id: string) => {
    const active = Array.from(sessionMetaRef.current.values()).find((x) => x.isActive);
    if (active && active.id !== id) {
      console.log(`[MULTICALL_HOLD] web holding active=${active.id} before resuming ${id}`);
      internalHold(active.id);
    }
    console.log(`[MULTICALL_RESUME] web resuming session=${id}`);
    internalUnhold(id);
    const meta = sessionMetaRef.current.get(id);
    if (meta) {
      setRemoteParty(meta.remoteParty);
      callDirectionRef.current = meta.direction;
      setCallDirection(meta.direction);
      setCallState("connected");
    }
  }, []);

  const hangupSession = useCallback((id: string) => {
    const s = sessionsByIdRef.current.get(id);
    if (!s) return;
    console.log(`[MULTICALL] web hangup session=${id}`);
    try { s.terminate(); } catch { /* already ended */ }
    // removeSessionMeta will fire via session.on("ended") handler.
  }, []);

  const swapToSession = useCallback((id: string) => {
    resumeSession(id);
  }, [resumeSession]);

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
    audioInputDevices,
    currentSinkId,
    currentMicDeviceId,
    error,
    diag,
    outboundRoutes,
    selectedOutboundRouteId,
    selectedOutboundRoute,
    dial,
    answer,
    hangup,
    setMute,
    toggleHold,
    toggleSpeaker,
    setAudioSinkId,
    setAudioInputDeviceId,
    refreshAudioDevices,
    sendDtmf,
    playDtmfTone,
    transfer,
    dialpadInput,
    setDialpadInput,
    setSelectedOutboundRouteId,
    sessions,
    activeSessionId,
    heldSessionIds,
    ringingSessionIds,
    answerSession,
    holdSession,
    resumeSession,
    hangupSession,
    swapToSession,
  };
}

const SIP_PHONE_ACTIONS = [
  "dial",
  "answer",
  "hangup",
  "setMute",
  "toggleHold",
  "toggleSpeaker",
  "setAudioSinkId",
  "setAudioInputDeviceId",
  "refreshAudioDevices",
  "sendDtmf",
  "playDtmfTone",
  "transfer",
  "setDialpadInput",
  "setSelectedOutboundRouteId",
  "answerSession",
  "holdSession",
  "resumeSession",
  "hangupSession",
  "swapToSession",
] as const;

const SipPhoneContext = createContext<(SipPhoneState & SipPhoneActions) | null>(null);

function isDesktopProxyWindow(): boolean {
  if (typeof window === "undefined") return false;
  // Only the mini window is a proxy — it receives state from the full window via IPC.
  // The full window runs LocalSipPhoneProvider directly (same as the web app),
  // so it always works even if the hidden phone-engine window has issues.
  return window.connectDesktop?.windowKind === "mini";
}

function localStateSnapshot(phone: SipPhoneState & SipPhoneActions): SipPhoneState & Pick<SipPhoneActions, "dialpadInput" | "sessions" | "activeSessionId" | "heldSessionIds" | "ringingSessionIds"> {
  return {
    regState: phone.regState,
    callState: phone.callState,
    callDirection: phone.callDirection,
    remoteParty: phone.remoteParty,
    muted: phone.muted,
    onHold: phone.onHold,
    speakerOn: phone.speakerOn,
    audioOutputDevices: phone.audioOutputDevices.map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      kind: device.kind,
      label: device.label,
      // No toJSON — Electron IPC uses Structured Clone which cannot serialize functions.
    }) as MediaDeviceInfo),
    audioInputDevices: phone.audioInputDevices.map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      kind: device.kind,
      label: device.label,
      // No toJSON — Electron IPC uses Structured Clone which cannot serialize functions.
    }) as MediaDeviceInfo),
    currentSinkId: phone.currentSinkId,
    currentMicDeviceId: phone.currentMicDeviceId,
    error: phone.error,
    diag: phone.diag,
    outboundRoutes: phone.outboundRoutes,
    selectedOutboundRouteId: phone.selectedOutboundRouteId,
    selectedOutboundRoute: phone.selectedOutboundRoute,
    dialpadInput: phone.dialpadInput,
    sessions: phone.sessions,
    activeSessionId: phone.activeSessionId,
    heldSessionIds: phone.heldSessionIds,
    ringingSessionIds: phone.ringingSessionIds,
  };
}

function noopSetState<T>(_value: React.SetStateAction<T>): void {
  // Replaced by real implementations in local/proxy providers.
}

const DEFAULT_PHONE_CONTEXT: SipPhoneState & SipPhoneActions = {
  regState: "idle",
  callState: "idle",
  callDirection: null,
  remoteParty: null,
  muted: false,
  onHold: false,
  speakerOn: false,
  audioOutputDevices: [],
  audioInputDevices: [],
  currentSinkId: "",
  currentMicDeviceId: "",
  error: null,
  diag: DEFAULT_DIAG,
  outboundRoutes: [],
  selectedOutboundRouteId: "",
  selectedOutboundRoute: null,
  dial: () => undefined,
  answer: () => undefined,
  hangup: () => undefined,
  setMute: () => undefined,
  toggleHold: () => undefined,
  toggleSpeaker: () => undefined,
  setAudioSinkId: () => Promise.resolve(),
  setAudioInputDeviceId: () => Promise.resolve(),
  refreshAudioDevices: () => Promise.resolve(),
  sendDtmf: () => undefined,
  playDtmfTone: () => undefined,
  transfer: () => undefined,
  dialpadInput: "",
  setDialpadInput: noopSetState,
  setSelectedOutboundRouteId: noopSetState,
  sessions: [],
  activeSessionId: null,
  heldSessionIds: [],
  ringingSessionIds: [],
  answerSession: () => undefined,
  holdSession: () => undefined,
  resumeSession: () => undefined,
  hangupSession: () => undefined,
  swapToSession: () => undefined,
};

function LocalSipPhoneProvider({ children }: { children: ReactNode }) {
  const phone = useLocalSipPhone();
  const latestPhone = useRef(phone);

  useEffect(() => {
    latestPhone.current = phone;
  }, [phone]);

  useEffect(() => {
    // Handle commands from mini window proxy — both the full window and phone-engine handle them.
    const kind = typeof window !== "undefined" ? window.connectDesktop?.windowKind : undefined;
    if (!window.connectDesktop || (kind !== "phone-engine" && kind !== "full")) return;
    return window.connectDesktop.phone.onCommand(({ command, args }) => {
      if (command === "requestStateSnapshot") {
        window.connectDesktop?.phone.sendFromEngine({
          type: "state",
          payload: localStateSnapshot(latestPhone.current),
        });
        return;
      }
      if (!SIP_PHONE_ACTIONS.includes(command as (typeof SIP_PHONE_ACTIONS)[number])) return;
      const target = latestPhone.current[command as keyof SipPhoneActions];
      if (typeof target !== "function") return;
      try {
        (target as (...values: unknown[]) => unknown)(...(args ?? []));
      } catch (err) {
        console.error("[DESKTOP_PHONE_ENGINE] command failed", command, err);
      }
    });
  }, []);

  useEffect(() => {
    // Broadcast state to mini window proxy — both full window and phone-engine broadcast.
    const kind = typeof window !== "undefined" ? window.connectDesktop?.windowKind : undefined;
    if (!window.connectDesktop || (kind !== "phone-engine" && kind !== "full")) return;
    window.connectDesktop.phone.sendFromEngine({
      type: "state",
      payload: localStateSnapshot(phone),
    });
  }, [phone]);

  return React.createElement(SipPhoneContext.Provider, { value: phone }, children);
}

function DesktopSipPhoneProxyProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<SipPhoneState & Pick<SipPhoneActions, "dialpadInput" | "sessions" | "activeSessionId" | "heldSessionIds" | "ringingSessionIds">>(
    localStateSnapshot(DEFAULT_PHONE_CONTEXT),
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.connectDesktop) return;
    const unsubscribe = window.connectDesktop.phone.onEngineEvent((envelope) => {
      if (envelope.type !== "state") return;
      const next = envelope.payload as typeof snapshot;
      setSnapshot((prev) => ({ ...prev, ...next }));
    });
    void window.connectDesktop.phone.sendCommand({ command: "requestStateSnapshot", args: [] }).catch(() => undefined);
    const attempts = { count: 0 };
    const timer = window.setInterval(() => {
      attempts.count += 1;
      void window.connectDesktop?.phone.sendCommand({ command: "requestStateSnapshot", args: [] }).catch(() => undefined);
      if (attempts.count >= 8) window.clearInterval(timer);
    }, 1_500);
    return () => {
      window.clearInterval(timer);
      unsubscribe();
    };
  }, []);

  const send = useCallback((command: string, args: unknown[] = []) => {
    if (typeof window === "undefined" || !window.connectDesktop) return Promise.resolve();
    return window.connectDesktop.phone.sendCommand({ command, args }).then(() => undefined);
  }, []);

  const value = useMemo<SipPhoneState & SipPhoneActions>(() => ({
    ...snapshot,
    dial: (target) => { void send("dial", [target]); },
    answer: () => { void send("answer"); },
    hangup: () => { void send("hangup"); },
    setMute: (mute) => { void send("setMute", [mute]); },
    toggleHold: () => { void send("toggleHold"); },
    toggleSpeaker: () => { void send("toggleSpeaker"); },
    setAudioSinkId: (sinkId) => send("setAudioSinkId", [sinkId]),
    setAudioInputDeviceId: (deviceId) => send("setAudioInputDeviceId", [deviceId]),
    refreshAudioDevices: () => send("refreshAudioDevices"),
    sendDtmf: (digit) => { void send("sendDtmf", [digit]); },
    playDtmfTone: (digit) => { void send("playDtmfTone", [digit]); },
    transfer: (target) => { void send("transfer", [target]); },
    setDialpadInput: (nextValue) => {
      setSnapshot((prev) => {
        const next = typeof nextValue === "function" ? nextValue(prev.dialpadInput) : nextValue;
        void send("setDialpadInput", [next]);
        return { ...prev, dialpadInput: next };
      });
    },
    setSelectedOutboundRouteId: (nextValue) => {
      setSnapshot((prev) => {
        const next = typeof nextValue === "function" ? nextValue(prev.selectedOutboundRouteId) : nextValue;
        void send("setSelectedOutboundRouteId", [next]);
        return {
          ...prev,
          selectedOutboundRouteId: next,
          selectedOutboundRoute: prev.outboundRoutes.find((route) => route.id === next) ?? null,
        };
      });
    },
    answerSession: (id) => { void send("answerSession", [id]); },
    holdSession: (id) => { void send("holdSession", [id]); },
    resumeSession: (id) => { void send("resumeSession", [id]); },
    hangupSession: (id) => { void send("hangupSession", [id]); },
    swapToSession: (id) => { void send("swapToSession", [id]); },
  }), [send, snapshot]);

  return React.createElement(SipPhoneContext.Provider, { value }, children);
}

export function SipPhoneProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<"detecting" | "local" | "proxy">("detecting");

  useEffect(() => {
    setMode(isDesktopProxyWindow() ? "proxy" : "local");
  }, []);

  if (mode === "detecting") return null;
  if (mode === "proxy") return React.createElement(DesktopSipPhoneProxyProvider, null, children);
  return React.createElement(LocalSipPhoneProvider, null, children);
}

export function useSipPhone(): SipPhoneState & SipPhoneActions {
  const ctx = useContext(SipPhoneContext);
  if (!ctx) throw new Error("useSipPhone must be used inside SipPhoneProvider");
  return ctx;
}
