"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

type EffectiveConfig = {
  ok: boolean;
  resolved: {
    sipWsUrl: string | null;
    sipDomain: string | null;
    outboundProxy: string | null;
    iceServers: Array<{ urls: string | string[]; username?: string | null; hasCredential?: boolean }>;
    webrtcRouteViaSbc: boolean;
    turnRequiredForMobile: boolean;
    mediaPolicy: "TURN_ONLY" | "RTPENGINE_PREFERRED";
    mediaReliabilityGateEnabled: boolean;
    mediaTestStatus: string;
    mediaTestedAt: string | null;
  };
  configured: {
    sipWsUrl: string | null;
    sipDomain: string | null;
    outboundProxy: string | null;
    iceServers: Array<{ urls: string | string[] }>;
    linkedPbxDomain: string | null;
  };
  warnings: string[];
};

export default function VoiceSettingsPage() {
  const token = useMemo(() => (typeof window === "undefined" ? "" : localStorage.getItem("token") || ""), []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [effective, setEffective] = useState<EffectiveConfig | null>(null);

  const [sipDomain, setSipDomain] = useState("");
  const [sipWsUrl, setSipWsUrl] = useState("");
  const [outboundProxy, setOutboundProxy] = useState("");
  const [iceJson, setIceJson] = useState("[]");
  const [webrtcRouteViaSbc, setWebrtcRouteViaSbc] = useState(false);
  const [turnRequiredForMobile, setTurnRequiredForMobile] = useState(false);
  const [mediaPolicy, setMediaPolicy] = useState<"TURN_ONLY" | "RTPENGINE_PREFERRED">("TURN_ONLY");

  const [iceParseError, setIceParseError] = useState("");

  async function loadConfig() {
    if (!token) return;
    setLoading(true);
    setError("");
    const res = await fetch(`${apiBase}/voice/effective-config`, { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      setError(String(json?.error || "Unable to load effective voice config"));
      setLoading(false);
      return;
    }

    setEffective(json as EffectiveConfig);
    setSipDomain(json.configured?.sipDomain || "");
    setSipWsUrl(json.configured?.sipWsUrl || "");
    setOutboundProxy(json.configured?.outboundProxy || "");
    setIceJson(JSON.stringify(json.configured?.iceServers || [], null, 2));
    setWebrtcRouteViaSbc(!!json.resolved?.webrtcRouteViaSbc);
    setTurnRequiredForMobile(!!json.resolved?.turnRequiredForMobile);
    setMediaPolicy(json.resolved?.mediaPolicy === "RTPENGINE_PREFERRED" ? "RTPENGINE_PREFERRED" : "TURN_ONLY");
    setLoading(false);
  }

  useEffect(() => {
    loadConfig().catch(() => setError("Failed to load voice settings"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function validateIceJson(raw: string): any[] | null {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setIceParseError("ICE servers must be a JSON array.");
        return null;
      }
      for (const row of parsed) {
        if (!row || typeof row !== "object" || !row.urls) {
          setIceParseError("Each ICE server entry must include urls.");
          return null;
        }
      }
      setIceParseError("");
      return parsed;
    } catch {
      setIceParseError("ICE servers JSON is invalid.");
      return null;
    }
  }

  async function save() {
    if (!token) return;
    setSaving(true);
    setMsg("");
    setError("");

    const iceServers = validateIceJson(iceJson);
    if (!iceServers) {
      setSaving(false);
      return;
    }

    const payload = {
      sipDomain: sipDomain.trim() || null,
      sipWsUrl: sipWsUrl.trim() || null,
      outboundProxy: outboundProxy.trim() || null,
      iceServers,
      webrtcRouteViaSbc,
      turnRequiredForMobile,
      mediaPolicy
    };

    const res = await fetch(`${apiBase}/voice/webrtc/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });

    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(String(out?.error || "Failed to save voice settings"));
      setSaving(false);
      return;
    }

    setMsg("Voice settings updated.");
    await loadConfig();
    setSaving(false);
  }

  const actionableWarnings: string[] = [];
  if (!sipWsUrl.trim() && !webrtcRouteViaSbc) actionableWarnings.push("Set SIP WSS URL or enable 'Route WebRTC via SBC' to use /sip fallback.");
  if (!sipDomain.trim()) actionableWarnings.push("Set SIP domain or link a PBX domain before SIP registration tests.");
  if (iceParseError) actionableWarnings.push(iceParseError);

  return (
    <div className="card">
      <h1>Voice Settings</h1>
      <p>Configure tenant WebRTC behavior and preview effective resolved voice config.</p>
      {loading ? <p>Loading...</p> : null}
      {msg ? <p className="status-chip pending" style={{ borderRadius: 2 }}>{msg}</p> : null}
      {error ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{error}</p> : null}

      <h3>Editable WebRTC Settings</h3>
      <label>SIP Domain</label>
      <input value={sipDomain} onChange={(e) => setSipDomain(e.target.value)} placeholder="pbx.example.com" style={{ width: "100%" }} />

      <label style={{ marginTop: 8 }}>SIP WSS URL</label>
      <input value={sipWsUrl} onChange={(e) => setSipWsUrl(e.target.value)} placeholder="wss://app.connectcomunications.com/sip" style={{ width: "100%" }} />

      <label style={{ marginTop: 8 }}>Outbound Proxy</label>
      <input value={outboundProxy} onChange={(e) => setOutboundProxy(e.target.value)} placeholder="sip:proxy.example.com;transport=tcp" style={{ width: "100%" }} />

      <label style={{ marginTop: 8 }}>ICE Servers (JSON)</label>
      <textarea rows={8} style={{ width: "100%", fontFamily: "monospace" }} value={iceJson} onChange={(e) => setIceJson(e.target.value)} />
      {iceParseError ? <p className="status-chip failed" style={{ borderRadius: 2 }}>{iceParseError}</p> : null}

      <div style={{ marginTop: 8 }}>
        <label><input type="checkbox" checked={webrtcRouteViaSbc} onChange={(e) => setWebrtcRouteViaSbc(e.target.checked)} /> Route WebRTC via SBC</label>
      </div>
      <div>
        <label><input type="checkbox" checked={turnRequiredForMobile} onChange={(e) => setTurnRequiredForMobile(e.target.checked)} /> Require TURN for mobile answer path</label>
      </div>

      <div style={{ marginTop: 8 }}>
        <label>Media Policy </label>
        <select value={mediaPolicy} onChange={(e) => setMediaPolicy(e.target.value === "RTPENGINE_PREFERRED" ? "RTPENGINE_PREFERRED" : "TURN_ONLY") }>
          <option value="TURN_ONLY">TURN_ONLY</option>
          <option value="RTPENGINE_PREFERRED">RTPENGINE_PREFERRED</option>
        </select>
      </div>

      <div style={{ marginTop: 12 }}>
        <button onClick={() => save().catch(() => setError("Failed to save"))} disabled={saving}>{saving ? "Saving..." : "Save Voice Settings"}</button>
        {" "}
        <button onClick={() => loadConfig().catch(() => setError("Failed to reload"))}>Reload</button>
      </div>

      <h3 style={{ marginTop: 16 }}>Inline Warnings</h3>
      {actionableWarnings.length ? (
        <ul>
          {actionableWarnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      ) : (
        <p>All required fields look good.</p>
      )}

      <h3>Effective Resolved Preview</h3>
      <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(effective?.resolved || {}, null, 2)}</pre>
      <h4>Backend Resolution Warnings</h4>
      <ul>
        {(effective?.warnings || ["No backend warnings"]).map((w) => <li key={w}>{w}</li>)}
      </ul>
    </div>
  );
}
