"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiGet, apiPost, ApiError, hasBrowserAuthToken } from "../services/apiClient";
import { splitRingGroupPrefix } from "../lib/ringGroupPrefix";
import { useTelephonyAudio } from "./useTelephonyAudio";
import { useTelephonySocket } from "./useTelephonySocket";
import type { LiveCall } from "../types/liveCall";
import {
  summarizeOfferSdp,
  isWebrtcSdpRejection,
  sdpRejectionLabel,
  checkOfferCompatibility,
  webrtcSdpDebugEnabled,
  redactSdpForDebug,
} from "../lib/webrtcSdpDiagnostics";
import { PortalWebrtcBlackboxRecorder } from "../lib/webrtcBlackboxRecorder";
import {
  extractJsSipFailureFields,
  inferSipRejectionSource,
  snapshotPeerConnection,
} from "@connect/shared/webrtcCallDiagnostics";

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

// ── Do Not Disturb ────────────────────────────────────────────────────────
// Shared localStorage flag (full + mini windows see the same store). The REAL
// phone (full window) checks it at INVITE time and simply IGNORES the inbound
// leg on this device — no ringtone, no UI, and crucially NO rejection, so the
// PBX keeps ringing every other device registered to the same extension
// (hard phones etc.). Only the softphone you toggled goes quiet.
export const DND_STORAGE_KEY = "cc-dnd";
export function isDndEnabled(): boolean {
  try { return typeof window !== "undefined" && localStorage.getItem(DND_STORAGE_KEY) === "1"; } catch { return false; }
}

export type MicPermission = "unknown" | "granted" | "denied" | "prompt";

export type IceCandidateType = "host" | "srflx" | "relay" | "prflx" | null;

/**
 * One transport/registration lifecycle event for the rolling connection log.
 * This is the ground-truth telemetry for diagnosing WebSocket flapping on
 * flaky / NAT-rotating networks (close code 1006 = abnormal/network drop,
 * 1001 = endpoint going away/tab hidden, 1000 = normal). Persisted to
 * localStorage so it survives reloads and can be copied from the diagnostics
 * panel without server-side capture.
 */
export interface ConnectionEvent {
  /** Epoch ms. */
  at: number;
  type:
    | "connecting"
    | "connected"
    | "registered"
    | "unregistered"
    | "disconnected"
    | "reconnect"
    | "hard-reinit"
    | "stale-socket"
    | "registrationFailed"
    | "init-failed"
    | "netchange"
    | "online"
    | "offline"
    | "visible";
  /** WebSocket close code when type === "disconnected". */
  code?: number;
  /** WebSocket close reason / cause text. */
  reason?: string;
  /** ms since the previous event — handy for spotting the ~30–60s flap cadence. */
  sincePrevMs?: number;
}

export interface SipDiagnostics {
  sipWssUrl: string | null;
  sipDomain: string | null;
  extensionNumber: string | null;
  sipUsername: string | null;
  authUsername: string | null;
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
  /** Inbound jitter buffer delay (WebRTC getStats), milliseconds. */
  jitterBufferMs: number | null;
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
  /** Outbound ringback phase: local synth until PBX/early-media takes over. */
  localRingback: "local" | "remote" | "off";
  lastRegError: string | null;
  lastCallError: string | null;
  webrtcEnabled: boolean;
  sipWssConfigured: boolean;
  sipDomainConfigured: boolean;
  /** Rolling transport/registration event log (most recent last). */
  connectionEvents: ConnectionEvent[];
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

/**
 * Extra SIP account (an extension from another tenant) attached to this user.
 * Shown in the same dialer dropdown as the outbound-route prefixes; selecting
 * one places the call from that account's own SIP registration.
 */
export type DialSipAccount = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  /** Display label — defaults to the tenant name the account belongs to. */
  label: string;
  extensionNumber: string | null;
  /** True when the account has everything needed to register (WebRTC on, creds set). */
  ready: boolean;
  /** Outbound-route prefixes this user may use within the account's tenant. */
  routes: OutboundDialRoute[];
};

/** Full per-account registration config from GET /voice/me/sip-accounts. */
type SipAccountConfig = DialSipAccount & {
  sipUsername: string | null;
  authUsername: string | null;
  hasSipPassword: boolean;
  webrtcEnabled: boolean;
  sipWsUrl: string | null;
  sipDomain: string | null;
  outboundProxy: string | null;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  dtmfMode?: "RFC2833" | "SIP_INFO";
};

/**
 * Encoding for the dialer dropdown selection (kept inside the existing
 * selectedOutboundRouteId string so the desktop mini-dialer IPC proxy keeps
 * working unchanged):
 *   ""                      → primary line, no prefix
 *   "<routeId>"             → primary line + outbound-route prefix
 *   "acct:<accountId>"      → extra SIP account, no prefix
 *   "acct:<accountId>|<routeId>" → extra SIP account + its tenant's prefix
 */
export const SIP_ACCOUNT_OPTION_PREFIX = "acct:";

export function encodeSipAccountOption(accountId: string, routeId?: string | null): string {
  return routeId ? `${SIP_ACCOUNT_OPTION_PREFIX}${accountId}|${routeId}` : `${SIP_ACCOUNT_OPTION_PREFIX}${accountId}`;
}

export function decodeSipAccountOption(value: string): { accountId: string; routeId: string | null } | null {
  if (!value.startsWith(SIP_ACCOUNT_OPTION_PREFIX)) return null;
  const [accountId, routeId] = value.slice(SIP_ACCOUNT_OPTION_PREFIX.length).split("|");
  if (!accountId) return null;
  return { accountId, routeId: routeId || null };
}

// ── Inbound-account memory (call back on the line the call came in on) ──────
// When an inbound call arrives on an extra SIP account we remember
// "caller → account". A later dial to that caller with no explicit dropdown
// selection automatically goes out from that same account. An inbound call on
// the PRIMARY line clears the memory for that caller.
const INBOUND_ACCOUNT_MAP_KEY = "connect.sip.inboundAccountMap.v1";
const INBOUND_ACCOUNT_MAP_MAX = 300;

function inboundPartyKey(value: string): string {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || String(value || "").trim().toLowerCase();
}

function readInboundAccountMap(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(INBOUND_ACCOUNT_MAP_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function rememberInboundAccount(party: string, accountId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const key = inboundPartyKey(party);
    if (!key) return;
    const map = readInboundAccountMap();
    if (accountId) map[key] = accountId;
    else delete map[key];
    const keys = Object.keys(map);
    if (keys.length > INBOUND_ACCOUNT_MAP_MAX) {
      for (const stale of keys.slice(0, keys.length - INBOUND_ACCOUNT_MAP_MAX)) delete map[stale];
    }
    window.localStorage.setItem(INBOUND_ACCOUNT_MAP_KEY, JSON.stringify(map));
  } catch {
    /* memory is best-effort — never break the call path */
  }
}

function lookupInboundAccount(party: string): string | null {
  const key = inboundPartyKey(party);
  if (!key) return null;
  return readInboundAccountMap()[key] || null;
}

/** One raw stat sample for debug panel. */
export interface RawStatSample {
  ts: number;
  packetsLost: number | null;
  packetsReceived: number | null;
  packetsSent: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  jitterBufferMs: number | null;
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
  /** Epoch ms when the active call connected (media established), else null. Drives the
   *  in-call timer — broadcast so the mini pop-out proxy shows the correct elapsed time. */
  callStartedAt: number | null;
  /** "outbound" when user placed the call, "inbound" when a SIP INVITE arrived, null when idle. */
  callDirection: "outbound" | "inbound" | null;
  remoteParty: string | null;
  remotePartyNumber: string | null;
  remotePartyName: string | null;
  remotePartyPrefix: string | null;
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
  /** Extra SIP accounts (other tenants' extensions) available to this user. Empty for most users. */
  sipAccounts: DialSipAccount[];
  /** Live registration state per extra SIP account id. */
  accountRegStates: Record<string, SipRegState>;
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
    setMiniTheme?: (theme: "dark" | "light") => Promise<unknown>;
    onMiniTheme?: (listener: (theme: "dark" | "light") => void) => () => void;
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
  jitterBufferMs: number | null;
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
    jitterBufferMs: null,
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
        if (typeof ir.jitterBufferDelay === "number") {
          result.jitterBufferMs = Math.round(ir.jitterBufferDelay * 1000);
        }
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
  authUsername: null,
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
  jitterBufferMs: null,
  rttMs: null,
  bytesReceived: null,
  bytesSent: null,
  bitrateKbps: null,
  audioLevel: null,
  remoteAudioReceiving: false,
  audioCodec: null,
  qualityGrade: null,
  rawSamples: [],
  localRingback: "off",
  lastRegError: null,
  lastCallError: null,
  webrtcEnabled: false,
  sipWssConfigured: false,
  sipDomainConfigured: false,
  connectionEvents: [],
};

// ── Connection-event telemetry (client-side, localStorage-backed ring buffer) ──
const CONN_LOG_KEY = "connect.sip.connlog.v1";
const CONN_LOG_MAX = 200;

/** Read the persisted connection-event ring buffer (safe on SSR / disabled storage). */
function readConnLog(): ConnectionEvent[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CONN_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ConnectionEvent[]).slice(-CONN_LOG_MAX) : [];
  } catch {
    return [];
  }
}

/**
 * Noisy ambient events (Network Information API fires `change` in bursts on
 * machines with VPN/virtual adapters — observed pairs every ~10s–6min on a
 * machine with Tailscale + Hyper-V) must not evict real transport events from
 * the ring buffer: during the 2026-07-29 incident the entire 50-slot log was
 * netchange pairs and every disconnect/reconnect had been pushed out. Collapse
 * repeats of the same noisy type within a window instead of appending.
 */
const NOISY_EVENT_COLLAPSE_MS: Partial<Record<ConnectionEvent["type"], number>> = {
  netchange: 120_000,
  online: 60_000,
  visible: 60_000,
};

/** Append one event to the persisted ring buffer and return the new capped list. */
function appendConnLog(ev: Omit<ConnectionEvent, "sincePrevMs">): ConnectionEvent[] {
  const prev = readConnLog();
  const last = prev[prev.length - 1];
  const collapseMs = NOISY_EVENT_COLLAPSE_MS[ev.type];
  if (collapseMs && last && last.type === ev.type && ev.at - last.at < collapseMs) {
    return prev; // repeat of a noisy ambient event — don't evict real history
  }
  const full: ConnectionEvent = {
    ...ev,
    sincePrevMs: last ? Math.max(0, ev.at - last.at) : undefined,
  };
  const next = [...prev, full].slice(-CONN_LOG_MAX);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CONN_LOG_KEY, JSON.stringify(next));
    } catch {
      /* storage full / disabled — telemetry must never break the phone */
    }
  }
  // Mirror to console for live debugging on the affected machine.
  const tag = ev.code != null ? `${ev.type} code=${ev.code}${ev.reason ? ` reason=${ev.reason}` : ""}` : ev.type;
  console.log(`[SipPhone][conn] ${tag} (+${full.sincePrevMs ?? 0}ms)`);
  return next;
}

// ── Local JsSIP engine hook ────────────────────────────────────────────────

function useLocalSipPhone(): SipPhoneState & SipPhoneActions {
  const [regState, setRegState] = useState<SipRegState>("idle");
  // Bumping this rebuilds the SIP engine from scratch (fresh JsSIP UA + registration),
  // exactly like a page reload — used to auto-recover a stuck "Connecting" state.
  const [reinitSeq, setReinitSeq] = useState(0);
  // Whether a session token exists in browser storage RIGHT NOW. Load-bearing
  // (2026-08-20): the login page's success path is router.replace() — a
  // client-side navigation with NO page reload — so a provider that mounted on
  // the signed-out login screen never remounts. Every token-gated effect below
  // that used to bail with a bare `return` therefore stayed dead until the
  // human manually reloaded the window ("I have to reload it a few times for
  // it to register"). This state flips the moment the token lands (same-window
  // sign-in via a cheap localStorage poll, cross-window via the storage event)
  // and re-runs those effects. It costs zero network while signed out.
  const [authTokenPresent, setAuthTokenPresent] = useState<boolean>(
    () => typeof window !== "undefined" && hasBrowserAuthToken(),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const check = () => setAuthTokenPresent(hasBrowserAuthToken());
    // storage fires only for OTHER windows' writes; the 2s poll covers a
    // sign-in completed in THIS window. React bails on same-value setState,
    // so the poll re-renders nothing while the flag is unchanged.
    window.addEventListener("storage", check);
    const timer = setInterval(check, 2_000);
    return () => { window.removeEventListener("storage", check); clearInterval(timer); };
  }, []);
  const [callState, setCallState] = useState<SipCallState>("idle");
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [callDirection, setCallDirection] = useState<"outbound" | "inbound" | null>(null);
  const [remoteParty, setRemoteParty] = useState<string | null>(null);
  const [remotePartyNumber, setRemotePartyNumber] = useState<string | null>(null);
  const [remotePartyName, setRemotePartyName] = useState<string | null>(null);
  const [remotePartyPrefix, setRemotePartyPrefix] = useState<string | null>(null);
  const { calls: enrichLiveCalls, status: liveFeedStatus } = useTelephonySocket();
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
  // ── Extra SIP accounts (multi-tenant "second lines") ──────────────────────
  // Everything below is additive: with zero extra accounts none of this runs
  // and the phone behaves exactly as before.
  const [sipAccounts, setSipAccounts] = useState<DialSipAccount[]>([]);
  const [accountRegStates, setAccountRegStates] = useState<Record<string, SipRegState>>({});
  /** Full registration configs for the extra accounts (includes ws/domain/ice). */
  const accountConfigsRef = useRef<SipAccountConfig[]>([]);
  /** Live JsSIP engines per extra account id. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const accountEnginesRef = useRef<Map<string, { ua: any; domain: string }>>(new Map());
  /** Ref mirror of accountRegStates for use inside dial() without stale closures. */
  const accountRegStatesRef = useRef<Record<string, SipRegState>>({});
  /** Which extra account each multi-call session belongs to (absent = primary). */
  const sessionAccountRef = useRef<Map<string, string>>(new Map());

  const {
    startUkLocalRingback,
    stopLocalRingback,
    resumeOutputAfterRingback,
    startRingtone,
    startCallWaitingAlert,
    stopCallWaitingAlert,
    playDtmfTone: playDtmfToneRaw,
    playCallEndChime,
    stopAll: stopAllAudio,
  } = useTelephonyAudio();

  // Keypad feedback plays on the CALL output device (the headset/speaker picked
  // in settings), not whatever sink the shared tone context last had — before
  // this it stayed on the OS default (or the ringer device) while the call
  // itself played on the headset (Izzy, 2026-08-27). currentSinkIdRef is
  // declared below; the callback only reads it at press time.
  const playDtmfTone = useCallback(
    (digit: string) => playDtmfToneRaw(digit, currentSinkIdRef.current),
    [playDtmfToneRaw],
  );

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
  // Mirror of currentSinkId (the call output / headset device) for use in the dial
  // callback, so the outbound ringback can play on the same device as the call.
  const currentSinkIdRef = useRef("");
  // The user's BASE call-output device (the headset / configured speaker). This is
  // what audio returns to when loudspeaker mode is turned off. Distinct from
  // `speakerOn`, which is a temporary "route to the computer's loudspeaker" override.
  const preferredSinkIdRef = useRef("");
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
    sessionAccountRef.current.delete(id);

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
  /** Blocks duplicate dial() until the outbound attempt ends (separate from answered-at). */
  const dialGuardRef = useRef<number | null>(null);
  /**
   * Max age of a dial guard that has no live session before it is treated as
   * stale and cleared. Covers the worst-case async dial setup window (outbound
   * route resolve + getUserMedia). Beyond this, a still-armed guard with no
   * session means a prior attempt leaked it, so we recover instead of wedging.
   */
  const STALE_DIAL_GUARD_MS = 12_000;
  /** True while UK local ringback synth is playing (outbound). */
  const localRingbackActiveRef = useRef(false);
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
  /** WebSocket keepalive interval — sends RFC5626 CRLF pings so an idle SIP/WSS
   *  socket on cellular/5G NAT never gets reaped (the root cause of registration flapping). */
  const keepAliveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Liveness watchdog interval — proactively detects a dead/closed socket or a
   *  dropped registration and triggers recovery instead of waiting for expiry. */
  const watchdogTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Epoch ms of the last inbound byte on the SIP socket — wire-truth liveness. */
  const lastInboundAtRef = useRef<number>(Date.now());
  /** Single-flight reconnect timer (backoff+jitter). */
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Consecutive reconnect attempts, for exponential backoff. Reset on register. */
  const reconnectAttemptRef = useRef<number>(0);
  /** Epoch ms the phone first went unregistered (null while registered). Drives the
   *  stuck-registration hard-recovery: gentle reconnect (ua.start) can leave a wedged
   *  JsSIP transport stuck yellow ("Connecting") forever — only a fresh UA recovers,
   *  which is why a page reload fixes it. When stuck past a threshold we rebuild the UA. */
  const unregisteredSinceRef = useRef<number | null>(null);
  /** Epoch ms of the last hard-reinit, to cap how often we rebuild the UA. */
  const lastHardReinitRef = useRef<number>(0);
  /** Cached softphone config + SIP secret, so rebuilding the UA costs ZERO API calls.
   *  Before this cache, every hard-reinit re-fetched both /voice/me/extension (60/hr
   *  limit) and /voice/me/reset-sip-password (30/hr limit). The watchdog rebuilds as
   *  often as every ~50 s (~72/hr), so a client on a flapping network reliably
   *  out-ran its own server budget and got itself 429'd — proven live on
   *  2026-08-10: 101 credential fetches from one desktop app, ending in a 429 at
   *  12:15:47Z, after which the dialer sat on "Connecting" until it was restarted.
   *  The secret does not rotate server-side (issueOneTimeProvisioningForUser returns
   *  the stored encrypted password), so re-fetching it per rebuild bought nothing.
   *  Invalidated on a 401/403 registration failure — the one case where the cached
   *  secret is genuinely the problem. */
  const sipCredsRef = useRef<{ ext: VoiceExtension; sipPassword: string; at: number } | null>(null);
  /** Pending init retry, so no failure path is a dead end and cleanup can cancel it. */
  const initRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Set by the active UA so network/visibility listeners can force a fast recovery. */
  const forceReconnectRef = useRef<(() => void) | null>(null);
  /** Timestamp when the local hangup was initiated (for the stale-report). */
  const hangupAtRef = useRef<string | null>(null);
  /** Guard: prevents duplicate CALL_QUALITY_REPORT when both user_hangup and the
   *  subsequent SIP "ended" event fire submitCallQualityReport for the same call. */
  const finalReportSentRef = useRef<boolean>(false);
  /** Set when local hangup() plays the end chime — skip duplicate on SIP "ended". */
  const userInitiatedHangupRef = useRef(false);
  /** Last LOCAL SDP offer for the active outbound session — read-only capture for
   *  the "488 / Incompatible SDP" WebRTC outbound investigation. Never munged. */
  const lastOfferSdpRef = useRef<string | null>(null);
  /** Structured per-call WebRTC debug record (gated by webrtcSdpDebugEnabled()).
   *  Captures the full outbound lifecycle so the failed offer + SIP status can be
   *  inspected without chrome://webrtc-internals. ICE creds are redacted. */
  const webrtcDebugRef = useRef<Record<string, unknown>>({});
  const blackboxRecorderRef = useRef<PortalWebrtcBlackboxRecorder | null>(null);

  function postWebrtcBlackbox(payload: Record<string, unknown>) {
    try {
      void apiPost("/voice/diag/webrtc-sdp-debug", payload).catch(() => undefined);
    } catch {
      /* never break call path */
    }
  }

  function beginOutboundBlackbox(targetRaw: string, sipTarget: string, route: string) {
    const rec = new PortalWebrtcBlackboxRecorder();
    rec.setDirection("outbound");
    rec.setClient({ userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null });
    rec.setIdentity({
      extensionNumber: diagRef.current.extensionNumber,
      sipUsername: diagRef.current.sipUsername,
      authUsername: diagRef.current.authUsername,
    });
    rec.setRegistration({
      registrationState: regState,
      registrationAgeMs: null,
      wssConnected: regState === "registered" || regState === "registering",
      uaStarted: !!uaRef.current,
    });
    rec.mark("call_initiated", { targetRaw, sipTarget, route });
    blackboxRecorderRef.current = rec;
    return rec;
  }

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

  /** Record a transport/registration lifecycle event into the rolling log
   *  (localStorage ring buffer + diag state for the diagnostics panel). */
  function logConn(type: ConnectionEvent["type"], code?: number, reason?: string) {
    const events = appendConnLog({ at: Date.now(), type, code, reason });
    patchDiag({ connectionEvents: events });
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
      const lossPct =
        s.packetsLost != null && s.packetsReceived != null && s.packetsReceived > 0
          ? Math.round((s.packetsLost / (s.packetsLost + s.packetsReceived)) * 1000) / 10
          : null;

      const newSample: RawStatSample = {
        ts: now,
        packetsLost: s.packetsLost,
        packetsReceived: s.packetsReceived,
        packetsSent: s.packetsSent,
        jitterMs: s.jitterMs,
        rttMs: s.rttMs,
        jitterBufferMs: s.jitterBufferMs,
        bytesReceived: s.bytesReceived,
        bytesSent: s.bytesSent,
        bitrateKbps,
        audioLevel: s.audioLevel,
        candidateType: s.selectedCandidateType,
        qualityGrade: grade,
      };

      const livePayload = {
        at: new Date(now).toISOString(),
        grade,
        rttMs: s.rttMs,
        jitterMs: s.jitterMs,
        jitterBufferMs: s.jitterBufferMs,
        lossPct,
        packetsLost: s.packetsLost,
        packetsReceived: s.packetsReceived,
        bitrateKbps,
        codec: s.audioCodec,
        candidateType: s.selectedCandidateType,
        relay: s.selectedCandidateType === "relay",
      };
      console.log("[SipPhone] live_stats", JSON.stringify(livePayload));
      if (typeof window !== "undefined") {
        (window as unknown as { __CONNECT_CALL_DIAG__?: unknown }).__CONNECT_CALL_DIAG__ = livePayload;
      }

      patchDiag((prev) => ({
        ...prev,
        packetsLost: s.packetsLost,
        packetsSent: s.packetsSent,
        jitterMs: s.jitterMs,
        jitterBufferMs: s.jitterBufferMs,
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
    // Signed out (login page, public pay page): a guaranteed 401 — seen live as
    // the ONE stray `/api/me/outbound-routes → 401` on every /login load.
    if (!hasBrowserAuthToken()) return;
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
    // authTokenPresent: a client-side sign-in (router.replace, no reload) must
    // re-run this — the signed-out mount bailed above and nothing else retries.
  }, [authTokenPresent]);

  useEffect(() => {
    if (callState === "idle" || callState === "ended") setSelectedOutboundRouteId("");
  }, [callState]);

  // ── Extra SIP accounts: fetch the list ────────────────────────────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    function fetchAccounts(attempt: number) {
      apiGet<{ accounts: SipAccountConfig[] }>("/voice/me/sip-accounts")
        .then((res) => {
          if (cancelled) return;
          const accounts = (res.accounts || []).filter((a) => a && a.id);
          accountConfigsRef.current = accounts;
          setSipAccounts(
            accounts.map((a) => ({
              id: a.id,
              tenantId: a.tenantId,
              tenantName: a.tenantName ?? null,
              label: a.label || a.tenantName || "Second line",
              extensionNumber: a.extensionNumber ?? null,
              ready: !!a.ready,
              routes: (a.routes || []).filter((r) => r && r.id),
            })),
          );
        })
        .catch((e: unknown) => {
          // 401 = auth token not ready yet (startup race) — retry once shortly.
          if (!cancelled && e instanceof ApiError && e.status === 401 && attempt < 2) {
            setTimeout(() => { if (!cancelled) fetchAccounts(attempt + 1); }, 2_500);
          }
          // Any other failure: no extra accounts — the phone works exactly as before.
        });
    }
    // Same rule as init() below: signed out (login page, public pages, a
    // session the api just refused) means every call here is a guaranteed 401.
    if (hasBrowserAuthToken()) fetchAccounts(0);
    return () => { cancelled = true; };
    // authTokenPresent: re-run after a client-side sign-in (no page reload).
  }, [authTokenPresent]);

  // ── Extra SIP accounts: registration engines ──────────────────────────────
  // One additional JsSIP UA per READY account. Deliberately simpler than the
  // primary engine (JsSIP's built-in connection recovery + a light watchdog);
  // the primary line's engine is untouched. Inbound calls on these accounts
  // flow into the SAME session bookkeeping/UI as primary-line calls.
  const sipAccountsEngineKey = useMemo(
    () => sipAccounts.filter((a) => a.ready).map((a) => a.id).join(","),
    [sipAccounts],
  );
  useEffect(() => {
    if (typeof window === "undefined" || !sipAccountsEngineKey) return;
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const setAccountReg = (id: string, rs: SipRegState) => {
      accountRegStatesRef.current = { ...accountRegStatesRef.current, [id]: rs };
      setAccountRegStates(accountRegStatesRef.current);
    };

    async function startAccountEngine(cfg: SipAccountConfig) {
      try {
        if (!cfg.sipWsUrl || !cfg.sipDomain || !cfg.sipUsername) return;
        setAccountReg(cfg.id, "connecting");
        const creds = await apiPost<{ sipPassword: string }>(
          `/voice/me/sip-accounts/${cfg.id}/reset-sip-password`,
        );
        if (cancelled) return;
        const sipPassword = creds?.sipPassword || "";
        if (!sipPassword) {
          setAccountReg(cfg.id, "failed");
          return;
        }
        const JsSIP = await loadJsSIP();
        if (cancelled) return;

        const socket = new JsSIP.WebSocketInterface(cfg.sipWsUrl);
        const uaConfig: Record<string, unknown> = {
          sockets: [socket],
          uri: `sip:${cfg.sipUsername}@${cfg.sipDomain}`,
          password: sipPassword,
          authorization_user: cfg.authUsername || cfg.sipUsername,
          display_name: cfg.label || cfg.sipUsername,
          register: true,
          register_expires: 120,
          connection_recovery_min_interval: 2,
          connection_recovery_max_interval: 15,
          session_timers: false,
          pcConfig: {
            iceServers: cfg.iceServers?.length
              ? cfg.iceServers
              : [{ urls: "stun:stun.l.google.com:19302" }],
            iceTransportPolicy: (process.env.NEXT_PUBLIC_FORCE_ICE_RELAY === "true" ? "relay" : "all") as RTCIceTransportPolicy,
          },
        };
        if (cfg.outboundProxy) uaConfig.outbound_proxy_set = cfg.outboundProxy;

        const ua = new JsSIP.UA(uaConfig);
        accountEnginesRef.current.set(cfg.id, { ua, domain: cfg.sipDomain });

        // RFC5626 CRLF keepalive — same NAT-warming as the primary line.
        const keepAlive = setInterval(() => {
          try {
            if (!cancelled && ua.isConnected?.()) socket.send("\r\n\r\n");
          } catch { /* ignore */ }
        }, 15_000);
        // Light watchdog: JsSIP's own connection recovery does the heavy
        // lifting; this just nudges a silently-lapsed registration.
        const watchdog = setInterval(() => {
          if (cancelled) return;
          try {
            if (ua.isConnected?.() && !ua.isRegistered?.()) ua.register();
          } catch { /* ignore */ }
        }, 30_000);

        ua.on("connecting", () => { if (!cancelled) setAccountReg(cfg.id, "connecting"); });
        ua.on("connected", () => { if (!cancelled) setAccountReg(cfg.id, "registering"); });
        ua.on("registered", () => {
          if (!cancelled) {
            setAccountReg(cfg.id, "registered");
            console.log(`[SipPhone] account_registered account=${cfg.id} label=${cfg.label}`);
          }
        });
        ua.on("unregistered", () => { if (!cancelled) setAccountReg(cfg.id, "registering"); });
        ua.on("registrationFailed", (e: { cause?: string }) => {
          if (!cancelled) {
            setAccountReg(cfg.id, "failed");
            console.warn(`[SipPhone] account_registration_failed account=${cfg.id} cause=${e?.cause ?? "?"}`);
          }
        });
        ua.on("disconnected", () => { if (!cancelled) setAccountReg(cfg.id, "connecting"); });

        ua.on(
          "newRTCSession",
          (data: {
            originator: string;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: any;
            request: { from: { uri: { user: string }; display_name?: string } };
          }) => {
            if (cancelled) return;
            if (data.session.connection) {
              wirePC(data.session.connection);
            } else {
              data.session.on("peerconnection", (pcData: { peerconnection: RTCPeerConnection }) => {
                wirePC(pcData.peerconnection);
              });
            }
            const mcId = getOrAssignSessionId(data.session);
            const activeCount = sessionsByIdRef.current.size;
            if (activeCount >= MAX_CONCURRENT_SESSIONS_WEB && data.originator === "remote") {
              try {
                data.session.terminate({ status_code: 486, reason_phrase: "Busy Here" });
              } catch { /* ignore */ }
              return;
            }
            sessionsByIdRef.current.set(mcId, data.session);
            sessionAccountRef.current.set(mcId, cfg.id);

            if (data.originator === "remote") {
              const rawParty = data.request.from.display_name || data.request.from.uri.user;
              const party = splitRingGroupPrefix(rawParty).rest || rawParty;
              // Remember which line this caller reached us on, so calling them
              // back automatically goes out from the same SIP account.
              rememberInboundAccount(data.request.from.uri.user || party, cfg.id);
              console.log(`[MULTICALL] web incoming(account=${cfg.id}) call=${mcId} from=${party}`);
              registerSessionMeta(mcId, {
                remoteParty: party,
                direction: "inbound",
                state: "ringing",
                onHold: false,
                isActive: false,
              });
              if (!sessionRef.current || sessionRef.current.isEnded?.()) {
                callDirectionRef.current = "inbound";
                setCallDirection("inbound");
                setOnHold(false);
                bindSession(data.session, party);
                setCallState("ringing");
                setRemoteParty(party);
                startRingtone();
              } else {
                // Call waiting: a quiet repeating beep, never the full ringtone —
                // the person is mid-conversation (mirrors the mobile app).
                bindSideSession(data.session, party, mcId);
                startCallWaitingAlert();
              }
            } else {
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
        cleanups.push(() => {
          clearInterval(keepAlive);
          clearInterval(watchdog);
          try { ua.stop(); } catch { /* ignore */ }
        });
      } catch (e) {
        console.warn(`[SipPhone] account_engine_start_failed account=${cfg.id}:`, e);
        if (!cancelled) setAccountReg(cfg.id, "failed");
      }
    }

    for (const cfg of accountConfigsRef.current.filter((a) => a.ready)) {
      void startAccountEngine(cfg);
    }

    return () => {
      cancelled = true;
      for (const stop of cleanups) {
        try { stop(); } catch { /* ignore */ }
      }
      accountEnginesRef.current.clear();
    };
    // Keyed on the READY account-id set only — rebuilds when accounts change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sipAccountsEngineKey]);

  // ── Initialise ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    // 401 retry backoff: starts at the historical 2.5s (auth-token startup
    // race) but doubles up to a minute — the fixed 2.5s loop turned any tab
    // with a dead token into a 401 firehose that tripped the nginx auto-ban.
    let authRetryDelayMs = 2_500;
    // Backoff for EVERY other setup failure. Before this, each `return` below was a
    // dead end: the engine set an error string and stopped, with no UA, no watchdog
    // and no timer alive — so the dialer kept showing whatever it last said
    // ("Connecting", amber) forever and only restarting the app recovered it. The
    // watchdog cannot help, because the watchdog lives inside the UA that was never
    // built. Capped at 60 s: one request a minute is far under the nginx auto-ban
    // threshold and self-heals the moment the cause clears.
    let initRetryDelayMs = 5_000;
    // Setup-class failures (PBX_NOT_LINKED, EXTENSION_NOT_ASSIGNED/NOT_PROVISIONED,
    // FORBIDDEN, WebRTC disabled, missing wsUrl/domain/username) are things only an
    // administrator can fix — nothing this client does will change the answer. They
    // get their own MUCH slower recheck ladder. This is load-bearing, measured live
    // 2026-08-20: the old fixed 60s loop, times one loop per open window (the desktop
    // app runs more than one), consumed the ENTIRE per-user /voice/me/extension budget
    // (60/hour) — so the one window that COULD register drew 429 on its first load and
    // the customer had to "reload a few times for it to register". A slow recheck still
    // brings the phone to life on its own once an admin fixes the setting.
    let setupRetryDelayMs = 60_000;
    const SETUP_RETRY_MAX_MS = 15 * 60_000;
    const scheduleInitRetry = (why: string, opts?: { setupClass?: boolean }) => {
      if (cancelled) return;
      let delay: number;
      if (opts?.setupClass) {
        delay = setupRetryDelayMs;
        setupRetryDelayMs = Math.min(SETUP_RETRY_MAX_MS, setupRetryDelayMs * 2);
      } else {
        delay = initRetryDelayMs;
        initRetryDelayMs = Math.min(60_000, Math.round(initRetryDelayMs * 1.8));
      }
      // ±15% jitter: several windows of the same login share one server-side budget,
      // and without jitter their retry ladders march in lockstep against it.
      delay = Math.round(delay * (0.85 + Math.random() * 0.3));
      logConn("init-failed", undefined, `${why} — retrying in ${Math.round(delay / 1000)}s`);
      if (initRetryTimerRef.current) clearTimeout(initRetryTimerRef.current);
      initRetryTimerRef.current = setTimeout(() => {
        initRetryTimerRef.current = null;
        if (cancelled) return;
        try { init(); } catch { /* ignore — the next failure reschedules */ }
      }, delay);
    };
    // 400/403/404 from the credential endpoints = the account is not set up for a
    // softphone; 401 (token race) and 429 (budget) are transient and stay on the
    // fast ladder. Anything non-HTTP (network) is transient too.
    const isSetupClassError = (e: unknown): boolean =>
      e instanceof ApiError && (e.status === 400 || e.status === 403 || e.status === 404);

    async function init() {
      // Signed out (public wizard, pay page, login screen): the phone engine
      // has nobody to register. Do not call authenticated endpoints at all —
      // those guaranteed 401s are what got a customer's office IP auto-banned
      // mid-sign-up. A sign-in re-runs this effect via authTokenPresent (the
      // login page uses router.replace, so there is NO page reload to rely on).
      if (!hasBrowserAuthToken()) return;

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
        // 401 means the auth token wasn't ready yet (race condition on startup)
        // — or is dead. Retry silently, but back off: a fixed short loop here
        // once produced 401s every 2.5s from parked tabs, tripping the ban.
        if (e instanceof ApiError && e.status === 401) {
          const delay = authRetryDelayMs;
          authRetryDelayMs = Math.min(60_000, authRetryDelayMs * 2);
          setTimeout(() => {
            if (cancelled) return;
            try { init(); } catch { /* ignore */ }
          }, delay);
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
        setRegState("failed");
        setError(msg);
        patchDiag({
          webrtcEnabled: false,
          lastRegError: msg,
          ...(extNum ? { extensionNumber: extNum } : {}),
        });
        // A 429 here is self-inflicted (we asked too often) — wait out the window
        // rather than adding to it.
        if (e instanceof ApiError && e.status === 429) initRetryDelayMs = 60_000;
        scheduleInitRetry("extension-fetch", { setupClass: isSetupClassError(e) });
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
        authUsername: ext.authUsername ?? ext.sipUsername,
        hasTurn: hasTurnServer(ext.iceServers),
        hasStun: hasStunServer(ext.iceServers),
        webrtcEnabled: ext.webrtcEnabled,
        sipWssConfigured: !!sipWssUrl,
        sipDomainConfigured: !!sipDomain,
      });

      // Admin-configuration gaps. These are not transient, but they DO get fixed by
      // an administrator while the app is open — so show the truth ("Not registered",
      // not a permanent amber "Connecting") and keep re-checking slowly so the phone
      // comes to life on its own once the setting lands.
      const configProblem =
        !ext.webrtcEnabled
          ? "WEBRTC_DISABLED — An administrator must enable WebRTC for this tenant. Go to PBX → Extensions → WebRTC Settings."
          : !sipWssUrl
            ? "SIP WSS URL is not configured. Set sipWsUrl in Voice → Settings → WebRTC."
            : !sipDomain
              ? "SIP Domain is not configured. Set sipDomain in Voice → Settings → WebRTC."
              : !ext.sipUsername
                ? "No SIP username assigned. Contact your administrator."
                : null;
      if (configProblem) {
        setRegState("failed");
        setError(configProblem);
        patchDiag({ lastRegError: configProblem });
        scheduleInitRetry("config", { setupClass: true }); // only an admin fixes it — check gently
        return;
      }

      if (!hasTurnServer(ext.iceServers)) {
        console.warn("[SipPhone] No TURN server in ICE config — audio may fail behind strict NAT.");
      }

      let sipPassword: string;
      const cachedCreds = sipCredsRef.current;
      if (cachedCreds && cachedCreds.ext.sipUsername === ext.sipUsername && cachedCreds.sipPassword) {
        // Rebuild the UA on the secret we already hold. See sipCredsRef.
        sipPassword = cachedCreds.sipPassword;
      } else {
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
                ? "Reconnecting — the phone asked for its credentials too often. Retrying automatically."
                : `Failed to fetch SIP credentials: ${raw}. Retrying automatically.`;
          setRegState("failed");
          setError(msg);
          patchDiag({ lastRegError: msg, ...(extNum ? { extensionNumber: extNum } : {}) });
          // 429 = we out-ran our own per-hour budget. Waiting is the ONLY cure, and
          // it used to be left to the human ("Reload the page to retry"), which is how
          // the dialer ended up parked on "Connecting" for hours.
          if ((e instanceof ApiError && e.status === 429) || raw.includes("RATE_LIMITED")) {
            initRetryDelayMs = 60_000;
          }
          scheduleInitRetry("credential-fetch", { setupClass: isSetupClassError(e) });
          return;
        }
      }

      if (cancelled) return;
      if (!sipPassword) {
        const msg = "SIP_CREDENTIAL_NOT_SET — An administrator must set the SIP password for this extension.";
        setRegState("failed");
        setError(msg);
        patchDiag({ lastRegError: msg });
        sipCredsRef.current = null;
        scheduleInitRetry("empty-credential", { setupClass: true }); // admin must set the password
        return;
      }
      sipCredsRef.current = { ext, sipPassword, at: Date.now() };
      initRetryDelayMs = 5_000; // setup got this far — reset both backoff ladders
      setupRetryDelayMs = 60_000;

      try {
        const JsSIP = await loadJsSIP();
        if (cancelled) return;

        setRegState("connecting");
        const socket = new JsSIP.WebSocketInterface(sipWssUrl);

        // ── Wire-truth liveness ────────────────────────────────────────────
        // The PBX qualifies this contact every 30 s (OPTIONS over this socket),
        // so a healthy socket ALWAYS delivers inbound data at least that often.
        // A NAT/WAN flip (dual-WAN failover, CGNAT rebind, VPN path change)
        // strands the socket half-open: the local WebSocket object still says
        // OPEN and outbound sends "succeed" into the void, so isConnected()/
        // isRegistered() keep lying for many minutes (2026-07-29 incident: the
        // PBX marked the contact Unreachable within 33 s of each silent death
        // while this client believed it was registered for up to ~9 more
        // minutes — six abandoned half-open sockets piled up server-side).
        // Ground truth is inbound bytes: stamp every frame JsSIP receives by
        // wrapping the transport's ondata assignment; the watchdog below treats
        // prolonged inbound silence as a dead socket regardless of what the
        // socket object claims.
        lastInboundAtRef.current = Date.now();
        {
          let realOndata: ((...args: unknown[]) => void) | undefined;
          Object.defineProperty(socket, "ondata", {
            configurable: true,
            get: () => realOndata,
            set: (fn: unknown) => {
              realOndata =
                typeof fn === "function"
                  ? (...args: unknown[]) => {
                      lastInboundAtRef.current = Date.now();
                      (fn as (...a: unknown[]) => void)(...args);
                    }
                  : (fn as undefined);
            },
          });
        }

        const uaConfig: Record<string, unknown> = {
          sockets: [socket],
          uri: `sip:${ext.sipUsername}@${sipDomain}`,
          password: sipPassword,
          authorization_user: ext.authUsername || ext.sipUsername,
          display_name: ext.displayName || ext.sipUsername,
          register: true,
          // Shorter expiry is a secondary safety net on top of the CRLF keepalive:
          // a dead contact self-expires fast and the periodic REGISTER refresh adds
          // a second stream of keepalive traffic. JsSIP refreshes well before expiry;
          // Asterisk's minimum-expiration (423) is handled transparently by JsSIP.
          register_expires: 120,
          // Bound JsSIP's built-in transport auto-recovery so a dropped WS reconnects
          // quickly (cellular/5G handoff) without hammering the PBX.
          connection_recovery_min_interval: 2,
          connection_recovery_max_interval: 15,
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

        // A fresh UA may be created by a re-init; clear any timers from a prior one.
        if (keepAliveTimerRef.current) { clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null; }
        if (watchdogTimerRef.current) { clearInterval(watchdogTimerRef.current); watchdogTimerRef.current = null; }
        if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }

        const RECONNECT_BASE_MS = 1_000;
        const RECONNECT_MAX_MS = 15_000;
        // Single-flight reconnect with capped exponential backoff + jitter. Cooperates
        // with JsSIP's own transport recovery (the ref guard prevents stacked starts).
        const queueReconnect = (immediate = false) => {
          if (reconnectTimerRef.current) return;
          if (cancelled || uaRef.current !== ua) return;
          const attempt = reconnectAttemptRef.current;
          const backoff = immediate
            ? 0
            : Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
          const jitter = backoff > 0 ? Math.floor(Math.random() * 500) : 0;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            if (cancelled || uaRef.current !== ua) return;
            reconnectAttemptRef.current = Math.min(attempt + 1, 6);
            try {
              setRegState("connecting");
              logConn("reconnect");
              ua.start();
            } catch (err) {
              console.warn("[SipPhone] reconnect start failed", err);
              queueReconnect();
            }
          }, backoff + jitter);
        };

        // RFC 5626 double-CRLF keepalive over the WSS socket. Keeps the NAT/proxy
        // path warm from the client side so an idle softphone never gets reaped —
        // independent of whether Asterisk qualifies the contact server-side.
        // 15s holds open consumer-router / CGNAT bindings that rotate aggressively
        // (the failure mode seen on Rob Jacobs' T30_103_1: WiFi behind a
        // rebinding NAT). Pairs with the server qualify_frequency=30.
        const sendKeepAlive = () => {
          try {
            if (uaRef.current === ua && ua.isConnected?.()) {
              socket.send("\r\n\r\n");
            }
          } catch (err) {
            // A failed send is a dead socket the transport hasn't admitted yet —
            // don't just log it, start recovery now.
            console.warn("[SipPhone] keepalive send failed", err);
            queueReconnect();
          }
        };
        keepAliveTimerRef.current = setInterval(sendKeepAlive, 15_000);

        // Proactive liveness watchdog: if the socket is dead, kick a reconnect;
        // if the socket is open but registration lapsed, refresh it. And, as a last
        // resort, if the phone stays unregistered for too long (a wedged JsSIP
        // transport that ua.start()/register() won't revive), rebuild the whole UA —
        // the same recovery a page reload performs, but automatic.
        const STUCK_REINIT_MS = 20_000; // unregistered this long → rebuild the UA
        const REINIT_COOLDOWN_MS = 45_000; // never rebuild more often than this
        // No inbound bytes for this long ⇒ the socket is dead on the wire, no
        // matter what it claims. PBX qualify interval is 30 s (plus our CRLF
        // keepalives are answered), so 75 s = two missed qualifies + margin.
        const SOCKET_SILENCE_DEAD_MS = 75_000;
        const runWatchdog = () => {
          if (cancelled || uaRef.current !== ua) return;
          const connected = !!ua.isConnected?.();
          const registered = !!ua.isRegistered?.();
          // Wire truth FIRST — before trusting isRegistered(). A half-open
          // socket keeps both isConnected() and isRegistered() true for many
          // minutes while inbound has been silent since the path died.
          if (connected && Date.now() - lastInboundAtRef.current >= SOCKET_SILENCE_DEAD_MS) {
            logConn("stale-socket");
            lastInboundAtRef.current = Date.now(); // re-arm so we don't re-trip while reconnecting
            try {
              socket.disconnect(); // surfaces a real 'disconnected' → error path + UI
            } catch {
              /* ignore — reconnect below still runs */
            }
            queueReconnect(true);
            return;
          }
          if (registered) {
            unregisteredSinceRef.current = null;
            return;
          }
          // Not registered — note when it started and try the gentle recovery first.
          if (unregisteredSinceRef.current == null) unregisteredSinceRef.current = Date.now();
          if (!connected) {
            queueReconnect();
          } else {
            try { ua.register(); } catch { /* ignore */ }
          }
          const stuckMs = Date.now() - unregisteredSinceRef.current;
          const sinceReinit = Date.now() - lastHardReinitRef.current;
          if (stuckMs >= STUCK_REINIT_MS && sinceReinit >= REINIT_COOLDOWN_MS) {
            lastHardReinitRef.current = Date.now();
            unregisteredSinceRef.current = null;
            logConn("hard-reinit");
            setReinitSeq((s) => s + 1); // tears down this UA and rebuilds a fresh one
          }
        };
        watchdogTimerRef.current = setInterval(runWatchdog, 10_000);

        // Exposed to the window 'online' / 'visibilitychange' listeners so a
        // regained network or a woken tab recovers immediately (handles 5G dynamic
        // IP handoffs and laptop sleep) rather than waiting for the next backoff.
        forceReconnectRef.current = () => {
          if (cancelled || uaRef.current !== ua) return;
          reconnectAttemptRef.current = 0;
          if (!ua.isConnected?.()) {
            queueReconnect(true);
          } else if (!ua.isRegistered?.()) {
            try { ua.register(); } catch { /* ignore */ }
          } else {
            sendKeepAlive();
          }
        };

        ua.on("connecting", () => { if (!cancelled) { setRegState("connecting"); logConn("connecting"); } });
        ua.on("connected",  () => { if (!cancelled) { lastInboundAtRef.current = Date.now(); setRegState("registering"); logConn("connected"); } });

        // JsSIP emits `disconnected` with the underlying WebSocket close code /
        // reason. Capturing it is the whole point of the telemetry: 1006 =
        // abnormal/network drop (NAT rebind, ISP path change), 1001 = going away
        // (tab hidden / navigated), 1000 = clean. This tells us *why* the socket
        // dies on the affected machine without guessing.
        ua.on(
          "disconnected",
          (e?: { code?: number; reason?: string; error?: boolean }) => {
            if (!cancelled) {
              setRegState("failed");
              logConn("disconnected", e?.code, e?.reason);
              const detail = e?.code != null ? ` (code ${e.code}${e.reason ? `: ${e.reason}` : ""})` : "";
              const msg = `SIP WebSocket disconnected${detail}. Reconnecting…`;
              setError(msg);
              patchDiag({ lastRegError: msg });
              queueReconnect();
            }
          },
        );

        ua.on("registered", () => {
          if (!cancelled) {
            regFailCount = 0;
            reconnectAttemptRef.current = 0;
            unregisteredSinceRef.current = null;
            setRegState("registered");
            setError(null);
            logConn("registered");
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
          logConn("unregistered");
          queueReconnect();
        });

        ua.on("registrationFailed", (e: { cause: string; response?: { status_code?: number } }) => {
          logConn("registrationFailed", e?.response?.status_code, e?.cause);
          if (!cancelled) {
            regFailCount += 1;
            const code = e.response?.status_code;
            const msg = code
              ? `SIP registration failed (${code}): ${e.cause}. ${code === 401 || code === 403 ? "Check SIP credentials." : "Check PBX configuration."}`
              : `SIP registration failed: ${e.cause}`;
            setRegState("failed");
            setError(msg);
            patchDiag({ lastRegError: msg });
            // The ONE case where the cached secret is the actual problem: the PBX
            // rejected it. Drop the cache so the next rebuild fetches a fresh one.
            if (code === 401 || code === 403) sipCredsRef.current = null;
            // Keep retrying in desktop so users do not get stuck on Offline after reload.
            if (regFailCount >= 3) {
              setError(`SIP registration failed: ${e.cause}. Reconnecting...`);
              queueReconnect();
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
            // Do Not Disturb: silence THIS device only. We deliberately do NOT
            // reject the INVITE — a 486 could end the call for the whole
            // extension. This leg just never rings or shows UI; the PBX keeps
            // ringing hard phones / other registrations, and this leg drops on
            // its own when the call is answered elsewhere or the caller gives up.
            if (data.originator === "remote" && isDndEnabled()) {
              console.log(`[SIP] DND on — silencing inbound ${mcId} on this device only (no reject)`);
              return;
            }
            sessionsByIdRef.current.set(mcId, data.session);

            if (data.originator === "remote") {
              // Strip the VitalPBX ring-group prefix the SIP From display-name
              // carries (e.g. "Estimates:Estimates:Caller") so the softphone shows
              // a clean caller; the prefix is surfaced as a tag from the matched
              // live call's fromPrefix instead.
              const reqAny = data.request as unknown as { getHeader?: (n: string) => string | undefined };
              const headerParty = (() => {
                try {
                  const raw = reqAny.getHeader?.("P-Asserted-Identity") || reqAny.getHeader?.("Remote-Party-ID") || "";
                  const uriUser = /sip:([^@;>]+)@/i.exec(raw);
                  if (uriUser && uriUser[1]) return uriUser[1];
                  const num = /(\+?\d{4,})/.exec(raw);
                  return num && num[1] ? num[1] : "";
                } catch { return ""; }
              })();
              const rawParty = data.request.from.display_name || data.request.from.uri.user || headerParty;
              try { console.log("[SIP] INCOMING caller-id diag " + JSON.stringify({ fromDisplay: data.request.from.display_name || null, fromUser: data.request.from.uri.user || null, headerParty: headerParty || null })); } catch { /* ignore */ }
              const party = splitRingGroupPrefix(rawParty).rest || rawParty;
              // Inbound on the PRIMARY line: forget any "call back on account X"
              // memory for this caller — the latest call wins.
              rememberInboundAccount(data.request.from.uri.user || party, null);
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
                setRemotePartyNumber((data.request.from.uri.user || headerParty || "").trim() || null);
                console.log("[SIP] INCOMING_CALL from:", party);
                startRingtone();
              } else {
                // Call-waiting path — do NOT hijack the primary callState UI.
                // Bind lightweight per-session listeners so multi-call meta is
                // accurate; the softphone's MultiCallPanel renders the banner.
                // Audio is a quiet repeating BEEP, never the full ringtone —
                // the person is mid-conversation (mirrors the mobile app's
                // startCallWaitingAlert; Trust Bookkeepings complaint 2026-08-20).
                bindSideSession(data.session, party, mcId);
                console.log(`[MULTICALL] web call_waiting incoming=${mcId} while active=${activeSessionIdRef.current}`);
                startCallWaitingAlert();
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
        scheduleInitRetry("ua-init");
      }
    }

    init();

    // Surface any persisted connection history (previous sessions / reloads) in
    // the diagnostics panel immediately.
    patchDiag({ connectionEvents: readConnLog() });

    // Network/visibility-aware recovery: a regained connection or a tab becoming
    // visible again (laptop wake, cellular/5G handoff with a new source IP) kicks
    // the SIP transport back to life immediately instead of waiting for backoff.
    const handleOnline = () => { logConn("online"); forceReconnectRef.current?.(); };
    const handleOffline = () => { logConn("offline"); };
    const handleVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        logConn("visible");
        forceReconnectRef.current?.();
      }
    };
    // Network Information API: fires when the active connection changes (Wi-Fi ⇄
    // ethernet, interface switch, or a NAT-rotating link reporting a new type).
    // This catches path changes the OS knows about *before* the WS even errors,
    // so we re-register proactively on flaky / rebinding networks like Rob's.
    const conn: { addEventListener?: (t: string, cb: () => void) => void; removeEventListener?: (t: string, cb: () => void) => void } | undefined =
      typeof navigator !== "undefined"
        ? (navigator as unknown as { connection?: typeof conn }).connection
        : undefined;
    const handleNetChange = () => { logConn("netchange"); forceReconnectRef.current?.(); };
    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
    }
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", handleVisible);
    conn?.addEventListener?.("change", handleNetChange);

    return () => {
      cancelled = true;
      stopStatsPolling();
      stopLocalStream();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      }
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", handleVisible);
      conn?.removeEventListener?.("change", handleNetChange);
      if (keepAliveTimerRef.current) { clearInterval(keepAliveTimerRef.current); keepAliveTimerRef.current = null; }
      if (watchdogTimerRef.current) { clearInterval(watchdogTimerRef.current); watchdogTimerRef.current = null; }
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      if (initRetryTimerRef.current) { clearTimeout(initRetryTimerRef.current); initRetryTimerRef.current = null; }
      forceReconnectRef.current = null;
      if (staleHangupTimerRef.current) { clearTimeout(staleHangupTimerRef.current); staleHangupTimerRef.current = null; }
      // A UA rebuilt mid-ring orphans the ringtone: the dead UA's sessions never
      // fire ended/failed (the transport is gone), so nothing downstream will
      // ever call stopAllAudio(). Stop it here — a legitimate ring on the NEW
      // UA restarts it via its own newRTCSession.
      stopAllAudio();
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
    // Re-runs (tearing down + rebuilding the SIP engine) whenever reinitSeq bumps —
    // the auto-recovery for a wedged registration — and when a session token
    // appears or disappears: the login page signs in via router.replace (no page
    // reload), so without authTokenPresent here the engine that mounted on the
    // signed-out login screen stayed dead until a manual reload. Sign-OUT
    // (token gone) tears the UA down through the same cleanup, which is correct.
    // Other inputs are read via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reinitSeq, authTokenPresent]);

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
      jitterBufferMs: null,
      rttMs: null,
      localRingback: "off",
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

  function stopOutboundRingbackImmediate(reason: string) {
    if (!localRingbackActiveRef.current) return;
    stopLocalRingback();
    localRingbackActiveRef.current = false;
    resumeOutputAfterRingback();
    patchDiag({ localRingback: "off" });
    console.log("[SipPhone] local_ringback_stopped reason=" + reason);
  }

  function attachRemoteStream(stream: MediaStream) {
    const el = audioRef.current;
    if (!el) {
      console.warn("[SipPhone] audioRef missing — cannot play remote audio");
      return;
    }
    resumeOutputAfterRingback();
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
      const preAnswerOutbound =
        callDirectionRef.current === "outbound" && !callStartedAtRef.current;
      console.log(
        "[SipPhone] remote_track_received id="
          + e.track.id
          + " state="
          + e.track.readyState
          + " pre_answer="
          + preAnswerOutbound,
      );
      if (preAnswerOutbound && localRingbackActiveRef.current) {
        // PBX early media with ringback — hand off from UK synth to carrier audio.
        stopLocalRingback();
        localRingbackActiveRef.current = false;
        resumeOutputAfterRingback();
        console.log("[SipPhone] local_ringback_stopped reason=early_media");
        patchDiag({ localRingback: "remote" });
        attachRemoteStream(stream);
      } else if (!preAnswerOutbound) {
        attachRemoteStream(stream);
      } else {
        console.log("[SipPhone] remote_track_ignored_pre_answer (keep UK ringback)");
      }

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
        // ICE often connects before 200 OK while UK ringback should continue.
        const answered = callStartedAtRef.current !== null;
        if (answered) {
          if (localRingbackActiveRef.current) {
            stopOutboundRingbackImmediate("ice_connected");
          }
          setCallState((prev) => (prev === "ringing" || prev === "dialing") ? "connected" : prev);
          syncReceiversToAudio(pc);
        } else {
          console.log("[SipPhone] ICE_CONNECTED pre_answer — keep UK ringback, defer remote audio");
        }
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
            "[SipPhone] ICE_FAILED — attempting ICE restart via SIP re-INVITE " +
            iceRestartAttemptsRef.current + "/" + MAX_ICE_RESTARTS,
          );
          patchDiag({ lastCallError: `ICE failed — auto-restarting audio (attempt ${iceRestartAttemptsRef.current}/${MAX_ICE_RESTARTS})…` });
          try {
            // renegotiate() sends a SIP re-INVITE with a new SDP offer that has
            // iceRestart:true — this exchanges new ICE ufrag/pwd with the PBX so
            // connectivity checks use fresh credentials. Calling pc.restartIce()
            // alone is insufficient because it only marks the PC locally; the PBX
            // never learns the new credentials without the re-INVITE.
            sessionRef.current.renegotiate({ iceRestart: true });
            console.log("[SipPhone] ICE restart re-INVITE sent");
          } catch (e) {
            console.warn("[SipPhone] ICE restart renegotiate failed", e);
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
          const sess = sessionRef.current;
          if (pc.iceConnectionState === "disconnected" && sess?.connection === pc) {
            const MAX_ICE_RESTARTS = 2;
            if (iceRestartAttemptsRef.current < MAX_ICE_RESTARTS) {
              iceRestartAttemptsRef.current += 1;
              console.warn("[SipPhone] ICE still disconnected after 4s — sending SIP re-INVITE for ICE restart " + iceRestartAttemptsRef.current);
              patchDiag({ lastCallError: `Network issue — restarting audio connection (attempt ${iceRestartAttemptsRef.current})…` });
              try {
                // Must use renegotiate() to send a SIP re-INVITE — pc.restartIce()
                // alone only refreshes credentials locally; the PBX never learns
                // the new ICE ufrag/pwd and connectivity checks fail.
                sess.renegotiate({ iceRestart: true });
              } catch (e) { console.warn("[SipPhone] ICE restart renegotiate() failed", e); }
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
      if (connState === "connected" && callStartedAtRef.current !== null) {
        syncReceiversToAudio(pc);
      }
      if (connState === "failed") {
        console.error("[SipPhone] PeerConnection_FAILED — media path is dead");
        patchDiag({ lastCallError: "Peer connection failed — media path is dead" });
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // ── WebRTC debug record helpers (gated; ICE creds redacted) ────────────────
  function recordWebrtcDebug(patch: Record<string, unknown>) {
    if (!webrtcSdpDebugEnabled()) return;
    try { Object.assign(webrtcDebugRef.current, patch); } catch { /* never break call path */ }
  }
  /** Finalize the per-call record: log a [WEBRTC_SDP_DEBUG] block and expose it on
   *  window for copy/download. Only runs when debug is enabled. */
  function flushWebrtcDebug(reason: string) {
    if (!webrtcSdpDebugEnabled()) return;
    try {
      const rec: Record<string, unknown> = {
        ...webrtcDebugRef.current,
        flushedAt: new Date().toISOString(),
        flushReason: reason,
      };
      // eslint-disable-next-line no-console
      console.log("[WEBRTC_SDP_DEBUG] outbound call diagnostic record:", rec);
      if (typeof rec.offerSdpRedacted === "string") {
        // eslint-disable-next-line no-console
        console.log("[WEBRTC_SDP_DEBUG] offer SDP (ICE creds redacted):\n" + rec.offerSdpRedacted);
      }
      if (typeof window !== "undefined") {
        (window as unknown as Record<string, unknown>).__ccWebrtcDebug = rec;
        (window as unknown as Record<string, unknown>).__ccDownloadWebrtcDebug = () => {
          try {
            const blob = new Blob([JSON.stringify(rec, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `webrtc-debug-${Date.now()}.json`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 2000);
          } catch { /* noop */ }
        };
        // eslint-disable-next-line no-console
        console.log("[WEBRTC_SDP_DEBUG] saved to window.__ccWebrtcDebug — run __ccDownloadWebrtcDebug() to download.");
      }
      // Ship the redacted record server-side so it can be tailed/correlated live
      // during the 488 investigation. SDP is already redacted; best-effort only.
      try {
        void apiPost("/voice/diag/webrtc-sdp-debug", {
          target: typeof rec.target === "string" ? rec.target : null,
          sipTarget: typeof rec.sipTarget === "string" ? rec.sipTarget : null,
          route: typeof rec.route === "string" ? rec.route : null,
          sessionId: typeof rec.sessionId === "string" ? rec.sessionId : null,
          flushReason: typeof rec.flushReason === "string" ? rec.flushReason : null,
          failedCause: typeof rec.failedCause === "string" ? rec.failedCause : null,
          failedOriginator: typeof rec.failedOriginator === "string" ? rec.failedOriginator : null,
          sipStatusCode: typeof rec.sipStatusCode === "number" ? rec.sipStatusCode : null,
          sipReasonPhrase: typeof rec.sipReasonPhrase === "string" ? rec.sipReasonPhrase : null,
          sipMethod: typeof rec.sipMethod === "string" ? rec.sipMethod : null,
          sessionReturned: typeof rec.sessionReturned === "boolean" ? rec.sessionReturned : null,
          offerSdpSource: typeof rec.offerSdpSource === "string" ? rec.offerSdpSource : null,
          offerSummary: rec.offerSummary ?? null,
          offerCompatibilityIssues: Array.isArray(rec.offerCompatibilityIssues) ? rec.offerCompatibilityIssues : undefined,
          offerSdpRedacted: typeof rec.offerSdpRedacted === "string" ? rec.offerSdpRedacted : null,
          callInvokedAt: typeof rec.callInvokedAt === "string" ? rec.callInvokedAt : null,
          failedAt: typeof rec.failedAt === "string" ? rec.failedAt : null,
        }).catch(() => {});
      } catch { /* best-effort */ }
    } catch { /* never break call path */ }
  }

  function bindSession(session: any, party: string) {
    sessionRef.current = session;
    setRemoteParty(party);
    const mcId = getOrAssignSessionId(session);
    patchSessionMeta(mcId, { remoteParty: party, isActive: true });

    // ── WebRTC SDP diagnostics (READ-ONLY) ──────────────────────────────────
    // JsSIP emits "sdp" for every local/remote offer/answer. We only READ the
    // local outbound offer to prove the exact attribute Asterisk rejects with
    // 488 / Incompatible SDP. We never mutate data.sdp (no munging).
    session.on("sdp", (data: { originator?: string; type?: string; sdp?: string }) => {
      try {
        if (data?.originator !== "local" || data?.type !== "offer" || !data?.sdp) return;
        lastOfferSdpRef.current = data.sdp;
        const summary = summarizeOfferSdp(data.sdp);
        const issues = checkOfferCompatibility(summary);
        recordWebrtcDebug({
          offerSdpAt: new Date().toISOString(),
          offerSummary: summary,
          offerCompatibilityIssues: issues,
          offerSdpRedacted: redactSdpForDebug(data.sdp),
        });
        if (webrtcSdpDebugEnabled()) {
          console.log("[WEBRTC_SDP] local offer summary", {
            profiles: summary.profiles,
            audioCodecs: summary.audioCodecs,
            rtcpMux: summary.hasRtcpMux,
            bundle: summary.hasBundle,
            dtls: summary.hasDtlsFingerprint,
            setup: summary.dtlsSetup,
            ice: summary.hasIceUfrag && summary.hasIcePwd,
            compatibilityIssues: issues,
          });
          if (issues.length) {
            console.warn("[WEBRTC_SDP] offer may be incompatible with Asterisk webrtc endpoint:", issues);
          }
          console.log("[WEBRTC_SDP] full local offer (ICE creds redacted):\n" + redactSdpForDebug(data.sdp));
        }
      } catch {
        /* diagnostics must never break the call path */
      }
    });

    // Capture the RTCPeerConnection when JsSIP creates it (outbound), as a
    // fallback source for the local offer if the "sdp" event is missed.
    session.on("peerconnection", (pcData: { peerconnection?: RTCPeerConnection }) => {
      try {
        recordWebrtcDebug({ peerconnectionEventAt: new Date().toISOString() });
        const pc = pcData?.peerconnection;
        if (!pc) return;
        pc.addEventListener("signalingstatechange", () => {
          try {
            const local = pc.localDescription?.sdp;
            if (local && !lastOfferSdpRef.current) {
              lastOfferSdpRef.current = local;
              recordWebrtcDebug({ offerSdpRedacted: redactSdpForDebug(local), offerSdpSource: "peerconnection" });
            }
          } catch { /* noop */ }
        });
      } catch { /* noop */ }
    });

    session.on("progress", (e?: { response?: { status_code?: number } }) => {
      // Guard: never regress from "connected" → "ringing". A late SIP 180 Ringing
      // can arrive after 200 OK on some VitalPBX proxy setups; without this guard
      // the call transitions back to the ringing/outgoing screen after connecting.
      setCallState((prev) => (prev === "dialing" ? "ringing" : prev));
      patchSessionMeta(mcId, { state: "ringing" });
      const sipCode = e?.response?.status_code;
      // Keep UK local ringback through 180/183 unless the PBX sends audible early
      // media (handled on track). Many trunks signal ringing without SDP audio —
      // stopping local ringback here causes silence until 200 OK.
      if (callDirectionRef.current === "outbound" && !session.isEstablished?.()) {
        console.log(
          "[SipPhone] progress sip="
            + (sipCode ?? "?")
            + " local_ringback=continuing",
        );
      }
    });
    const onCallAnswered = (label: string) => {
      stopOutboundRingbackImmediate("answered");
      stopAllAudio();
      if (!callStartedAtRef.current) {
        callStartedAtRef.current = Date.now();
        finalReportSentRef.current = false;
      }
      setCallStartedAt(callStartedAtRef.current);
      console.log(label);
      setCallState("connected");
      patchSessionMeta(mcId, { state: "connected", onHold: false, isActive: true });
      const pc = session.connection;
      if (pc) {
        syncReceiversToAudio(pc);
        window.setTimeout(() => syncReceiversToAudio(pc), 120);
        window.setTimeout(() => syncReceiversToAudio(pc), 450);
      }
    };
    session.on("accepted", () => onCallAnswered("[SIP] CALL_ACCEPTED"));
    session.on("confirmed", () => onCallAnswered("[SIP] CALL_ACCEPTED (confirmed)"));
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
      if (!userInitiatedHangupRef.current) {
        playCallEndChime();
      }
      userInitiatedHangupRef.current = false;
      console.log("[SIP] CALL_ENDED");
      // Cancel stale-hangup timer — call ended normally via SIP, no need for force cleanup
      if (staleHangupTimerRef.current) { clearTimeout(staleHangupTimerRef.current); staleHangupTimerRef.current = null; }
      submitCallQualityReport("normal");
      // ⛔⛔ Sessions that survive this one: the top-level single-call state
      // (callState / callStartedAt / sessionRef / call audio) still describes a
      // LIVE call and must NOT be reset. Before this guard, ANY session ending —
      // a held call the far end hung up, a waiting call that gave up — ran the
      // full reset below and stomped the live call's UI: timer frozen at 0:00,
      // call screen dropped, and removeSessionMeta's LIFO-restored sessionRef
      // nulled right after it was set (Izzy, 2026-08-27 — surfaced once call
      // waiting made secondary sessions routine). Ringing sessions are NOT
      // survivors: a leftover incoming ring never blocked the reset before.
      const survivorsOnEnd = Array.from(sessionMetaRef.current.values())
        .filter((m) => m.id !== mcId && (m.state === "connected" || m.state === "held"));
      // Multi-call: drop from map. If this was the active call and other
      // sessions are held, removeSessionMeta will auto-unhold the next LIFO.
      removeSessionMeta(mcId);
      dialGuardRef.current = null;
      if (survivorsOnEnd.length > 0) {
        const activeMeta = Array.from(sessionMetaRef.current.values()).find((m) => m.isActive) ?? survivorsOnEnd[0]!;
        if (sessionRef.current === session) {
          sessionRef.current = sessionsByIdRef.current.get(activeMeta.id) ?? null;
        }
        setCallState("connected");
        setRemoteParty(activeMeta.remoteParty);
        setCallDirection(activeMeta.direction);
        setOnHold(Boolean(sessionMetaRef.current.get(activeMeta.id)?.onHold));
        setMutedState(false);
        localRingbackActiveRef.current = false;
        return;
      }
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
      setCallStartedAt(null);
      localRingbackActiveRef.current = false;
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

    session.on("failed", (e: { cause: string; message?: { status_code?: number; reason_phrase?: string; method?: string }; originator?: string; response?: { status_code?: number; reason_phrase?: string; method?: string } }) => {
      stopAllAudio();
      const fields = extractJsSipFailureFields(e);
      const cause = fields.failedCause || e.cause || "unknown";
      console.log("[SIP] CALL_FAILED cause:", cause);
      // ── WebRTC SDP rejection capture ────────────────────────────────────────
      // 488 / 606 (JsSIP cause "Incompatible SDP") means Asterisk rejected the
      // client offer during media negotiation, BEFORE any channel/dialplan. This
      // is the P0 outbound failure signature — always capture it (the normal
      // call-quality report drops sub-1s failures), labeled and de-ambiguated.
      const sipCode = fields.sipStatusCode;
      const reasonPhrase = fields.sipReasonPhrase;
      const sipRejectionSource = inferSipRejectionSource(fields);
      const peerConnectionSnapshot = snapshotPeerConnection(session.connection);
      // Fallback offer source: the live peerconnection localDescription.
      let offer = lastOfferSdpRef.current;
      if (!offer) {
        try { offer = session.connection?.localDescription?.sdp ?? null; } catch { offer = null; }
      }
      recordWebrtcDebug({
        failedAt: new Date().toISOString(),
        failedCause: cause,
        failedOriginator: fields.failedOriginator,
        sipStatusCode: sipCode,
        sipReasonPhrase: reasonPhrase,
        sipMethod: fields.sipMethod,
        sipRejectionSource,
        peerConnectionSnapshot,
        offerSdpRedacted: offer ? redactSdpForDebug(offer) : (webrtcDebugRef.current["offerSdpRedacted"] ?? null),
      });
      if (isWebrtcSdpRejection({ sipCode, cause: e.cause })) {
        const label = sdpRejectionLabel(sipCode);
        console.error(
          `[WEBRTC_SDP_REJECT] Asterisk rejected WebRTC outbound offer — ` +
            `sipCode=${sipCode ?? "?"} reason="${reasonPhrase ?? ""}" cause="${e.cause}" (${label}). ` +
            `This is a media/SDP rejection, NOT a route/trunk/dialplan failure.`,
        );
        if (offer) {
          console.error("[WEBRTC_SDP_REJECT] rejected offer summary", summarizeOfferSdp(offer));
          console.error("[WEBRTC_SDP_REJECT] rejected offer SDP (ICE creds redacted):\n" + redactSdpForDebug(offer));
        } else {
          console.error("[WEBRTC_SDP_REJECT] offer SDP not captured (no local 'sdp' event seen)");
        }
        // Server-side proof, NOT gated by the sub-1s quality-report guard.
        try {
          void apiPost("/voice/diag/call-quality-report", {
            platform: "WEB",
            direction: "outbound",
            endReason: label,
            qualityGrade: "failed",
          }).catch(() => {});
        } catch { /* best-effort */ }
      }
      blackboxRecorderRef.current?.mark("session_failed", {
        cause,
        sipCode,
        sipRejectionSource,
      });
      const blackboxPayload = blackboxRecorderRef.current?.buildOutboundFailurePayload({
        targetRaw: party,
        targetNormalized: party,
        sipTarget: typeof webrtcDebugRef.current.sipTarget === "string" ? webrtcDebugRef.current.sipTarget : null,
        session,
        failedEvent: e,
        offerSdp: offer,
        wssConnected: regState === "registered",
        uaStarted: !!uaRef.current,
        channelNotCreated: true,
      });
      if (blackboxPayload) postWebrtcBlackbox(blackboxPayload);
      flushWebrtcDebug("call_failed");
      // Cancel stale-hangup timer — call failed cleanly at SIP level
      if (staleHangupTimerRef.current) { clearTimeout(staleHangupTimerRef.current); staleHangupTimerRef.current = null; }
      submitCallQualityReport(e.cause || "failed");
      // ⛔⛔ Same survivor guard as "ended": a SECONDARY session failing — most
      // commonly a WAITING call the caller abandoned or the user declined —
      // must not reset the live call's top-level state (that froze the timer,
      // flashed "Call failed" over a healthy conversation, and tore down the
      // shared call audio). Ringing sessions are not survivors.
      const survivorsOnFail = Array.from(sessionMetaRef.current.values())
        .filter((m) => m.id !== mcId && (m.state === "connected" || m.state === "held"));
      removeSessionMeta(mcId);
      dialGuardRef.current = null;
      if (survivorsOnFail.length > 0) {
        const activeMeta = Array.from(sessionMetaRef.current.values()).find((m) => m.isActive) ?? survivorsOnFail[0]!;
        if (sessionRef.current === session) {
          sessionRef.current = sessionsByIdRef.current.get(activeMeta.id) ?? null;
        }
        setCallState("connected");
        setRemoteParty(activeMeta.remoteParty);
        setCallDirection(activeMeta.direction);
        setOnHold(Boolean(sessionMetaRef.current.get(activeMeta.id)?.onHold));
        setMutedState(false);
        localRingbackActiveRef.current = false;
        // Deliberately NO setError: a waiting caller giving up is not a failure
        // of the call the user is still on.
        return;
      }
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
      setCallStartedAt(null);
      localRingbackActiveRef.current = false;
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

    // Defer receiver sync until answer — pre-answer tracks are often silent SDP placeholders.
    if (session.connection && callStartedAtRef.current !== null) {
      syncReceiversToAudio(session.connection);
    }
  }

  /**
   * Lightweight session binding for a call-waiting inbound session while
   * another session is already active. Only updates multi-call meta — does
   * NOT touch the primary callState / remoteParty / sessionRef.
   */
  /**
   * Any call-waiting session still ringing? (side sessions: ringing + not active)
   * `excludeId` covers the just-declined session, whose meta is only removed
   * asynchronously by its own "ended" handler — without it the beep would keep
   * going for the length of the BYE round-trip after the user pressed Decline.
   */
  function anyRingingWaitingSession(excludeId?: string): boolean {
    for (const meta of sessionMetaRef.current.values()) {
      if (excludeId && meta.id === excludeId) continue;
      if (meta.state === "ringing" && !meta.isActive) return true;
    }
    return false;
  }

  /** Stop the call-waiting beep once no waiting session is left ringing. */
  function settleCallWaitingAlert(excludeId?: string) {
    if (!anyRingingWaitingSession(excludeId)) stopCallWaitingAlert();
  }

  /**
   * A side session just ended/failed and was removed from the map. If it was
   * the LAST live call, clear the top-level single-call state. Historically the
   * PRIMARY session's own ended/failed handler reset that state unconditionally
   * — which is exactly the bug the survivor guards above fix (it stomped a live
   * call whenever a secondary session died). With those guards in place, a call
   * bundle can now END on a side session (primary ended first, survivor took
   * over), so the side handlers must close the loop or the dialer stays stuck
   * "on a call" forever. No-ops when another live call remains, and no-ops when
   * the top-level state is already clear (nothing to tear down twice).
   */
  function maybeTeardownTopLevelAfterSideEnd() {
    const anyLive = Array.from(sessionMetaRef.current.values())
      .some((m) => m.state === "connected" || m.state === "held");
    if (anyLive) return;
    const topLevelLive = sessionRef.current != null || callStartedAtRef.current != null;
    if (!topLevelLive) return;
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
    setCallStartedAt(null);
    dialGuardRef.current = null;
    setTimeout(() => setCallState("idle"), 2000);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindSideSession(session: any, party: string, mcId: string) {
    session.on("progress", () => {
      patchSessionMeta(mcId, { state: "ringing", remoteParty: party });
    });
    session.on("accepted", () => {
      // Answered via answerSession — promotion to active is handled there.
      patchSessionMeta(mcId, { state: "connected" });
      settleCallWaitingAlert();
    });
    session.on("confirmed", () => {
      patchSessionMeta(mcId, { state: "connected" });
      settleCallWaitingAlert();
    });
    session.on("hold", () => {
      patchSessionMeta(mcId, { onHold: true, state: "held", isActive: false });
    });
    session.on("unhold", () => {
      patchSessionMeta(mcId, { onHold: false, state: "connected", isActive: true });
    });
    session.on("ended", () => {
      if (!userInitiatedHangupRef.current) {
        playCallEndChime();
      }
      userInitiatedHangupRef.current = false;
      console.log(`[MULTICALL] web side_session_ended=${mcId}`);
      removeSessionMeta(mcId);
      // The waiting caller gave up (or was declined): silence the beep unless
      // another call is still waiting. Without this the alert repeated forever
      // (the old full-ringtone version of this bug looped until the 120 s cap).
      settleCallWaitingAlert();
      maybeTeardownTopLevelAfterSideEnd();
    });
    session.on("failed", () => {
      console.log(`[MULTICALL] web side_session_failed=${mcId}`);
      removeSessionMeta(mcId);
      settleCallWaitingAlert();
      maybeTeardownTopLevelAfterSideEnd();
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  const selectedOutboundRoute = outboundRoutes.find((route) => route.id === selectedOutboundRouteId) || null;

  const dial = useCallback(
    (target: string) => {
      // ── Which line does this call go out on? ────────────────────────────
      // Explicit dropdown selection ("acct:<id>" / "acct:<id>|<routeId>")
      // wins; otherwise, with no selection at all, a caller we last heard
      // from on an extra account is automatically called back on that
      // account. Everything else uses the primary line exactly as before.
      let dialAccountId: string | null = null;
      let dialAccountRouteId: string | null = null;
      const decodedAccount = decodeSipAccountOption(selectedOutboundRouteId);
      if (decodedAccount) {
        dialAccountId = decodedAccount.accountId;
        dialAccountRouteId = decodedAccount.routeId;
      } else if (!selectedOutboundRouteId) {
        const remembered = lookupInboundAccount(target);
        if (
          remembered &&
          accountEnginesRef.current.has(remembered) &&
          accountRegStatesRef.current[remembered] === "registered"
        ) {
          dialAccountId = remembered;
          console.log(`[SipPhone] callback_account_auto_selected account=${remembered}`);
        }
      }
      const accountEngine = dialAccountId ? accountEnginesRef.current.get(dialAccountId) ?? null : null;
      if (dialAccountId && (!accountEngine || accountRegStatesRef.current[dialAccountId] !== "registered")) {
        setError("That phone line is not connected yet. Wait for it to register or pick another line.");
        return;
      }
      if (!accountEngine && (!uaRef.current || regState !== "registered")) {
        setError("Not registered. Wait for SIP registration before dialling.");
        return;
      }
      // Guard: dialGuardRef is set synchronously before async work so double-click
      // cannot place a second SIP INVITE. It is self-healing: the guard is cleared
      // by the session "ended"/"failed" handlers, but an abnormal teardown (no JsSIP
      // event) could leave it armed forever, which would make every later Call press
      // silently no-op and leave the user stuck on the dialpad. So we only suppress
      // when there is a genuinely live session, or the previous attempt is recent
      // enough to still be in its async setup window; otherwise we treat the guard
      // as stale, clear it, and proceed.
      if (dialGuardRef.current !== null) {
        const guardAgeMs = Date.now() - dialGuardRef.current;
        const sessionLive = !!sessionRef.current && sessionRef.current.isEnded?.() !== true;
        if (sessionLive || guardAgeMs < STALE_DIAL_GUARD_MS) {
          console.warn("[SipPhone] dial() suppressed — call already in progress");
          return;
        }
        console.warn(`[SipPhone] dial() recovering stale dial guard after ${guardAgeMs}ms`);
        dialGuardRef.current = null;
      }
      const dialUa = accountEngine ? accountEngine.ua : uaRef.current;
      const domain = accountEngine ? accountEngine.domain : uaRef.current._configuration?.uri?.host;
      if (!domain || !dialUa) return;
      const normalised = target.trim();
      if (!normalised) return;

      // Prune any sessions whose underlying JsSIP session is already ended.
      // This prevents a session that ended after hangup() but before JsSIP
      // fires the asynchronous "ended" event from being seen as "active" below
      // and incorrectly auto-held, which would create a phantom On-Hold entry.
      for (const [id] of Array.from(sessionMetaRef.current.entries())) {
        const s = sessionsByIdRef.current.get(id);
        if (!s || s.isEnded?.()) {
          sessionMetaRef.current.delete(id);
          sessionsByIdRef.current.delete(id);
        }
      }

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
      dialGuardRef.current = Date.now();
      finalReportSentRef.current = false;
      userInitiatedHangupRef.current = false;
      setCallState("dialing");
      setError(null);
      setOnHold(false);
      console.log("[SIP] CALL_INITIATED target:", normalised, "route:", selectedOutboundRoute?.name || "none");
      // Play the ringback on the selected call output device (headset), not the OS
      // default — so it matches where the connected call audio will go.
      startUkLocalRingback(currentSinkIdRef.current);
      localRingbackActiveRef.current = true;
      patchDiag({ localRingback: "local" });

      const resolveDialTarget = accountEngine
        ? apiPost<{ finalNumber: string }>("/voice/me/sip-accounts/resolve-dial", {
            number: normalised,
            accountId: dialAccountId,
            outboundRouteId: dialAccountRouteId,
          }).then((result) => result.finalNumber || normalizeDialTargetForSip(normalised))
        : selectedOutboundRoute
        ? apiPost<{ finalNumber: string }>("/me/outbound-routes/resolve-dial", {
            number: normalised,
            outboundRouteId: selectedOutboundRoute.id,
          }).then((result) => result.finalNumber || normalizeDialTargetForSip(normalised))
        : Promise.resolve(normalised);

      resolveDialTarget
        .then((pbxDialTarget) => {
          const sipTarget = `sip:${pbxDialTarget}@${domain}`;
          const bb = beginOutboundBlackbox(normalised, sipTarget, selectedOutboundRoute?.name || "none");
          const mediaConstraints = voiceAudioConstraints(currentMicDeviceIdRef.current);
          bb.setMedia({ constraints: mediaConstraints, inputDeviceId: currentMicDeviceIdRef.current ?? null });
          return navigator.mediaDevices
            .getUserMedia({ audio: mediaConstraints, video: false })
            .then((localStream) => {
          localStreamRef.current = localStream;
          bb.mark("getusermedia_granted");
          bb.setMedia({
            constraints: mediaConstraints,
            permissionGranted: true,
            inputDeviceLabel: localStream.getAudioTracks()[0]?.label ?? null,
          });
          webrtcDebugRef.current = {
            target: normalised,
            sipTarget,
            route: selectedOutboundRoute?.name || "none",
            callInvokedAt: new Date().toISOString(),
          };
          try {
            bb.mark("ua_call_invoked");
            const session = dialUa.call(sipTarget, {
              mediaStream: localStream,
              pcConfig: dialUa._configuration?.pcConfig ?? {},
            });
            const sessionId = (() => { try { return getOrAssignSessionId(session); } catch { return null; } })();
            if (dialAccountId && sessionId) sessionAccountRef.current.set(sessionId, dialAccountId);
            bb.setDial({
              uaCallInvoked: true,
              sessionReturned: !!session,
              sessionId,
              jssipCallId: (session as { id?: string })?.id ?? null,
            });
            bb.mark("ua_call_returned", { sessionReturned: !!session, sessionId });
            recordWebrtcDebug({
              sessionReturned: !!session,
              sessionId,
            });
            bindSession(session, normalised);
          } catch (e: unknown) {
            bb.mark("ua_call_throw", { error: e instanceof Error ? e.message : String(e) });
            postWebrtcBlackbox(bb.buildOutboundFailurePayload({
              targetRaw: normalised,
              targetNormalized: normalised,
              sipTarget,
              failedEvent: { cause: e instanceof Error ? e.message : String(e), originator: "local" },
              channelNotCreated: true,
              wssConnected: regState === "registered",
              uaStarted: !!uaRef.current,
              mediaMeta: { permissionGranted: true },
              dialMeta: { uaCallInvoked: true, sessionReturned: false },
            }));
            recordWebrtcDebug({ sessionReturned: false, callError: e instanceof Error ? e.message : String(e) });
            flushWebrtcDebug("call_throw");
            localStream.getTracks().forEach((t) => t.stop());
            localStreamRef.current = null;
            stopOutboundRingbackImmediate("call_throw");
            stopAllAudio();
            dialGuardRef.current = null;
            setCallState("idle");
            setSelectedOutboundRouteId("");
            const msg = e instanceof Error ? e.message : "Call failed";
            setError(msg);
            patchDiag({ lastCallError: msg });
          }
        })
        .catch((err) => {
          bb.mark("getusermedia_denied", { name: err?.name ?? "unknown" });
          postWebrtcBlackbox(bb.buildOutboundFailurePayload({
            targetRaw: normalised,
            targetNormalized: normalised,
            sipTarget,
            failedEvent: { cause: err?.name ?? "mic_error", originator: "local" },
            channelNotCreated: true,
            mediaMeta: { permissionGranted: false, errorName: err?.name ?? null },
          }));
          stopOutboundRingbackImmediate("mic_error");
          stopAllAudio();
          dialGuardRef.current = null;
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
        });
        })
        .catch((err) => {
          stopOutboundRingbackImmediate("route_resolve_error");
          stopAllAudio();
          dialGuardRef.current = null;
          setCallState("idle");
          setSelectedOutboundRouteId("");
          const msg = err instanceof Error ? err.message : "Could not resolve outbound route";
          setError(msg);
          patchDiag({ lastCallError: msg });
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
    userInitiatedHangupRef.current = true;
    playCallEndChime();
    console.log("[SIP] user hangup");

    // Capture extension, SIP identity and hangup time before clearing state.
    // ⛔ sipUsername is what scopes the stale-hangup sweep to THIS device — see
    // the guard below and the route's own header in apps/telephony.
    const extensionAtHangup = diagRef.current.extensionNumber;
    const sipUsernameAtHangup = diagRef.current.sipUsername;
    const hangupIso = new Date().toISOString();
    hangupAtRef.current = hangupIso;

    if (sessionRef.current) {
      // Eagerly evict from the multi-call map BEFORE terminate() so that a
      // rapid re-dial() call (which checks sessionMetaRef for an "active"
      // session to auto-hold) does not find this ended session and create a
      // phantom "On Hold" entry in the MultiCallPanel. JsSIP fires "ended"
      // asynchronously (after BYE 200 OK comes back), so without this eager
      // eviction the stale entry can linger for hundreds of milliseconds.
      const evictId = getOrAssignSessionId(sessionRef.current);
      if (sessionMetaRef.current.has(evictId)) {
        sessionMetaRef.current.delete(evictId);
        sessionsByIdRef.current.delete(evictId);
        publishMultiCallState();
      }
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
    setCallStartedAt(null);
    packetsReceivedRef.current = null;
    lastStatsRef.current = null;
    prevBytesReceivedRef.current = null;
    prevBytesReceivedTsRef.current = null;
    lastPingTsRef.current = 0;
    lastBytesGrowthTsRef.current = null;
    oneWayAudioWarnedRef.current = false;

    // ── Post-hangup stale-call safeguard ──────────────────────────────────────
    // 10 seconds after hangup, ask the telephony service if this DEVICE's call is
    // still active. If so, force-evict it and hang up the PBX leg. Last-resort
    // defence for when the PBX never delivered an AMI Hangup event.
    //
    // ⛔⛔ THIS ASKS THE SERVER TO HANG UP A LIVE CALL. Two guards, both required:
    //  1. `sipUsername` scopes it to this device. An extension is shared with the
    //     DESK PHONE (`T18_106` vs the portal's `T18_106_1`), and without this the
    //     sweep killed desk-phone calls mid-conversation (Trust Bookkeepings
    //     ext 106, 2026-08-20 — 7 desk calls cut off).
    //  2. Skip entirely while this device still has other live sessions. The user
    //     hung up ONE call; a sweep fired now can only be aimed at the calls they
    //     are still on. The remaining call's own hangup schedules its own sweep.
    if (staleHangupTimerRef.current) clearTimeout(staleHangupTimerRef.current);
    if (extensionAtHangup && sipUsernameAtHangup && sessionMetaRef.current.size === 0) {
      staleHangupTimerRef.current = setTimeout(() => {
        staleHangupTimerRef.current = null;
        // Re-check at fire time: a new call may have started during the 10 s wait,
        // and sweeping then would hang up a conversation that is already underway.
        if (sessionMetaRef.current.size > 0) {
          console.log("[SIP] stale-hangup sweep skipped — a call is live again");
          return;
        }
        apiPost("/telephony/calls/stale-hangup-for-extension", {
          extension: extensionAtHangup,
          sipUsername: sipUsernameAtHangup,
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
  }, [teardownRemoteAudioPlayback, clearCallDiag, playCallEndChime, stopAllAudio]);

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

  // Low-level: route the call audio element to a specific output device. Does NOT
  // touch speaker-mode or the preferred base device — callers decide those.
  const applySink = useCallback(async (deviceId: string) => {
    const el = audioRef.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!el) return;
    try {
      if (typeof el.setSinkId === "function") {
        await el.setSinkId(deviceId);
      }
      currentSinkIdRef.current = deviceId;
      setCurrentSinkId(deviceId);
    } catch (e) {
      console.warn("[SipPhone] setSinkId failed:", e);
    }
  }, []);

  // Public: choose the BASE call-output device (headset / configured speaker), e.g.
  // from the settings device picker. Choosing a base device exits loudspeaker mode
  // and routes there. `speakerOn` is a separate, temporary override (see toggleSpeaker),
  // NOT "a device is selected" — that conflation made the Speaker button light up
  // whenever a headset was configured.
  const setAudioSinkId = useCallback(async (sinkId: string) => {
    preferredSinkIdRef.current = sinkId;
    setSpeakerOn(false);
    await applySink(sinkId);
  }, [applySink]);

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
      // Compare against the PREFERRED base device, not the currently-routed sink —
      // otherwise flipping into loudspeaker mode (which changes currentSinkId) would
      // make this fire and yank audio straight back to the headset.
      if (desktopSettings.selectedSpeakerDeviceId != null && desktopSettings.selectedSpeakerDeviceId !== preferredSinkIdRef.current) {
        void setAudioSinkId(desktopSettings.selectedSpeakerDeviceId);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // Runs once; the base device is applied on mount and updated live via onSettings.
    // currentSinkId is intentionally NOT a dep (it changes on every speaker toggle).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setAudioInputDeviceId, setAudioSinkId]);

  // The Speaker button is a temporary override: ON routes to the computer's
  // built-in LOUDSPEAKER; OFF returns to the base device (the configured headset,
  // or OS default). It does NOT change the saved base device.
  const toggleSpeaker = useCallback(async () => {
    if (speakerOn) {
      // Turn loudspeaker OFF → back to the headset / base output device.
      setSpeakerOn(false);
      await applySink(preferredSinkIdRef.current || "");
      return;
    }
    // Turn loudspeaker ON → find the built-in speaker (NOT the headset).
    let devices = audioOutputDevices;
    if (devices.length === 0 && typeof navigator !== "undefined" && navigator.mediaDevices?.enumerateDevices) {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        devices = all.filter((d) => d.kind === "audiooutput");
        setAudioOutputDevices(devices);
      } catch { /* ignore */ }
    }
    const isHeadset = (l: string) => l.includes("headset") || l.includes("headphone") || l.includes("earphone") || l.includes("earbud");
    const base = preferredSinkIdRef.current;
    // Prefer a real loudspeaker: labelled "speaker", not a headset, not the base device.
    const loudspeaker =
      devices.find((d) => d.deviceId !== base && d.deviceId !== "communications" && d.label.toLowerCase().includes("speaker") && !isHeadset(d.label.toLowerCase())) ??
      devices.find((d) => d.deviceId !== base && d.deviceId !== "default" && d.deviceId !== "communications" && !isHeadset(d.label.toLowerCase()));
    setSpeakerOn(true);
    // If we can't identify a distinct speaker, fall back to OS default ("").
    await applySink(loudspeaker ? loudspeaker.deviceId : "");
  }, [speakerOn, audioOutputDevices, applySink]);

  // Enumerate devices whenever a call connects
  useEffect(() => {
    if (callState === "connected") void refreshAudioDevices();
  }, [callState, refreshAudioDevices]);

  // Enrich the incoming caller with the ring-group/queue prefix + clean name from the
  // live-call feed (matched by caller number). Broadcast so the mini pop-out — which
  // has no reliable live-call feed of its own — can render the prefix pill.
  // Enrich the incoming caller with the ring-group/queue prefix + clean name from the
  // live-call feed (matched by caller number). Broadcast so the mini pop-out — which
  // has no reliable live-call feed of its own — can render the prefix pill.
  useEffect(() => {
    if (callDirection !== "inbound" || callState === "idle" || callState === "ended") {
      setRemotePartyName(null);
      setRemotePartyPrefix(null);
      return;
    }
    const num = (remotePartyNumber || "").replace(/\D/g, "");
    const raw = (remoteParty || "").trim();
    let matched: LiveCall | null = null;
    for (const c of enrichLiveCalls.values()) {
      if (c.direction !== "inbound") continue;
      const cf = (c.from || "").replace(/\D/g, "");
      if (num && cf && (cf === num || cf.endsWith(num) || num.endsWith(cf))) { matched = c; break; }
    }
    const cleanName = matched?.fromName?.trim() || null;
    let prefix: string | null = matched?.fromPrefix?.trim() || null;
    let name: string | null = cleanName;
    if (!prefix && raw) {
      const ci = raw.indexOf(":");
      if (ci > 0 && !/^\+?\d{5,}$/.test(raw.slice(0, ci).trim())) {
        prefix = raw.slice(0, ci).trim();
        if (!name) name = raw.slice(ci + 1).replace(/:\s*$/, "").trim() || null;
      }
    }
    if (!prefix && cleanName && raw && raw.length > cleanName.length && raw.toLowerCase().endsWith(cleanName.toLowerCase())) {
      prefix = raw.slice(0, raw.length - cleanName.length).trim() || null;
      name = cleanName;
    }
    setRemotePartyName(name);
    setRemotePartyPrefix(prefix);
  }, [enrichLiveCalls, callDirection, callState, remoteParty, remotePartyNumber]);

  // ── Phantom-ring protection ─────────────────────────────────────────────────
  // The ring is normally stopped by a SIP event on the same socket that started
  // it. When that socket dies mid-ring (Fixup Group, 2026-08-10: WS_DISCONNECTED
  // 6 ms after the incoming-call screen appeared, ring survived a PC reboot),
  // no CANCEL can ever arrive and the ring runs forever. Two independent guards:
  //
  //  1) A liveness sweep while ringing: session gone/ended, UA gone (rebuild
  //     mid-ring), or the ring outliving RINGING_MAX_MS → force-stop. JsSIP's
  //     own no_answer_timeout (60 s) ends any HEALTHY unanswered ring first, so
  //     the cap only ever fires on a ring whose timers are already wedged.
  //  2) The live-call feed (/ws/telephony — a second, independent socket): if
  //     the PBX call we were ringing for is hungup/removed, the call is over
  //     regardless of what our SIP socket failed to deliver.
  //
  // ⛔ Deliberately NOT evidence: liveCall.state === "up" / answeredAt. An IVR
  // or queue answers the CALLER leg immediately (to play prompts/MOH) while
  // agents are still legitimately ringing — treating "answered" as
  // answered-elsewhere would kill every queue ring. Only ended/gone counts.
  //
  // Scope: the PRIMARY ringing call. A call-waiting side ring is bounded by the
  // audio layer's RINGTONE_ABSOLUTE_CAP_MS backstop.
  const RINGING_MAX_MS = 90_000;
  const ringLiveMatchRef = useRef<string | null>(null);

  function killPhantomRing(why: string) {
    console.warn(`[SipPhone] phantom_ring_stop reason=${why}`);
    stopAllAudio();
    const s = sessionRef.current;
    // Best-effort decline toward the PBX; on a dead socket this throws and the
    // local state reset below is the part that matters.
    try { if (s && !s.isEnded?.()) s.terminate?.(); } catch { /* dead transport */ }
    if (s) {
      for (const [id, sess] of sessionsByIdRef.current.entries()) {
        if (sess === s) { removeSessionMeta(id); break; }
      }
    }
    sessionRef.current = null;
    setCallDirection(null);
    setCallState("idle");
    setRemoteParty(null);
    setOnHold(false);
    stopLocalStream();
    teardownRemoteAudioPlayback();
    patchDiag({ lastCallError: `Ring force-stopped (${why}) — the call was already over` });
    clearCallDiag();
  }

  // Guard 1: liveness sweep, active only while the primary call is ringing.
  useEffect(() => {
    if (callState !== "ringing" || callDirection !== "inbound") return undefined;
    const ringingSince = Date.now();
    const timer = setInterval(() => {
      const s = sessionRef.current;
      if (!s) { killPhantomRing("no_session"); return; }
      if (s.isEnded?.()) { killPhantomRing("session_ended"); return; }
      if (!uaRef.current) { killPhantomRing("ua_gone"); return; }
      if (Date.now() - ringingSince > RINGING_MAX_MS) { killPhantomRing("max_ring_exceeded"); return; }
    }, 5_000);
    return () => clearInterval(timer);
    // killPhantomRing is a plain hook-scope function (same pattern as bindSession).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callState, callDirection]);

  // Guard 2: the live-call feed says the call is over. Only acts on positive
  // evidence (matched call ended, or a previously matched call vanished from a
  // CONNECTED feed) — an unmatched ring is left alone, and a disconnected feed
  // proves nothing (its map goes stale, not empty).
  useEffect(() => {
    if (callDirection !== "inbound" || callState !== "ringing") {
      ringLiveMatchRef.current = null;
      return;
    }
    if (liveFeedStatus !== "connected") return;
    const num = (remotePartyNumber || "").replace(/\D/g, "");
    if (!num) return;
    let matched: LiveCall | null = null;
    for (const c of enrichLiveCalls.values()) {
      if (c.direction !== "inbound") continue;
      const cf = (c.from || "").replace(/\D/g, "");
      if (cf && (cf === num || cf.endsWith(num) || num.endsWith(cf))) { matched = c; break; }
    }
    if (matched) {
      ringLiveMatchRef.current = matched.id;
      if (matched.state === "hungup" || matched.endedAt != null) {
        killPhantomRing("live_call_ended");
      }
    } else if (ringLiveMatchRef.current) {
      // We saw this call in the feed earlier in THIS ring and now it is gone
      // from a healthy feed — the PBX call ended (hangup or answered elsewhere
      // and completed). Nothing should still be ringing for it.
      killPhantomRing("live_call_gone");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrichLiveCalls, liveFeedStatus, callDirection, callState, remotePartyNumber]);

  // Guard 3: the CallInvite row is the true per-call cancel signal — the api
  // marks it CANCELED / claimed the moment another device answers, which is
  // exactly the signal mobile gets as a push and web gets nowhere. Poll it
  // over plain HTTP (a fresh connection every time — immune to the dead-WS
  // failure) only while ringing. Same matched-then-gone semantics as guard 2:
  // we only act after we have SEEN our invite PENDING once, so a ring whose
  // call never created an invite is left alone.
  const ringInviteMatchRef = useRef<string | null>(null);
  useEffect(() => {
    if (callDirection !== "inbound" || callState !== "ringing") {
      ringInviteMatchRef.current = null;
      return undefined;
    }
    if (!hasBrowserAuthToken()) return undefined;
    const num = ((remotePartyNumber ?? remoteParty) || "").replace(/\D/g, "");
    let stopped = false;
    const poll = async () => {
      try {
        const rows = await apiGet<Array<{ id: string; fromNumber: string | null }>>(
          "/mobile/call-invites/pending",
        );
        if (stopped) return;
        const match = (rows || []).find((r) => {
          const rf = (r.fromNumber || "").replace(/\D/g, "");
          if (!num || !rf) return false;
          return rf === num || rf.endsWith(num) || num.endsWith(rf);
        });
        if (match) {
          ringInviteMatchRef.current = match.id;
        } else if (ringInviteMatchRef.current) {
          // Our invite was PENDING moments ago and is not any more, while we
          // are still ringing — it was canceled, claimed by another device,
          // or expired. Stop ringing.
          killPhantomRing("invite_no_longer_pending");
        }
      } catch {
        /* transient poll failure proves nothing — keep ringing */
      }
    };
    const timer = setInterval(() => { void poll(); }, 4_000);
    void poll();
    return () => { stopped = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callDirection, callState, remotePartyNumber, remoteParty]);

  // Reset speaker mode on call end and route audio back to the base device, so the
  // NEXT call starts on the headset (not stuck on the loudspeaker from last time).
  useEffect(() => {
    if (callState === "idle" || callState === "ended") {
      setSpeakerOn(false);
      void applySink(preferredSinkIdRef.current || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    userInitiatedHangupRef.current = true;
    playCallEndChime();
    try { s.terminate(); } catch { /* already ended */ }
    // Silence the call-waiting beep now rather than waiting for the BYE to come
    // back — declining must feel instant. Excludes this session because its meta
    // is only removed later, by its own "ended" handler.
    settleCallWaitingAlert(id);
    // removeSessionMeta will fire via session.on("ended") handler.
  }, [playCallEndChime]);

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
    callStartedAt,
    callDirection,
    remoteParty,
    remotePartyNumber,
    remotePartyName,
    remotePartyPrefix,
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
    sipAccounts,
    accountRegStates,
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
    callStartedAt: phone.callStartedAt,
    callDirection: phone.callDirection,
    remoteParty: phone.remoteParty,
    remotePartyNumber: phone.remotePartyNumber,
    remotePartyName: phone.remotePartyName,
    remotePartyPrefix: phone.remotePartyPrefix,
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
    sipAccounts: phone.sipAccounts,
    accountRegStates: phone.accountRegStates,
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
  callStartedAt: null,
  callDirection: null,
  remoteParty: null,
  remotePartyNumber: null,
  remotePartyName: null,
  remotePartyPrefix: null,
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
  sipAccounts: [],
  accountRegStates: {},
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

/**
 * The phone if a provider is mounted, else null — NEVER throws.
 *
 * For chrome that must survive being rendered outside the provider (the reload
 * notice, mounted in providers.tsx alongside it). ⛔ Use `useSipPhone` for
 * anything that genuinely needs the phone; a silent null there hides a real
 * wiring bug.
 */
export function useOptionalSipPhone(): (SipPhoneState & SipPhoneActions) | null {
  return useContext(SipPhoneContext);
}
