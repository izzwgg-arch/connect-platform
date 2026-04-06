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
  /** Prevent double wirePC on the same RTCPeerConnection (newRTCSession + bindSession). */
  const wiredPeerConnectionsRef = useRef<WeakSet<RTCPeerConnection>>(new WeakSet());

  function patchDiag(patch: Partial<SipDiagnostics>) {
    setDiag((prev) => ({ ...prev, ...patch }));
  }

  // ── Initialise ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    async function init() {
      // Hidden audio element for remote media
      if (!audioRef.current) {
        const el = document.createElement("audio");
        el.autoplay = true;
        el.setAttribute("playsinline", "");
        el.muted = false;
        el.volume = 1.0;
        // display:none can prevent playback in some browsers; keep element in layout off-screen.
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

      // Check mic permission up front so the UI can warn immediately
      const micPerm = await checkMicPermission();
      if (!cancelled) patchDiag({ micPermission: micPerm });

      // Fetch extension config (no SIP password — just metadata + WSS URL)
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

      // Fail fast with actionable errors instead of silent breakage
      if (!ext.webrtcEnabled) {
        setError("WEBRTC_DISABLED — An administrator must enable WebRTC for this tenant. Go to PBX → Extensions → WebRTC Settings.");
        return;
      }
      if (!sipWssUrl) {
        setError(
          "SIP WSS URL is not configured. Set sipWsUrl in Voice → Settings → WebRTC, " +
            "or set PBX_WS_ENDPOINT=wss://209.145.60.79:8089/ws on the API server.",
        );
        return;
      }
      if (!sipDomain) {
        setError(
          "SIP Domain is not configured. Set sipDomain in Voice → Settings → WebRTC.",
        );
        return;
      }
      if (!ext.sipUsername) {
        setError("No SIP username assigned. Contact your administrator.");
        return;
      }
      if (!hasTurnServer(ext.iceServers)) {
        // Warn but do NOT block — STUN alone may work on a local/simple NAT
        console.warn(
          "[useSipPhone] No TURN server configured. " +
            "Audio may fail behind strict NAT. Configure a coturn server and add its " +
            "credentials via Voice → Settings → WebRTC → ICE Servers.",
        );
      }

      // Fetch real SIP credentials via POST (uses admin-stored encrypted password on VitalPBX)
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
          ? "SIP_CREDENTIAL_NOT_SET — An administrator must set the SIP password for this extension. Go to PBX → Extensions → set SIP Password."
          : `Failed to fetch SIP credentials: ${raw}. Try refreshing the page.`;
        setError(msg);
        patchDiag({ lastRegError: msg });
        return;
      }

      if (cancelled || !sipPassword) {
        setError("SIP_CREDENTIAL_NOT_SET — An administrator must set the SIP password for this extension. Go to PBX → Extensions → set SIP Password.");
        return;
      }

      // Build JsSIP UA
      try {
        const JsSIP = await loadJsSIP();
        if (cancelled) return;

        setRegState("connecting");

        const socket = new JsSIP.WebSocketInterface(sipWssUrl);

        const uaConfig: Record<string, unknown> = {
          sockets: [socket],
          uri: `sip:${ext.sipUsername}@${sipDomain}`,
          password: sipPassword,
          // authorization_user must match the PJSIP auth object username in Asterisk.
          // VitalPBX names auth objects after the device_name (e.g. "T2_103_1"), not the
          // device user field ("103_1"). Sending the wrong auth username causes 401.
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

        ua.on("connecting", () => {
          if (!cancelled) setRegState("connecting");
        });

        ua.on("connected", () => {
          if (!cancelled) setRegState("registering");
        });

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

            // Proactively request microphone permission right after registration.
            // This causes the browser to show the "Allow microphone" prompt immediately
            // while the user is looking at the softphone, rather than failing silently
            // at call initiation time. The stream is released right away — we only
            // need the permission grant, not the audio track itself.
            if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
              navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                .then((stream) => {
                  stream.getTracks().forEach((t) => t.stop());
                  patchDiag({ lastRegError: null });
                })
                .catch((err) => {
                  const msg = `Microphone access denied — please allow microphone in your browser/device settings. (${err?.name ?? err})`;
                  if (!cancelled) setError(msg);
                  patchDiag({ lastRegError: msg });
                });
            }
          }
        });

        ua.on("unregistered", () => {
          if (!cancelled) setRegState("idle");
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
            console.log("[SIP] >>> newRTCSession event, originator:", data.originator);
            if (cancelled) return;

            // JsSIP creates the RTCPeerConnection BEFORE firing newRTCSession
            // for outgoing calls (line 287 vs 296 in RTCSession.js), so the
            // "peerconnection" event has already fired by now. Wire the PC
            // directly if it exists; fall back to the event for incoming calls.
            if (data.session.connection) {
              console.log("[SIP] >>> wiring PC directly from newRTCSession (connection already exists)");
              wirePC(data.session.connection);
            } else {
              data.session.on("peerconnection", (pcData: { peerconnection: RTCPeerConnection }) => {
                console.log("[SIP] >>> peerconnection event fired (incoming)");
                wirePC(pcData.peerconnection);
              });
            }

            if (data.originator === "remote") {
              const party =
                data.request.from.display_name || data.request.from.uri.user;
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
      if (uaRef.current) {
        try {
          uaRef.current.stop();
        } catch { /* ignore */ }
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

  const teardownRemoteAudioPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
  }, []);

  function attachRemoteStream(stream: MediaStream) {
    const el = audioRef.current;
    if (!el) {
      console.warn("[SIP] audioRef missing — cannot play remote audio");
      return;
    }
    el.srcObject = stream;
    console.log("[SIP] attachRemoteStream: tracks", stream.getAudioTracks().map((t) => `${t.kind}:${t.readyState}`).join(", "));
    el.play().then(() => {
      console.log("[SIP] <audio>.play() succeeded");
    }).catch((err) => {
      console.warn("[SIP] <audio>.play() rejected:", err?.name, err?.message);
      const resume = () => {
        audioRef.current?.play().catch(() => undefined);
        document.removeEventListener("click", resume);
        document.removeEventListener("touchend", resume);
      };
      document.addEventListener("click", resume, { once: true });
      document.addEventListener("touchend", resume, { once: true });
      patchDiag({ lastCallError: `audio autoplay blocked: ${err?.name} — tap screen to hear audio` });
    });
    // Do not also route this stream through AudioContext.destination — that plays the same
    // remote audio twice (HTMLAudioElement + speakers) and causes echo / chorus / slowdown.
  }

  function syncReceiversToAudio(pc: RTCPeerConnection) {
    const tracks = pc
      .getReceivers()
      .map((r) => r.track)
      .filter((t): t is MediaStreamTrack => !!t && t.kind === "audio" && t.readyState === "live");
    if (tracks.length === 0) {
      console.log("[SIP] syncReceiversToAudio: no live remote audio tracks yet");
      return;
    }
    attachRemoteStream(new MediaStream(tracks));
  }

  function wirePC(pc: RTCPeerConnection) {
    const wired = wiredPeerConnectionsRef.current;
    if (wired.has(pc)) {
      console.log("[SIP] wirePC: skip (already wired)");
      return;
    }
    wired.add(pc);
    console.log("[SIP] wirePC: attaching track + ICE listeners");

    pc.addEventListener("track", (e: RTCTrackEvent) => {
      console.log("[SIP] track event:", e.track.kind, "readyState:", e.track.readyState, "streams:", e.streams.length);
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      attachRemoteStream(stream);
    });

    pc.addEventListener("icegatheringstatechange", () => {
      console.log("[SIP] ICE gathering:", pc.iceGatheringState);
      patchDiag({ iceGatheringState: pc.iceGatheringState });
    });

    pc.addEventListener("iceconnectionstatechange", () => {
      console.log("[SIP] ICE connection:", pc.iceConnectionState);
      patchDiag({ iceConnectionState: pc.iceConnectionState });
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        syncReceiversToAudio(pc);
      }
      if (pc.iceConnectionState === "failed") {
        const msg = "ICE connection failed. Audio cannot traverse your NAT. Configure a TURN server in Voice → Settings → WebRTC.";
        setError(msg);
        patchDiag({ lastCallError: msg });
      }
      if (pc.iceConnectionState === "disconnected") {
        patchDiag({ lastCallError: "ICE disconnected — possible network interruption" });
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      console.log("[SIP] PC connection state:", pc.connectionState);
      if (pc.connectionState === "connected") {
        syncReceiversToAudio(pc);
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindSession(session: any, party: string) {
    console.log("[SIP] >>> bindSession called, party:", party, "session.connection:", !!session?.connection);
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
      patchDiag({ iceGatheringState: null, iceConnectionState: null });
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
      patchDiag({ lastCallError: msg, iceGatheringState: null, iceConnectionState: null });
    });

    // Do NOT call wirePC again here — newRTCSession already wired the PC once.
    // Duplicate listeners were stacking multiple play() / AudioContext paths.
    if (session.connection) {
      syncReceiversToAudio(session.connection);
    }
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

      console.log("[SIP] >>> dial() called, target:", normalised, "domain:", domain);
      setCallState("dialing");
      setError(null);

      navigator.mediaDevices
        .getUserMedia({ audio: true, video: false })
        .then((localStream) => {
          console.log("[SIP] >>> getUserMedia OK, tracks:", localStream.getTracks().length);
          try {
            console.log("[SIP] >>> calling ua.call()...");
            const session = uaRef.current!.call(`sip:${normalised}@${domain}`, {
              mediaStream: localStream,
              pcConfig: uaRef.current!._configuration?.pcConfig ?? {},
            });
            console.log("[SIP] >>> ua.call() returned, session.connection:", !!session?.connection);
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
            setError("Microphone access denied. Please allow microphone in your browser settings for this site, then try again.");
          } else if (err?.name === "NotFoundError") {
            setError("No microphone found. Please connect a microphone or headset and try again.");
          } else {
            setError(`Microphone error: ${err?.message ?? err}`);
          }
          patchDiag({ lastCallError: `mic_denied: ${err?.name}` });
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regState],
  );

  const answer = useCallback(() => {
    if (!sessionRef.current) return;
    navigator.mediaDevices
      .getUserMedia({ audio: true, video: false })
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
    try {
      sessionRef.current.terminate();
    } catch { /* already ended */ }
    sessionRef.current = null;
    setCallState("idle");
    setRemoteParty(null);
    setMutedState(false);
    teardownRemoteAudioPlayback();
  }, [teardownRemoteAudioPlayback]);

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
      try {
        sessionRef.current.sendDTMF(digit);
      } catch { /* ignore */ }
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
