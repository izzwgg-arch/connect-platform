"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

export default function VoiceProvisioningPage() {
  const [rows, setRows] = useState<any[]>([]);
  const [status, setStatus] = useState<any>(null);
  const [pending, setPending] = useState<any[]>([]);
  const [form, setForm] = useState({ extensionNumber: "1001", displayName: "Front Desk", enableWebrtc: true, enableMobile: true });
  const [result, setResult] = useState("");

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
