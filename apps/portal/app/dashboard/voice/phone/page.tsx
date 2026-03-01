"use client";

import Script from "next/script";
import { useEffect, useMemo, useRef, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type ExtensionResponse = {
  extensionId: string;
  pbxExtensionLinkId: string;
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

type CallRow = {
  id: string;
  direction: string;
  fromNumber: string;
  toNumber: string;
  startedAt: string;
  durationSec: number;
  disposition: string;
};

declare global {
  interface Window {
    SIP?: any;
  }
}

export default function VoicePhonePage() {
  const [info, setInfo] = useState<ExtensionResponse | null>(null);
  const [recentCalls, setRecentCalls] = useState<CallRow[]>([]);
  const [status, setStatus] = useState("Idle");
  const [dial, setDial] = useState("");
  const [mute, setMute] = useState(false);
  const [hold, setHold] = useState(false);
  const [sipReady, setSipReady] = useState(false);
  const [oneTimePassword, setOneTimePassword] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<any>(null);
  const [error, setError] = useState<string>("");

  const uaRef = useRef<any>(null);
  const registererRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const diagSessionIdRef = useRef<string | null>(null);
  const incomingPbxCallIdRef = useRef<string | null>(null);

  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  async function diagStart() {
    if (!token) return;
    const hasTurnCfg = (info?.iceServers || []).some((srv) => {
      const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
      return urls.some((u) => String(u).toLowerCase().startsWith("turn:"));
    });
    const out = await fetch(`${apiBase}/voice/diag/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: diagSessionIdRef.current || undefined,
        platform: "WEB",
        appVersion: "portal-web",
        sipWsUrl: info?.sipWsUrl || undefined,
        sipDomain: info?.sipDomain || undefined,
        iceHasTurn: hasTurnCfg,
        lastRegState: status
      })
    }).then((r) => r.json()).catch(() => null);
    if (out?.sessionId) diagSessionIdRef.current = String(out.sessionId);
  }

  async function diagEvent(type: string, payload?: any) {
    if (!token || !diagSessionIdRef.current) return;
    await fetch(`${apiBase}/voice/diag/event`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId: diagSessionIdRef.current, type, payload: payload || {} })
    }).catch(() => undefined);
  }

  async function loadData() {
    if (!token) return;
    const [extRes, callsRes] = await Promise.all([
      fetch(`${apiBase}/voice/me/extension`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/calls`, { headers: { Authorization: `Bearer ${token}` } })
    ]);

    if (!extRes.ok) {
      const json = await extRes.json().catch(() => ({ error: "Failed to load extension" }));
      setError(json?.error || "Failed to load extension");
      return;
    }

    const extJson = await extRes.json();
    setInfo(extJson);

    if (callsRes.ok) {
      const rows = await callsRes.json();
      if (Array.isArray(rows)) setRecentCalls(rows.slice(0, 12));
    }
  }

  useEffect(() => {
    loadData().catch(() => setError("Unable to load phone data"));
    return () => {
      diagEvent("SIP_UNREGISTER", { reason: "unmount" }).catch(() => undefined);
      diagEvent("WS_DISCONNECTED", { reason: "unmount" }).catch(() => undefined);
      try { registererRef.current?.unregister?.(); } catch {}
      try { uaRef.current?.stop?.(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!info || !token) return;
    diagStart().catch(() => undefined);
    const hasTurnCfg = (info.iceServers || []).some((srv) => {
      const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
      return urls.some((u) => String(u).toLowerCase().startsWith("turn:"));
    });
    const t0 = Date.now();
    diagEvent("ICE_GATHERING", { hasTurn: hasTurnCfg, iceServerCount: info.iceServers?.length || 0 }).catch(() => undefined);
    diagEvent("TURN_TEST_RESULT", { ok: hasTurnCfg, hasRelay: hasTurnCfg, durationMs: Date.now() - t0 }).catch(() => undefined);
  }, [info, token]);

  function attachRemoteAudio(session: any) {
    try {
      const pc = session.sessionDescriptionHandler?.peerConnection;
      if (!pc || !remoteAudioRef.current) return;
      const stream = new MediaStream();
      pc.getReceivers().forEach((r: any) => {
        if (r.track) stream.addTrack(r.track);
      });
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.play().catch(() => undefined);
    } catch {}
  }

  function extractInvitePbxCallId(invitation: any): string | null {
    const fromRequest = String(invitation?.request?.callId || invitation?.request?.headers?.["Call-ID"]?.[0]?.raw || "").trim();
    if (fromRequest) return fromRequest;
    const fromSession = String(invitation?.id || invitation?.sessionId || "").trim();
    return fromSession || null;
  }

  function watchSession(session: any) {
    sessionRef.current = session;
    if (!session?.stateChange?.addListener) return;
    session.stateChange.addListener((newState: any) => {
      const text = String(newState || "");
      if (text.includes("Initial")) setStatus("Calling");
      else if (text.includes("Establishing")) setStatus("Ringing");
      else if (text.includes("Established")) {
        setStatus("Connected");
        attachRemoteAudio(session);
        diagEvent("CALL_CONNECTED", { state: text }).catch(() => undefined);
        diagEvent("ICE_SELECTED_PAIR", { candidateType: hasTurn ? "relay_or_mixed" : "host_or_srflx" }).catch(() => undefined);
      } else if (text.includes("Terminated")) {
        setStatus("Ended");
        sessionRef.current = null;
        diagEvent("CALL_ENDED", { state: text }).catch(() => undefined);
      }
    });
  }

  async function registerPhone() {
    setError("");
    if (!window.SIP) {
      setError("SIP.js not loaded yet.");
      return;
    }
    if (!info?.sipWsUrl || !info?.sipDomain) {
      setError("Missing WebRTC config (SIP WSS URL/domain).");
      return;
    }
    if (!oneTimePassword) {
      setError("Reset SIP password first (one-time password required).");
      return;
    }

    try {
      setStatus("Registering");
      const uri = window.SIP.UserAgent.makeURI(`sip:${info.sipUsername}@${info.sipDomain}`);
      const ua = new window.SIP.UserAgent({
        uri,
        authorizationUsername: info.sipUsername,
        authorizationPassword: oneTimePassword,
        transportOptions: { server: info.sipWsUrl },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: { iceServers: info.iceServers || [] }
        }
      });

      ua.delegate = {
        onInvite: (invitation: any) => {
          const pbxCallId = extractInvitePbxCallId(invitation);
          incomingPbxCallIdRef.current = pbxCallId;
          setIncoming(invitation);
          setStatus("Incoming");
          watchSession(invitation);
          diagEvent("INCOMING_INVITE", { source: "sip_delegate", pbxCallId: pbxCallId || undefined }).catch(() => undefined);
        }
      };

      const registerer = new window.SIP.Registerer(ua);
      await ua.start();
      await registerer.register();

      uaRef.current = ua;
      registererRef.current = registerer;
      setSipReady(true);
      setStatus("Registered");
      diagEvent("SIP_REGISTER", { sipReady: true }).catch(() => undefined);
      diagEvent("WS_CONNECTED", { sipReady: true }).catch(() => undefined);
    } catch {
      setStatus("Registration failed");
      setError("SIP registration failed. Verify WSS, domain, and one-time password.");
      diagEvent("ERROR", { code: "WEB_SIP_REGISTER_FAILED" }).catch(() => undefined);
      diagEvent("WS_DISCONNECTED", { reason: "register_failed" }).catch(() => undefined);
    }
  }

  async function resetSipPassword() {
    setError("");
    if (!token) return;
    const res = await fetch(`${apiBase}/voice/me/reset-sip-password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json?.sipPassword) {
      setError(json?.error || "Failed to reset SIP password");
      return;
    }
    setOneTimePassword(json.sipPassword);
    setStatus("One-time credential issued");
    if (json?.provisioning) {
      setInfo((prev) => prev ? ({
        ...prev,
        sipWsUrl: json.provisioning.sipWsUrl || prev.sipWsUrl,
        sipDomain: json.provisioning.sipDomain || prev.sipDomain,
        outboundProxy: json.provisioning.outboundProxy || prev.outboundProxy,
        iceServers: json.provisioning.iceServers || prev.iceServers
      }) : prev);
    }
  }

  async function placeCall() {
    if (!uaRef.current || !info?.sipDomain || !dial) return;
    try {
      const target = window.SIP.UserAgent.makeURI(`sip:${dial}@${info.sipDomain}`);
      const inviter = new window.SIP.Inviter(uaRef.current, target);
      watchSession(inviter);
      setStatus("Calling");
      await inviter.invite();
    } catch {
      setError("Unable to place call.");
      setStatus("Call failed");
    }
  }

  async function hangup() {
    const s = sessionRef.current;
    if (!s) return;
    try {
      await s.bye?.();
    } catch {
      try { await s.cancel?.(); } catch {}
      try { await s.dispose?.(); } catch {}
    }
    setStatus("Ended");
    incomingPbxCallIdRef.current = null;
    sessionRef.current = null;
  }

  async function acceptIncoming() {
    if (!incoming) return;
    try {
      await incoming.accept();
      setIncoming(null);
      incomingPbxCallIdRef.current = null;
      setStatus("Connected");
      diagEvent("ANSWER_TAPPED", { action: "ACCEPT" }).catch(() => undefined);
      attachRemoteAudio(incoming);
    } catch {
      setError("Failed to accept incoming call.");
    }
  }

  async function declineIncoming() {
    if (!incoming) return;
    try { await incoming.reject(); } catch {}
    setIncoming(null);
    incomingPbxCallIdRef.current = null;
    setStatus("Ended");
    diagEvent("ANSWER_TAPPED", { action: "DECLINE" }).catch(() => undefined);
    diagEvent("CALL_ENDED", { action: "DECLINE" }).catch(() => undefined);
  }


  useEffect(() => {
    if (!token) return;
    const t = setInterval(async () => {
      if (!incoming || !incomingPbxCallIdRef.current) return;
      const pending = await fetch(`${apiBase}/mobile/call-invites/pending`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      const stillPending = Array.isArray(pending)
        ? pending.some((x: any) => String(x?.pbxCallId || "") === String(incomingPbxCallIdRef.current || ""))
        : false;
      if (stillPending) return;
      try { await incoming.reject?.(); } catch {}
      setIncoming(null);
      incomingPbxCallIdRef.current = null;
      setStatus("Ended");
    }, 2000);
    return () => clearInterval(t);
  }, [token, incoming]);

  function sendDtmf(digit: string) {
    const s = sessionRef.current;
    if (!s) return;
    try {
      s.info?.({ contentType: "application/dtmf-relay", body: `Signal=${digit}\\r\\nDuration=250` });
    } catch {
      setError("DTMF failed");
    }
  }

  function toggleMute() {
    const sdh = sessionRef.current?.sessionDescriptionHandler;
    try {
      const sender = sdh?.peerConnection?.getSenders?.()?.find((x: any) => x.track?.kind === "audio");
      if (!sender?.track) return;
      sender.track.enabled = mute;
      setMute((m) => !m);
    } catch {}
  }

  async function toggleHold() {
    const s = sessionRef.current;
    if (!s) return;
    try {
      await s.invite?.({ sessionDescriptionHandlerOptions: { hold: !hold } });
      setHold((h) => !h);
    } catch {
      setError("Hold toggle is not supported by current PBX/SIP profile.");
    }
  }

  const statusClass = status.toLowerCase().includes("fail") || status.toLowerCase().includes("end")
    ? "status-chip failed"
    : status.toLowerCase().includes("register") || status.toLowerCase().includes("connect")
      ? "status-chip live"
      : "status-chip pending";

  const hasTurn = (info?.iceServers || []).some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => String(u).toLowerCase().startsWith("turn:"));
  });

  return (
    <>
      <Script src="https://unpkg.com/sip.js@0.21.2/lib/umd/sip.js" strategy="afterInteractive" />
      <div className="phone-layout">
        <div className="phone-main">
          <div className="card">
            <div className="page-head">
              <h1>Switchboard</h1>
              <span className={statusClass}>{status}</span>
            </div>
            {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}
            {!hasTurn ? <p className="status-chip pending" style={{ borderRadius: 2 }}>Mobile networks often require TURN for reliable audio.</p> : null}
            <p>Ext. <strong>{info?.extensionNumber || "-"}</strong> / {info?.displayName || "Unassigned"} / SIP user {info?.sipUsername || "-"}</p>
            <p>WSS: {info?.sipWsUrl || "Set in Voice Settings"} / Domain: {info?.sipDomain || "Set in Voice Settings"}</p>
            <button onClick={resetSipPassword}>Reset SIP Password</button>
            <button onClick={registerPhone} disabled={!oneTimePassword}>Register SIP</button>
            <p>SIP secret is shown once and kept in current tab memory only.</p>
          </div>

          {incoming ? (
            <div className="card">
              <div className="page-head">
                <h3>Incoming Call</h3>
                <span className="status-chip pending">Ringing</span>
              </div>
              <button onClick={acceptIncoming}>Accept</button>
              <button onClick={declineIncoming}>Decline</button>
            </div>
          ) : null}

          <div className="card">
            <h3>Recent Calls</h3>
            <table>
              <thead><tr><th>Time</th><th>Caller</th><th>Callee</th><th>Direction</th><th>Duration</th><th>Details</th></tr></thead>
              <tbody>
                {recentCalls.map((c) => (
                  <tr key={c.id}>
                    <td>{new Date(c.startedAt).toLocaleString()}</td>
                    <td>{c.fromNumber}</td>
                    <td>{c.toNumber}</td>
                    <td>{c.direction}</td>
                    <td>{c.durationSec}s</td>
                    <td>{c.disposition || "-"}</td>
                  </tr>
                ))}
                {!recentCalls.length ? <tr><td colSpan={6}>No calls yet.</td></tr> : null}
              </tbody>
            </table>
            <audio ref={remoteAudioRef} autoPlay playsInline />
          </div>
        </div>

        <aside className="softphone-panel">
          <div>
            <h3 style={{ color: "#ecf1f7", marginBottom: 4 }}>Enter number</h3>
            <input value={dial} onChange={(e) => setDial(e.target.value)} placeholder="Enter name or number" />
          </div>

          <div className="softphone-actions">
            <button onClick={placeCall} disabled={!sipReady || !dial}>Call</button>
            <button onClick={hangup}>Hangup</button>
            <button onClick={toggleMute}>{mute ? "Unmute" : "Mute"}</button>
            <button onClick={toggleHold}>{hold ? "Resume" : "Hold"}</button>
          </div>

          <div className="dial-grid">
            {"123456789*0#".split("").map((d) => (
              <button key={d} onClick={() => sendDtmf(d)}>{d}</button>
            ))}
          </div>
        </aside>
      </div>
    </>
  );
}
