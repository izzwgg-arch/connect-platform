"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, apiPost } from "../services/apiClient";

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
  /** Inbound audio jitter in milliseconds. */
  jitterMs: number | null;
  /** Round-trip time for the selected ICE candidate pair in milliseconds. */
  rttMs: number | null;
  /** True once at least one live remote audio track is attached to the element. */
  remoteAudioReceiving: boolean;
  lastRegError: string | null;
  lastCallError: string | null;
  webrtcEnabled: boolean;
  sipWssConfigured: boolean;
  sipDomainConfigured: boolean;
}

export type SipPhoneState = {
  regState: SipRegState;
  callState: SipCallState;
  remoteParty: string | null;
  muted: boolean;
  error: string | null;
  diag: SipDiagnostics;
};

export type SipPhoneActions = {
  dial: (target: string) => void;
  answer: () => void;
  hangup: () => void;
  setMute: (mute: boolean) => void;
  sendDtmf: (digit: string) => void;
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

/** Scrape getStats() for audio quality + ICE candidate type. Non-fatal. */
async function pollCallStats(pc: RTCPeerConnection): Promise<{
  packetsLost: number | null;
  jitterMs: number | null;
  rttMs: number | null;
  selectedCandidateType: IceCandidateType;
}> {
  const result = {
    packetsLost: null as number | null,
    jitterMs: null as number | null,
    rttMs: null as number | null,
    selectedCandidateType: null as IceCandidateType,
  };
  try {
    const stats = await pc.getStats();
    // Build local-candidate map for candidate-pair → candidate-type lookup
    const localCandidates = new Map<string, string>();
    stats.forEach((r) => {
      if (r.type === "local-candidate" && typeof (r as any).candidateType === "string") {
        localCandidates.set(r.id, (r as any).candidateType);
      }
    });
    stats.forEach((r) => {
      // Inbound audio: packet loss + jitter
      if (r.type === "inbound-rtp" && (r as any).kind === "audio") {
        const ir = r as any;
        if (typeof ir.packetsLost === "number") result.packetsLost = ir.packetsLost;
        if (typeof ir.jitter === "number") result.jitterMs = Math.round(ir.jitter * 1000);
      }
      // Nominated ICE candidate pair: RTT + local candidate type
      if (r.type === "candidate-pair" && (r as any).nominated === true) {
        const cp = r as any;
        if (typeof cp.currentRoundTripTime === "number") {
          result.rttMs = Math.round(cp.currentRoundTripTime * 1000);
        }
        const localCandType = localCandidates.get(cp.localCandidateId);
        if (localCandType) {
          result.selectedCandidateType = localCandType as IceCandidateType;
        }
      }
    });
  } catch {
    // getStats can throw if the PC is torn down
  }
  return result;
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
  jitterMs: null,
  rttMs: null,
  remoteAudioReceiving: false,
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
  const [remoteParty, setRemoteParty] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<SipDiagnostics>(DEFAULT_DIAG);
  const [dialpadInput, setDialpadInput] = useState("");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uaRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sessionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wiredPeerConnectionsRef = useRef<WeakSet<RTCPeerConnection>>(new WeakSet());
  const statsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function patchDiag(patch: Partial<SipDiagnostics>) {
    setDiag((prev) => ({ ...prev, ...patch }));
  }

  function stopStatsPolling() {
    if (statsIntervalRef.current !== null) {
      clearInterval(statsIntervalRef.current);
      statsIntervalRef.current = null;
    }
  }

  function startStatsPolling(pc: RTCPeerConnection) {
    stopStatsPolling();
    statsIntervalRef.current = setInterval(async () => {
      const s = await pollCallStats(pc);
      patchDiag({
        packetsLost: s.packetsLost,
        jitterMs: s.jitterMs,
        rttMs: s.rttMs,
        selectedCandidateType: s.selectedCandidateType,
        isUsingRelay: s.selectedCandidateType === "relay",
      });
    }, 4_000);
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
            iceTransportPolicy: "all",
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
              const party = data.request.from.display_name || data.request.from.uri.user;
              bindSession(data.session, party);
              setCallState("ringing");
              setRemoteParty(party);
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
      if (uaRef.current) {
        try { uaRef.current.stop(); } catch { /* ignore */ }
        uaRef.current = null;
      }
      if (audioRef.current) {
        audioRef.current.remove();
        audioRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session lifecycle ───────────────────────────────────────────────────

  const clearCallDiag = useCallback(() => {
    stopStatsPolling();
    patchDiag({
      iceGatheringState: null,
      iceConnectionState: null,
      selectedCandidateType: null,
      isUsingRelay: false,
      packetsLost: null,
      jitterMs: null,
      rttMs: null,
      remoteAudioReceiving: false,
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
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      attachRemoteStream(stream);
    });

    pc.addEventListener("icegatheringstatechange", () => {
      patchDiag({ iceGatheringState: pc.iceGatheringState });
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      patchDiag({ iceConnectionState: pc.iceConnectionState });

      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        syncReceiversToAudio(pc);
        // Kick off stats polling and do an immediate first poll for candidate type.
        startStatsPolling(pc);
        pollCallStats(pc).then((s) => {
          patchDiag({
            selectedCandidateType: s.selectedCandidateType,
            isUsingRelay: s.selectedCandidateType === "relay",
            packetsLost: s.packetsLost,
            jitterMs: s.jitterMs,
            rttMs: s.rttMs,
          });
        });
      }

      if (pc.iceConnectionState === "failed") {
        stopStatsPolling();
        const msg = "ICE connection failed — audio cannot reach the PBX. "
          + (diag.hasTurn
            ? "TURN is configured; check firewall/UDP ports."
            : "No TURN server configured — configure one via Voice → Settings → WebRTC.");
        setError(msg);
        patchDiag({ lastCallError: msg });
      }

      if (pc.iceConnectionState === "disconnected") {
        patchDiag({ lastCallError: "ICE disconnected — possible network interruption" });
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "connected") syncReceiversToAudio(pc);
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindSession(session: any, party: string) {
    sessionRef.current = session;
    setRemoteParty(party);

    session.on("progress", () => setCallState("ringing"));
    session.on("accepted", () => {
      setCallState("connected");
      if (session.connection) syncReceiversToAudio(session.connection);
    });
    session.on("confirmed", () => {
      setCallState("connected");
      if (session.connection) syncReceiversToAudio(session.connection);
    });

    session.on("ended", () => {
      sessionRef.current = null;
      setCallState("ended");
      setRemoteParty(null);
      setMutedState(false);
      teardownRemoteAudioPlayback();
      clearCallDiag();
      setTimeout(() => setCallState("idle"), 2000);
    });

    session.on("failed", (e: { cause: string }) => {
      sessionRef.current = null;
      const msg = `Call failed: ${e.cause}`;
      setCallState("idle");
      setRemoteParty(null);
      setMutedState(false);
      setError(msg);
      teardownRemoteAudioPlayback();
      patchDiag({ lastCallError: msg });
      clearCallDiag();
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

      setCallState("dialing");
      setError(null);

      navigator.mediaDevices
        .getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS, video: false })
        .then((localStream) => {
          try {
            const session = uaRef.current!.call(`sip:${normalised}@${domain}`, {
              mediaStream: localStream,
              pcConfig: uaRef.current!._configuration?.pcConfig ?? {},
            });
            bindSession(session, normalised);
          } catch (e: unknown) {
            localStream.getTracks().forEach((t) => t.stop());
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
    navigator.mediaDevices
      .getUserMedia({ audio: VOICE_AUDIO_CONSTRAINTS, video: false })
      .then((localStream) => {
        try {
          sessionRef.current?.answer({ mediaStream: localStream });
          setCallState("connected");
        } catch (e: unknown) {
          localStream.getTracks().forEach((t) => t.stop());
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
    if (!sessionRef.current) return;
    try { sessionRef.current.terminate(); } catch { /* already ended */ }
    sessionRef.current = null;
    setCallState("idle");
    setRemoteParty(null);
    setMutedState(false);
    teardownRemoteAudioPlayback();
    clearCallDiag();
  }, [teardownRemoteAudioPlayback, clearCallDiag]);

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
      if (!sessionRef.current || callState !== "connected") return;
      try { sessionRef.current.sendDTMF(digit); } catch { /* ignore */ }
    },
    [callState],
  );

  return {
    regState,
    callState,
    remoteParty,
    muted,
    error,
    diag,
    dial,
    answer,
    hangup,
    setMute,
    sendDtmf,
    dialpadInput,
    setDialpadInput,
  };
}
