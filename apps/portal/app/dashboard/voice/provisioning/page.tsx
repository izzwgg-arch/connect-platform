"use client";

import { useEffect, useMemo, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function VoiceProvisioningPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [form, setForm] = useState({ extensionNumber: "1001", displayName: "Front Desk", enableWebrtc: true, enableMobile: true });
  const [result, setResult] = useState("");
  const [mobileQrPayload, setMobileQrPayload] = useState<string>("");
  const [mobileQrExpiresAt, setMobileQrExpiresAt] = useState<number | null>(null);

  async function load() {
    const token = localStorage.getItem("token") || "";
    const [extRes, stRes, pjRes] = await Promise.all([
      fetch(`${apiBase}/pbx/extensions`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/pbx/status`, { headers: { Authorization: `Bearer ${token}` } }),
      fetch(`${apiBase}/voice/pending-jobs`, { headers: { Authorization: `Bearer ${token}` } })
    ]);
    setRows(await extRes.json());
    setStatus(await stRes.json());
    setPending(await pjRes.json());
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
    const reset = await fetch(`${apiBase}/voice/me/reset-sip-password`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({})
    });
    const json = await reset.json();
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
  }

  const qrUrl = mobileQrPayload
    ? `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(mobileQrPayload)}`
    : "";

  return (
    <div className="card">
      <h1>Voice Provisioning</h1>
      <p>PBX Link Status: <strong>{status?.status || "UNLINKED"}</strong></p>
      <p>Pending PBX jobs: {pending?.length || 0}</p>

      <h3>Create Extension</h3>
      <input value={form.extensionNumber} onChange={(e) => setForm({ ...form, extensionNumber: e.target.value })} placeholder="Extension" />
      <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Display Name" />
      <label><input type="checkbox" checked={form.enableWebrtc} onChange={(e) => setForm({ ...form, enableWebrtc: e.target.checked })} /> Enable WebRTC</label>
      <label><input type="checkbox" checked={form.enableMobile} onChange={(e) => setForm({ ...form, enableMobile: e.target.checked })} /> Enable Mobile</label>
      <button onClick={createExtension}>Provision Extension</button>

      <h3>Mobile QR Onboarding</h3>
      <p>Generates a one-time SIP credential payload for the mobile app. QR auto-hides after 60 seconds.</p>
      <button onClick={generateMobileQr}>Generate One-Time Mobile QR</button>
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
