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
  webrtcRouteViaSbc?: boolean;
  sipWsUrl: string | null;
  sipDomain: string | null;
  outboundProxy: string | null;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  dtmfMode: "RFC2833" | "SIP_INFO";
};

type SbcStatus = {
  ok: boolean;
  route: { publicPath: string; publicSipWsUrl: string };
  services: { kamailio: string; rtpengine: string; pbxViaSbc: string };
  targets: { kamailioHost: string; rtpengineHost: string; pbxHost: string; pbxPort: number };
};

type WebrtcSettings = {
  ok: boolean;
  webrtcEnabled: boolean;
  webrtcRouteViaSbc: boolean;
  configuredSipWsUrl: string | null;
  effectiveSipWsUrl: string | null;
  effectiveSipDomain: string | null;
  outboundProxy: string | null;
  dtmfMode: "RFC2833" | "SIP_INFO";
  iceServerCount: number;
};

type DiagErr = {
  id: string;
  sessionId: string;
  type: string;
  createdAt: string;
  code: string;
  sipWsUrl: string | null;
  sipDomain: string | null;
};

declare global {
  interface Window {
    SIP?: any;
  }
}

export default function VoiceSbcTestPage() {
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);
  const [info, setInfo] = useState<ExtensionResponse | null>(null);
  const [settings, setSettings] = useState<WebrtcSettings | null>(null);
  const [sbcStatus, setSbcStatus] = useState<SbcStatus | null>(null);
  const [errors, setErrors] = useState<DiagErr[]>([]);
  const [status, setStatus] = useState("Idle");
  const [lastMsg, setLastMsg] = useState("");
  const [loopTarget, setLoopTarget] = useState("");

  const uaRef = useRef<any>(null);
  const registererRef = useRef<any>(null);
  const sessionRef = useRef<any>(null);
  const diagSessionIdRef = useRef<string | null>(null);

  async function diagStart() {
    if (!token || !info) return;
    const hasTurnCfg = (info.iceServers || []).some((srv) => {
      const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
      return urls.some((u) => String(u).toLowerCase().startsWith("turn:"));
    });
    const out = await fetch(`${apiBase}/voice/diag/session/start`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: diagSessionIdRef.current || undefined,
        platform: "WEB",
        appVersion: "portal-sbc-test",
        sipWsUrl: info.sipWsUrl || undefined,
        sipDomain: info.sipDomain || undefined,
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
    const [extRes, webrtcRes, sbcRes, errRes] = await Promise.all([
      fetch(`${apiBase}/voice/me/extension`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/webrtc/settings`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/sbc/status`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/diag/recent-errors`, { headers: { Authorization: `Bearer ${token}` } })
    ]);

    const extJson = await extRes.json().catch(() => null);
    const wrJson = await webrtcRes.json().catch(() => null);
    const sbcJson = await sbcRes.json().catch(() => null);
    const errJson = await errRes.json().catch(() => []);

    if (extRes.ok) setInfo(extJson);
    if (webrtcRes.ok) setSettings(wrJson);
    if (sbcRes.ok) setSbcStatus(sbcJson);
    if (Array.isArray(errJson)) setErrors(errJson.slice(0, 12));

    if (!extRes.ok) {
      setLastMsg(String(extJson?.error || "Unable to load extension config"));
    }
  }

  useEffect(() => {
    loadData().catch(() => setLastMsg("Failed to load SBC test data"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!info) return;
    diagStart().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  async function testWsHandshake() {
    try {
      const publicBase = apiBase.endsWith("/api") ? apiBase.slice(0, -4) : "https://app.connectcomunications.com";
      const out = await fetch(`${publicBase}/sip`, { method: "GET" });
      const wsProto = out.headers.get("sec-websocket-protocol");
      const wsVer = out.headers.get("sec-websocket-version");
      const msg = `WS probe status=${out.status}${wsProto ? ` protocol=${wsProto}` : ""}${wsVer ? ` version=${wsVer}` : ""}`;
      setLastMsg(msg);
      setStatus(out.ok ? "WS Probe OK" : "WS Probe Response");
      await diagEvent("WS_CONNECTED", { probeStatus: out.status, wsProtocol: wsProto || undefined, wsVersion: wsVer || undefined });
    } catch (e: any) {
      const code = String(e?.message || "WEB_WS_PROBE_FAILED").slice(0, 120);
      setLastMsg(`WS probe failed: ${code}`);
      setStatus("WS Probe Failed");
      await diagEvent("WS_DISCONNECTED", { reason: code, sipWsUrl: info?.sipWsUrl || undefined, sipDomain: info?.sipDomain || undefined });
      await diagEvent("ERROR", { code: "WEB_WS_PROBE_FAILED", reason: code, sipWsUrl: info?.sipWsUrl || undefined, sipDomain: info?.sipDomain || undefined });
    }
  }

  async function testSipRegister() {
    if (!window.SIP) {
      setLastMsg("SIP.js not loaded yet");
      return;
    }
    if (!token || !info?.sipWsUrl || !info?.sipDomain) {
      setLastMsg("Missing SIP config (WSS URL/domain)");
      return;
    }

    try {
      setStatus("Preparing credentials");
      const credRes = await fetch(`${apiBase}/voice/me/reset-sip-password`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      const cred = await credRes.json().catch(() => ({}));
      if (!credRes.ok || !cred?.sipPassword) {
        throw new Error(String(cred?.error || "SIP_PASSWORD_RESET_FAILED"));
      }

      setStatus("Registering via /sip");
      const uri = window.SIP.UserAgent.makeURI(`sip:${info.sipUsername}@${info.sipDomain}`);
      const ua = new window.SIP.UserAgent({
        uri,
        authorizationUsername: info.sipUsername,
        authorizationPassword: cred.sipPassword,
        transportOptions: {
          server: info.sipWsUrl,
          connectionTimeout: 10,
          traceSip: false
        },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: { iceServers: info.iceServers || [] }
        }
      });

      const registerer = new window.SIP.Registerer(ua);
      await ua.start();
      await registerer.register();

      uaRef.current = ua;
      registererRef.current = registerer;

      setStatus("REGISTER OK");
      setLastMsg(`Registered through ${info.sipWsUrl}`);
      await diagEvent("SIP_REGISTER", { route: "SBC", sipWsUrl: info.sipWsUrl, sipDomain: info.sipDomain });
    } catch (e: any) {
      const code = String(e?.message || "WEB_SIP_REGISTER_FAILED").slice(0, 120);
      setStatus("REGISTER FAILED");
      setLastMsg(`SIP register failed: ${code}`);
      await diagEvent("ERROR", { code: "WEB_SIP_REGISTER_FAILED", reason: code, sipWsUrl: info?.sipWsUrl || undefined, sipDomain: info?.sipDomain || undefined });
      await diagEvent("WS_DISCONNECTED", { reason: code, sipWsUrl: info?.sipWsUrl || undefined, sipDomain: info?.sipDomain || undefined });
    }
  }

  async function testCallLoop() {
    if (!uaRef.current || !info?.sipDomain) {
      setLastMsg("Run Test SIP REGISTER first");
      return;
    }
    if (!loopTarget.trim()) {
      setLastMsg("Enter a target extension/number for call loop test");
      return;
    }

    try {
      setStatus("Calling loop target");
      const target = window.SIP.UserAgent.makeURI(`sip:${loopTarget.trim()}@${info.sipDomain}`);
      const inviter = new window.SIP.Inviter(uaRef.current, target);
      sessionRef.current = inviter;
      await inviter.invite();
      await diagEvent("CALL_CONNECTED", { target: loopTarget.trim() });
      setStatus("CALL INVITED");
      setLastMsg(`Invite sent to ${loopTarget.trim()}`);
    } catch (e: any) {
      const code = String(e?.message || "WEB_CALL_LOOP_FAILED").slice(0, 120);
      setStatus("CALL LOOP FAILED");
      setLastMsg(`Call loop failed: ${code}`);
      await diagEvent("ERROR", { code: "WEB_CALL_LOOP_FAILED", reason: code });
    }
  }

  async function cleanupSip() {
    try { await registererRef.current?.unregister?.(); } catch {}
    try { await sessionRef.current?.bye?.(); } catch {}
    try { await uaRef.current?.stop?.(); } catch {}
    await diagEvent("SIP_UNREGISTER", { reason: "manual_cleanup" });
    setStatus("Idle");
  }

  return (
    <>
      <Script src="https://unpkg.com/sip.js@0.21.2/lib/umd/sip.js" strategy="afterInteractive" />
      <div className="card">
        <h1>Voice SBC Test</h1>
        <p className="status-chip pending" style={{ borderRadius: 2 }}>Status: {status}</p>
        {lastMsg ? <p>{lastMsg}</p> : null}

        <h3>Effective WebRTC Config</h3>
        <p>WSS: <strong>{settings?.effectiveSipWsUrl || info?.sipWsUrl || "not configured"}</strong></p>
        <p>Domain: <strong>{settings?.effectiveSipDomain || info?.sipDomain || "not configured"}</strong></p>
        <p>Outbound Proxy: <strong>{settings?.outboundProxy || info?.outboundProxy || "none"}</strong></p>
        <p>ICE Servers: <strong>{settings?.iceServerCount ?? info?.iceServers?.length ?? 0}</strong></p>
        <p>Route via SBC toggle: <strong>{settings?.webrtcRouteViaSbc ? "enabled" : "disabled"}</strong></p>

        <h3>SBC Status (Server Probe)</h3>
        <p>Kamailio: <strong>{sbcStatus?.services?.kamailio || "unknown"}</strong> / RTPengine: <strong>{sbcStatus?.services?.rtpengine || "unknown"}</strong> / PBX via SBC: <strong>{sbcStatus?.services?.pbxViaSbc || "unknown"}</strong></p>
        <p>Route: <strong>{sbcStatus?.route?.publicSipWsUrl || "wss://app.connectcomunications.com/sip"}</strong></p>

        <h3>Actions</h3>
        <button onClick={() => testWsHandshake().catch(() => undefined)}>Test WS handshake</button>{" "}
        <button onClick={() => testSipRegister().catch(() => undefined)}>Test SIP REGISTER</button>{" "}
        <input value={loopTarget} onChange={(e) => setLoopTarget(e.target.value)} placeholder="Loop target extension" />{" "}
        <button onClick={() => testCallLoop().catch(() => undefined)}>Test call loop</button>{" "}
        <button onClick={() => cleanupSip().catch(() => undefined)}>Cleanup SIP</button>{" "}
        <button onClick={() => loadData().catch(() => undefined)}>Refresh</button>

        <h3>Recent VoiceDiag Error Signals</h3>
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Type</th>
              <th>Code</th>
              <th>WSS</th>
              <th>Domain</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.createdAt).toLocaleString()}</td>
                <td>{e.type}</td>
                <td>{e.code}</td>
                <td>{e.sipWsUrl || "-"}</td>
                <td>{e.sipDomain || "-"}</td>
              </tr>
            ))}
            {errors.length === 0 ? (
              <tr>
                <td colSpan={5}>No recent diagnostics signals.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </>
  );
}