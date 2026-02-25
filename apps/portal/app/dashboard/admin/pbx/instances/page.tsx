"use client";

import { useEffect, useState } from "react";

const apiBase = process.env.NEXT_PUBLIC_API_URL || "https://app.connectcomunications.com/api";

function readRole(): string {
  const token = localStorage.getItem("token");
  if (!token) return "";
  try {
    return JSON.parse(atob(token.split(".")[1])).role || "";
  } catch {
    return "";
  }
}

export default function AdminPbxInstancesPage() {
  const [role, setRole] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [form, setForm] = useState({ name: "Primary PBX", baseUrl: "https://pbx.example.com", token: "", secret: "", isEnabled: true });
  const [message, setMessage] = useState("");

  async function load() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/instances`, { headers: { Authorization: `Bearer ${token}` } });
    setRows(await res.json());
  }

  useEffect(() => {
    const r = readRole();
    setRole(r);
    if (r === "SUPER_ADMIN") load().catch(() => undefined);
  }, []);

  async function createInstance() {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/instances`, {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(form)
    });
    setMessage(JSON.stringify(await res.json(), null, 2));
    await load();
  }

  async function testInstance(id: string) {
    const token = localStorage.getItem("token") || "";
    const res = await fetch(`${apiBase}/admin/pbx/instances/${id}/test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    setMessage(JSON.stringify(await res.json(), null, 2));
  }

  if (role !== "SUPER_ADMIN") return <div className="card"><h1>PBX Instances</h1><p>Insufficient permissions.</p></div>;

  return (
    <div className="card">
      <h1>Admin PBX Instances</h1>
      <p>Create and manage WirePBX/VitalPBX API connectors. Credentials are encrypted at rest.</p>
      <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" />
      <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="Base URL" />
      <input value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder="API Token" />
      <input value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} placeholder="API Secret (optional)" />
      <label><input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} /> Enabled</label>
      <button onClick={createInstance}>Create PBX Instance</button>

      <table>
        <thead><tr><th>Name</th><th>Base URL</th><th>Enabled</th><th>Actions</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.baseUrl}</td>
              <td>{r.isEnabled ? "YES" : "NO"}</td>
              <td><button onClick={() => testInstance(r.id)}>Test</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {message ? <pre>{message}</pre> : null}
    </div>
  );
}
