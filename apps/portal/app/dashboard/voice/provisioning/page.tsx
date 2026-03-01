"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

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

export default function VoiceProvisioningPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [webrtc, setWebrtc] = useState<WebrtcSettings | null>(null);
  const [routeViaSbc, setRouteViaSbc] = useState(false);
  const [routeSaving, setRouteSaving] = useState(false);
  const [form, setForm] = useState({ extensionNumber: "1001", displayName: "Front Desk", enableWebrtc: true, enableMobile: true });
  const [result, setResult] = useState("");
  const [mobileQrPayload, setMobileQrPayload] = useState<string>("");
  const [mobileQrExpiresAt, setMobileQrExpiresAt] = useState<number | null>(null);
  const [showLegacyNote, setShowLegacyNote] = useState(false);

  async function load() {
    const token = localStorage.getItem("token") || "";
    const [extRes, stRes, pjRes, wrRes] = await Promise.all([
      fetch(`${apiBase}/pbx/extensions`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/pbx/status`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/pending-jobs`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/webrtc/settings`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    setRows(await extRes.json());
    setStatus(await stRes.json());
    setPending(await pjRes.json());

    const wrJson = await wrRes.json().catch(() => null);
    if (wrRes.ok && wrJson) {
      setWebrtc(wrJson);
      setRouteViaSbc(!!wrJson.webrtcRouteViaSbc);
    }
  }

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!mobileQrExpiresAt) return;
    const timer = setInterval(() => {
      if (Date.now() >= mobileQrExpiresAt) {
        setMobileQrPayload("");
        setMobileQrExpiresAt(null);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [mobileQrExpiresAt]);

  const expiresIn = useMemo(() => {
    if (!mobileQrExpiresAt) return 0;
    return Math.max(0, Math.floor((mobileQrExpiresAt - Date.now()) / 1000));
  }, [mobileQrExpiresAt, mobileQrPayload]);

  async function saveRouteViaSbc() {
    const token = localStorage.getItem("token") || "";
    setRouteSaving(true);
    try {
      const out = await fetch(`${apiBase}/voice/webrtc/settings`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ webrtcRouteViaSbc: !!routeViaSbc })
      });
      const json = await out.json().catch(() => ({}));
      if (!out.ok) {
        setResult(JSON.stringify(json, null, 2));
        return;
      }
      await load();
    } finally {
      setRouteSaving(false);
    }
  }

  async function createExtension() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/pbx/extensions`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(form)
    });
    const json = await res.json();
    setResult(JSON.stringify(json, null, 2));
    await load();
  }

  async function generateMobileQr() {
    const token = localStorage.getItem("token") || "";
    const out = await fetch(`${apiBase}/voice/mobile-provisioning/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const json = await out.json().catch(() => ({}));
    if (!out.ok || !json?.token) {
      setResult(JSON.stringify(json, null, 2));
      return;
    }

    const payload = JSON.stringify({
      type: "MOBILE_PROVISIONING",
      token: json.token,
      apiBaseUrl: apiBase
    });
    setMobileQrPayload(payload);
    setMobileQrExpiresAt(Date.now() + 60_000);
    setShowLegacyNote(false);
  }

  async function generateLegacyMobileQr() {
    const token = localStorage.getItem("token") || "";
    const reset = await fetch(`${apiBase}/voice/me/reset-sip-password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const json = await reset.json().catch(() => ({}));
    if (!reset.ok || !json?.sipPassword || !json?.provisioning) {
      setResult(JSON.stringify(json, null, 2));
      return;
    }

    const payload = JSON.stringify({
      type: "mobile-provisioning",
      sipUsername: json.provisioning.sipUsername,
      sipPassword: json.sipPassword,
      sipWsUrl: json.provisioning.sipWsUrl,
      sipDomain: json.provisioning.sipDomain,
      outboundProxy: json.provisioning.outboundProxy,
      iceServers: json.provisioning.iceServers,
      dtmfMode: json.provisioning.dtmfMode
    });
    setMobileQrPayload(payload);
    setMobileQrExpiresAt(Date.now() + 60_000);
    setShowLegacyNote(true);
  }

  const qrUrl = mobileQrPayload
    ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(mobileQrPayload)}`
    : "";

  return (
    <div className="card">
      <h1>Voice Provisioning</h1>
      <p>PBX Link Status: <strong>{status?.status || "UNLINKED"}</strong></p>
      <p>Pending PBX jobs: {pending?.length || 0}</p>
      <p style={{ color: "#b45309" }}>Mobile networks often require TURN for reliable audio.</p>

      <h3>WebRTC Routing</h3>
      <label>
        <input type="checkbox" checked={routeViaSbc} onChange={(e) => setRouteViaSbc(e.target.checked)} />
        {" "}Route WebRTC via SBC (recommended)
      </label>
      <div style={{ marginTop: 8 }}>
        <button onClick={() => saveRouteViaSbc().catch(() => undefined)} disabled={routeSaving}>Save WebRTC Route</button>
        {" "}
        <button onClick={() => { window.location.href = "/dashboard/voice/sbc-test"; }}>Open SBC Test</button>
      </div>
      <p>
        Effective WSS: <strong>{webrtc?.effectiveSipWsUrl || "Set in Voice Settings"}</strong>
        {" "}/ Domain: <strong>{webrtc?.effectiveSipDomain || "Set in Voice Settings"}</strong>
      </p>

      <h3>Create Extension</h3>
      <input value={form.extensionNumber} onChange={(e) => setForm({ ...form, extensionNumber: e.target.value })} placeholder="Extension" />
      <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Display Name" />
      <label><input type="checkbox" checked={form.enableWebrtc} onChange={(e) => setForm({ ...form, enableWebrtc: e.target.checked })} /> Enable WebRTC</label>
      <label><input type="checkbox" checked={form.enableMobile} onChange={(e) => setForm({ ...form, enableMobile: e.target.checked })} /> Enable Mobile</label>
      <button onClick={createExtension}>Provision Extension</button>

      <h3>Mobile QR Onboarding</h3>
      <p>Default flow uses a short-lived single-use provisioning token. QR auto-hides after 60 seconds and contains no SIP password.</p>
      <button onClick={generateMobileQr}>Generate Tokenized Mobile QR</button>{" "}
      <button onClick={generateLegacyMobileQr}>Generate Legacy QR (Deprecated)</button>
      {showLegacyNote ? <p className="status-chip failed" style={{ borderRadius: 2 }}>Legacy QR includes plaintext SIP secret and will be removed after this grace release.</p> : null}
      {mobileQrPayload ? (
        <div className="card" style={{ maxWidth: 280 }}>
          <img src={qrUrl} alt="Mobile provisioning QR" width={240} height={240} />
          <p>Expires in: <strong>{expiresIn}s</strong></p>
        </div>
      ) : null}

      <h3>Provisioned Extensions</h3>
      <table>
        <thead><tr><th>Ext</th><th>Name</th><th>SIP User</th><th>Suspended</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.extension?.extNumber || "-"}</td>
              <td>{r.extension?.displayName || "-"}</td>
              <td>{r.pbxSipUsername}</td>
              <td>{r.isSuspended ? "YES" : "NO"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {result ? <pre>{result}</pre> : null}
    </div>
  );
}