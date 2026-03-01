"use client";

import Script from "next/script";
import { useEffect, useMemo, useRef, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type ExtInfo = {
  sipUsername: string;
  sipWsUrl: string | null;
  sipDomain: string | null;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
};

type EffectiveCfg = {
  ok: boolean;
  resolved: {
    sipWsUrl: string | null;
    sipDomain: string | null;
    outboundProxy: string | null;
    iceServers: Array<{ urls: string | string[]; username?: string | null; hasCredential?: boolean }>;
    webrtcRouteViaSbc: boolean;
    turnRequiredForMobile: boolean;
    mediaPolicy: string;
    mediaReliabilityGateEnabled: boolean;
    mediaTestStatus: string;
  };
  warnings: string[];
};

type DiagErr = {
  id: string;
  type: string;
  createdAt: string;
  code?: string;
  payload?: any;
};

declare global {
  interface Window {
    SIP?: any;
  }
}

export default function VoiceSbcTestPage() {
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);

  const [ext, setExt] = useState<ExtInfo | null>(null);
  const [cfg, setCfg] = useState<EffectiveCfg | null>(null);
  const [diag, setDiag] = useState<DiagErr[]>([]);

  const [banner, setBanner] = useState<{ kind: "ok" | "warn" | "fail"; text: string }>({ kind: "warn", text: "Idle" });
  const [wsLatencyMs, setWsLatencyMs] = useState<number | null>(null);
  const [wsResult, setWsResult] = useState("Not tested");

  const [sipResult, setSipResult] = useState("Not registered");
  const [sipError, setSipError] = useState("");
  const [testExtension, setTestExtension] = useState("1000");

  const [iceTypes, setIceTypes] = useState<string[]>([]);
  const [hasRelay, setHasRelay] = useState<boolean | null>(null);

  const uaRef = useRef<any>(null);
  const registererRef = useRef<any>(null);

  async function loadAll() {
    if (!token) return;
    const [extRes, cfgRes, diagRes] = await Promise.all([
      fetch(`${apiBase}/voice/me/extension`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/effective-config`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/diag/recent-errors`, { headers: { Authorization: `Bearer ${token}` } })
    ]);

    const extJson = await extRes.json().catch(() => null);
    const cfgJson = await cfgRes.json().catch(() => null);
    const diagJson = await diagRes.json().catch(() => []);

    if (extRes.ok && extJson) setExt(extJson);
    if (cfgRes.ok && cfgJson?.ok) setCfg(cfgJson);
    if (Array.isArray(diagJson)) setDiag(diagJson.slice(0, 20));

    if (!extRes.ok || !cfgRes.ok) {
      setBanner({ kind: "fail", text: "Unable to load SBC test prerequisites. Open Voice Settings to complete configuration." });
    }
  }

  useEffect(() => {
    loadAll().catch(() => setBanner({ kind: "fail", text: "Failed to load SBC test data." }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => {
      fetch(`${apiBase}/voice/diag/recent-errors`, { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((rows) => { if (Array.isArray(rows)) setDiag(rows.slice(0, 20)); })
        .catch(() => undefined);
    }, 10000);
    return () => clearInterval(t);
  }, [token]);

  async function testWsLatency() {
    const url = cfg?.resolved?.sipWsUrl || ext?.sipWsUrl;
    if (!url) {
      setWsResult("Missing SIP WSS URL. Configure it in Voice Settings.");
      setBanner({ kind: "warn", text: "Set SIP WSS URL or enable SBC routing first." });
      return;
    }

    setWsResult("Testing...");
    const started = performance.now();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (ok: boolean, msg: string) => {
        if (done) return;
        done = true;
        setWsResult(msg);
        setBanner({ kind: ok ? "ok" : "warn", text: ok ? "WebSocket probe succeeded" : "WebSocket probe responded but not fully open" });
        resolve();
      };

      try {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          try { ws.close(); } catch {}
          finish(false, "Timed out waiting for WS open");
        }, 7000);

        ws.onopen = () => {
          clearTimeout(timer);
          const latency = Math.round(performance.now() - started);
          setWsLatencyMs(latency);
          try { ws.close(); } catch {}
          finish(true, `WS open in ${latency} ms`);
        };
        ws.onerror = () => {
          clearTimeout(timer);
          finish(false, "WebSocket connect error");
        };
      } catch {
        finish(false, "Browser could not initialize WebSocket probe");
      }
    });
  }

  async function runIceProbe() {
    const iceServers = (ext?.iceServers || []) as RTCIceServer[];
    if (!iceServers.length) {
      setBanner({ kind: "warn", text: "No ICE servers configured. Add STUN/TURN in Voice Settings." });
      setIceTypes([]);
      setHasRelay(false);
      return;
    }

    const found = new Set<string>();
    let relay = false;

    await new Promise<void>((resolve) => {
      const pc = new RTCPeerConnection({ iceServers });
      const timer = setTimeout(() => {
        try { pc.close(); } catch {}
        resolve();
      }, 4500);

      pc.createDataChannel("probe");
      pc.onicecandidate = (ev) => {
        const c = ev.candidate?.candidate || "";
        const m = c.match(/ typ ([a-zA-Z0-9_]+)/);
        if (m?.[1]) {
          const t = m[1].toLowerCase();
          found.add(t);
          if (t === "relay") relay = true;
        }
      };

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .catch(() => undefined)
        .finally(() => {
          setTimeout(() => {
            clearTimeout(timer);
            try { pc.close(); } catch {}
            resolve();
          }, 2200);
        });
    });

    const list = Array.from(found.values());
    setIceTypes(list);
    setHasRelay(relay);
    setBanner({ kind: relay ? "ok" : "warn", text: relay ? "Relay candidate detected" : "No relay candidate detected" });
  }

  async function testSipRegister() {
    setSipError("");
    if (!window.SIP) {
      setSipResult("SIP.js not loaded");
      return;
    }

    const sipWsUrl = cfg?.resolved?.sipWsUrl || ext?.sipWsUrl;
    const sipDomain = cfg?.resolved?.sipDomain || ext?.sipDomain;
    if (!token || !ext?.sipUsername || !sipWsUrl || !sipDomain) {
      setSipResult("Missing SIP config. Open Voice Settings.");
      setBanner({ kind: "warn", text: "Complete SIP domain + WSS settings before register test." });
      return;
    }

    try {
      setSipResult("Preparing credentials...");
      const credRes = await fetch(`${apiBase}/voice/me/reset-sip-password`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      const cred = await credRes.json().catch(() => ({}));
      if (!credRes.ok || !cred?.sipPassword) throw new Error(String(cred?.error || "SIP_PASSWORD_RESET_FAILED"));

      const uri = window.SIP.UserAgent.makeURI(`sip:${ext.sipUsername}@${sipDomain}`);
      const ua = new window.SIP.UserAgent({
        uri,
        authorizationUsername: ext.sipUsername,
        authorizationPassword: cred.sipPassword,
        transportOptions: { server: sipWsUrl, connectionTimeout: 10 },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: { iceServers: (ext.iceServers || []) as any[] }
        }
      });

      const registerer = new window.SIP.Registerer(ua);
      await ua.start();
      await registerer.register();

      uaRef.current = ua;
      registererRef.current = registerer;
      setSipResult(`REGISTER OK via ${sipWsUrl}`);
      setBanner({ kind: "ok", text: "SIP register succeeded" });
    } catch (e: any) {
      const msg = String(e?.message || "WEB_SIP_REGISTER_FAILED");
      setSipError(msg);
      setSipResult("REGISTER FAILED");
      setBanner({ kind: "fail", text: "SIP register failed. Check WSS/domain/credentials." });
    }
  }

  async function callTestExtension() {
    const ua = uaRef.current;
    const sipDomain = cfg?.resolved?.sipDomain || ext?.sipDomain;
    if (!ua || !sipDomain || !testExtension.trim()) {
      setBanner({ kind: "warn", text: "Run SIP REGISTER first and provide a test extension." });
      return;
    }
    try {
      const target = window.SIP.UserAgent.makeURI(`sip:${testExtension.trim()}@${sipDomain}`);
      const inviter = new window.SIP.Inviter(ua, target);
      await inviter.invite();
      setBanner({ kind: "ok", text: `INVITE sent to ${testExtension.trim()}` });
    } catch {
      setBanner({ kind: "fail", text: "INVITE failed for test extension." });
    }
  }

  useEffect(() => {
    return () => {
      try { registererRef.current?.unregister?.(); } catch {}
      try { uaRef.current?.stop?.(); } catch {}
    };
  }, []);

  const bannerClass = banner.kind === "ok" ? "status-chip success" : banner.kind === "fail" ? "status-chip failed" : "status-chip pending";

  return (
    <div className="card">
      <Script src="https://unpkg.com/sip.js@0.21.2/dist/sip.min.js" strategy="afterInteractive" />
      <h1>Voice SBC Test</h1>
      <p>Interactive WebRTC and SBC diagnostics surface with live connection checks.</p>

      <p className={bannerClass} style={{ borderRadius: 2 }}>{banner.text}</p>

      <h3>Effective Config Preview</h3>
      <p>WSS: <strong>{cfg?.resolved?.sipWsUrl || ext?.sipWsUrl || "Set SIP WSS URL in Voice Settings"}</strong></p>
      <p>Domain: <strong>{cfg?.resolved?.sipDomain || ext?.sipDomain || "Set SIP domain or link PBX domain in Voice Settings"}</strong></p>
      <p>Policy: <strong>{cfg?.resolved?.mediaPolicy || "TURN_ONLY"}</strong> / TURN required: <strong>{cfg?.resolved?.turnRequiredForMobile ? "yes" : "no"}</strong></p>
      {(cfg?.warnings || []).length ? <ul>{cfg?.warnings.map((w) => <li key={w}>{w}</li>)}</ul> : null}

      <h3>Live WS Latency</h3>
      <button onClick={() => testWsLatency().catch(() => setWsResult("WS probe failed"))}>Test WS latency</button>
      <p>{wsResult}{wsLatencyMs !== null ? ` (${wsLatencyMs} ms)` : ""}</p>

      <h3>SIP REGISTER Result Panel</h3>
      <button onClick={() => testSipRegister().catch(() => setSipResult("REGISTER FAILED"))}>Test SIP REGISTER</button>
      <p><strong>{sipResult}</strong></p>
      {sipError ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{sipError}</p> : null}

      <h3>ICE Candidate + Relay Detection</h3>
      <button onClick={() => runIceProbe().catch(() => setBanner({ kind: "fail", text: "ICE probe failed" }))}>Run ICE probe</button>
      <p>Candidate types: <strong>{iceTypes.length ? iceTypes.join(", ") : "none yet"}</strong></p>
      <p>Relay detected: <strong>{hasRelay === null ? "unknown" : (hasRelay ? "yes" : "no")}</strong></p>

      <h3>Test Extension</h3>
      <input value={testExtension} onChange={(e) => setTestExtension(e.target.value)} placeholder="1000" />
      {" "}
      <button onClick={() => callTestExtension().catch(() => setBanner({ kind: "fail", text: "Extension call test failed" }))}>Send INVITE</button>

      <h3>Recent Diagnostic Events (auto-refresh)</h3>
      <button onClick={() => loadAll().catch(() => undefined)}>Refresh now</button>
      <table>
        <thead><tr><th>Type</th><th>Code</th><th>When</th></tr></thead>
        <tbody>
          {diag.map((e) => (
            <tr key={e.id}>
              <td>{e.type}</td>
              <td>{e.code || e?.payload?.code || "-"}</td>
              <td>{new Date(e.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {!diag.length ? <tr><td colSpan={3}>No diagnostics yet. Run tests to generate events.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}
