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
        el.style.display = "none";
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
        const msg = e instanceof Error ? e.message : "EXTENSION_NOT_FOUND";
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
        setError("WebRTC is not enabled for your account. Go to Voice → Settings to enable it.");
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

      // Fetch real SIP credentials via POST (resets the password on the PBX)
      let sipPassword: string;
      try {
        const reset = await apiPost<{ sipPassword: string; provisioning?: { sipPassword: string } }>(
          "/voice/me/reset-sip-password",
        );
        sipPassword = reset.sipPassword ?? reset.provisioning?.sipPassword ?? "";
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "SIP_CREDENTIAL_FETCH_FAILED";
        setError(`Failed to fetch SIP credentials: ${msg}. Try refreshing the page.`);
        patchDiag({ lastRegError: msg });
        return;
      }

      if (cancelled || !sipPassword) {
        setError("SIP password is empty. Provisioning may not be set up on the PBX.");
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
            setRegState("registered");
            setError(null);
            patchDiag({ lastRegError: null });
          }
        });

        ua.on("unregistered", () => {
          if (!cancelled) setRegState("idle");
        });

        ua.on("registrationFailed", (e: { cause: string; response?: { status_code?: number } }) => {
          if (!cancelled) {
            const code = e.response?.status_code;
            const msg = code
              ? `SIP registration failed (${code}): ${e.cause}. ${code === 401 || code === 403 ? "Check SIP credentials." : "Check PBX configuration."}`
              : `SIP registration failed: ${e.cause}`;
            setRegState("failed");
            setError(msg);
            patchDiag({ lastRegError: msg });
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function bindSession(session: any, party: string) {
    sessionRef.current = session;
    setRemoteParty(party);

    session.on("progress", () => setCallState("ringing"));
    session.on("accepted", () => setCallState("connected"));
    session.on("confirmed", () => setCallState("connected"));

    session.on("ended", () => {
      sessionRef.current = null;
      setCallState("ended");
      setRemoteParty(null);
      setMutedState(false);
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
      patchDiag({ lastCallError: msg, iceGatheringState: null, iceConnectionState: null });
    });

    // Wire remote audio + ICE diagnostics
    session.on("peerconnection", (data: { peerconnection: RTCPeerConnection }) => {
      const pc = data.peerconnection;

      pc.addEventListener("track", (e: RTCTrackEvent) => {
        if (audioRef.current && e.streams[0]) {
          audioRef.current.srcObject = e.streams[0];
        }
      });

      pc.addEventListener("icegatheringstatechange", () => {
        patchDiag({ iceGatheringState: pc.iceGatheringState });
      });

      pc.addEventListener("iceconnectionstatechange", () => {
        patchDiag({ iceConnectionState: pc.iceConnectionState });
        if (pc.iceConnectionState === "failed") {
          const msg = hasTurnServer(undefined)
            ? "ICE connection failed."
            : "ICE connection failed. This usually means audio cannot traverse your NAT. Configure a TURN server.";
          setError(msg);
          patchDiag({ lastCallError: msg });
        }
        if (pc.iceConnectionState === "disconnected") {
          patchDiag({ lastCallError: "ICE disconnected — possible network interruption" });
        }
      });
    });
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

      try {
        const session = uaRef.current.call(`sip:${normalised}@${domain}`, {
          mediaConstraints: { audio: true, video: false },
          pcConfig: uaRef.current._configuration?.pcConfig ?? {},
        });
        bindSession(session, normalised);
      } catch (e: unknown) {
        setCallState("idle");
        const msg = e instanceof Error ? e.message : "Call failed";
        setError(msg);
        patchDiag({ lastCallError: msg });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [regState],
  );

  const answer = useCallback(() => {
    if (!sessionRef.current) return;
    try {
      sessionRef.current.answer({ mediaConstraints: { audio: true, video: false } });
      setCallState("connected");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Answer failed";
      setError(msg);
    }
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
  }, []);

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
