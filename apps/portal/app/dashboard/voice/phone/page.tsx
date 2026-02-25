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

  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

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
      try { registererRef.current?.unregister?.(); } catch {}
      try { uaRef.current?.stop?.(); } catch {}
    };
  }, []);

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
      } else if (text.includes("Terminated")) {
        setStatus("Ended");
        sessionRef.current = null;
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
          setIncoming(invitation);
          setStatus("Incoming");
          watchSession(invitation);
        }
      };

      const registerer = new window.SIP.Registerer(ua);
      await ua.start();
      await registerer.register();

      uaRef.current = ua;
      registererRef.current = registerer;
      setSipReady(true);
      setStatus("Registered");
    } catch {
      setStatus("Registration failed");
      setError("SIP registration failed. Verify WSS, domain, and one-time password.");
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
    sessionRef.current = null;
  }

  async function acceptIncoming() {
    if (!incoming) return;
    try {
      await incoming.accept();
      setIncoming(null);
      setStatus("Connected");
      attachRemoteAudio(incoming);
    } catch {
      setError("Failed to accept incoming call.");
    }
  }

  async function declineIncoming() {
    if (!incoming) return;
    try { await incoming.reject(); } catch {}
    setIncoming(null);
    setStatus("Ended");
  }

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
            <p>Ext. <strong>{info?.extensionNumber || "-"}</strong> / {info?.displayName || "Unassigned"} / SIP user {info?.sipUsername || "-"}</p>
            <p>WSS: {info?.sipWsUrl || "not configured"} / Domain: {info?.sipDomain || "not configured"}</p>
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
