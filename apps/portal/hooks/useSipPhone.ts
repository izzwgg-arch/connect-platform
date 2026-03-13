"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../services/apiClient";

export type RegState = "idle" | "registering" | "registered" | "failed";
export type CallState = "idle" | "dialing" | "ringing" | "connected" | "ended";

type Extension = {
  sipUsername: string;
  sipPassword: string;
  sipWsUrl: string;
  sipDomain: string;
  outboundProxy?: string | null;
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  dtmfMode?: "RFC2833" | "SIP_INFO";
};

type SipPhoneState = {
  regState: RegState;
  callState: CallState;
  remoteParty: string | null;
  extension: Extension | null;
  error: string | null;
  webrtcEnabled: boolean;
};

type SipPhoneActions = {
  dial: (target: string) => void;
  answer: () => void;
  hangup: () => void;
  setMute: (mute: boolean) => void;
  sendDtmf: (digit: string) => void;
};

export type UseSipPhoneReturn = SipPhoneState & SipPhoneActions;

const isWebRtcCapable = () =>
  typeof window !== "undefined" &&
  typeof RTCPeerConnection !== "undefined" &&
  typeof navigator !== "undefined" &&
  !!navigator.mediaDevices;

export function useSipPhone(): UseSipPhoneReturn {
  const [regState, setRegState] = useState<RegState>("idle");
  const [callState, setCallState] = useState<CallState>("idle");
  const [remoteParty, setRemoteParty] = useState<string | null>(null);
  const [extension, setExtension] = useState<Extension | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webrtcEnabled] = useState(isWebRtcCapable);

  const uaRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Attach hidden audio element for remote audio stream
  useEffect(() => {
    if (typeof window === "undefined") return;
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.style.display = "none";
    document.body.appendChild(audio);
    audioRef.current = audio;
    return () => { audio.remove(); };
  }, []);

  // Fetch extension credentials and register on mount
  useEffect(() => {
    if (!webrtcEnabled) return;
    let cancelled = false;

    (async () => {
      try {
        const ext = await apiGet<Extension>("/voice/me/extension");
        if (cancelled) return;
        if (!ext?.sipWsUrl || !ext?.sipDomain || !ext?.sipUsername || !ext?.sipPassword) {
          setError("Incomplete SIP credentials — check your extension assignment.");
          return;
        }
        setExtension(ext);
        await startUA(ext);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load SIP credentials");
      }
    })();

    return () => {
      cancelled = true;
      uaRef.current?.stop();
      uaRef.current = null;
    };
  }, [webrtcEnabled]);

  const startUA = async (ext: Extension) => {
    const JsSIP = (await import("jssip")).default as any;
    JsSIP.debug.disable("JsSIP:*");

    const socket = new JsSIP.WebSocketInterface(ext.sipWsUrl);
    const uaCfg: any = {
      sockets: [socket],
      uri: `sip:${ext.sipUsername}@${ext.sipDomain}`,
      password: ext.sipPassword,
      register: true,
      session_timers: false,
      user_agent: "ConnectComms-Portal/1.0",
      pcConfig: {
        iceServers: ext.iceServers?.length ? ext.iceServers : [{ urls: "stun:stun.l.google.com:19302" }]
      }
    };
    if (ext.outboundProxy) uaCfg.outbound_proxy_set = ext.outboundProxy;

    const ua = new JsSIP.UA(uaCfg);
    uaRef.current = ua;

    setRegState("registering");

    ua.on("registered", () => setRegState("registered"));
    ua.on("unregistered", () => setRegState("idle"));
    ua.on("registrationFailed", (e: any) => {
      setRegState("failed");
      setError(`Registration failed: ${e?.cause || "unknown"}`);
    });

    ua.on("newRTCSession", (e: any) => {
      const session = e.session as any;
      sessionRef.current = session;
      const party = session?.remote_identity?.uri?.user || session?.remote_identity?.display_name || "";
      setRemoteParty(party || null);

      if (e.originator === "remote") {
        setCallState("ringing");
      }

      session.on("progress", () => setCallState("ringing"));
      session.on("confirmed", () => setCallState("connected"));
      session.on("ended", () => {
        if (sessionRef.current === session) sessionRef.current = null;
        setCallState("ended");
        setRemoteParty(null);
        setTimeout(() => setCallState("idle"), 1500);
      });
      session.on("failed", () => {
        if (sessionRef.current === session) sessionRef.current = null;
        setCallState("ended");
        setRemoteParty(null);
        setTimeout(() => setCallState("idle"), 1500);
      });

      // Wire remote audio stream
      session.connection?.addEventListener("track", (ev: RTCTrackEvent) => {
        if (audioRef.current && ev.streams[0]) {
          audioRef.current.srcObject = ev.streams[0];
        }
      });
    });

    ua.start();
  };

  const dial = useCallback((target: string) => {
    const ua = uaRef.current;
    const ext = extension;
    if (!ua || !ext) { setError("SIP not registered"); return; }
    setCallState("dialing");
    setRemoteParty(target);
    const session = ua.call(`sip:${target}@${ext.sipDomain}`, {
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: ext.iceServers?.length ? ext.iceServers : [{ urls: "stun:stun.l.google.com:19302" }]
      }
    });
    sessionRef.current = session;
  }, [extension]);

  const answer = useCallback(() => {
    sessionRef.current?.answer?.({ mediaConstraints: { audio: true, video: false } });
  }, []);

  const hangup = useCallback(() => {
    sessionRef.current?.terminate?.();
    sessionRef.current = null;
    setCallState("idle");
    setRemoteParty(null);
  }, []);

  const setMute = useCallback((mute: boolean) => {
    if (mute) sessionRef.current?.mute?.({ audio: true });
    else sessionRef.current?.unmute?.({ audio: true });
  }, []);

  const sendDtmf = useCallback((digit: string) => {
    sessionRef.current?.sendDTMF?.(digit);
  }, []);

  return {
    regState, callState, remoteParty, extension, error, webrtcEnabled,
    dial, answer, hangup, setMute, sendDtmf
  };
}
